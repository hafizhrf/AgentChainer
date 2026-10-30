import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Catalog, Item } from "../catalog/schema.ts";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import { type ApplyContext, applyActions, listRuns, pluginVersion, rollback } from "./apply.ts";
import { fakeCli } from "./fake-cli.ts";
import { type FetchTree, treeHash } from "./git-source.ts";
import { installedItems, type PlanEnv } from "./plan.ts";
import { systemTar } from "./tools.ts";

/** Installer and rollback runs on temp copies of the fixture repos (M2-28). No network, no real CLI. */
after(removeFixtureCopies);

const env: PlanEnv = {
  platform: "linux",
  arch: "x64",
  hasTool: () => true,
  remoteHost: null,
  enabledPlugins: new Set(),
  toolsDir: null,
  installedItems: new Set(),
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
const review = [{ by: "maintainer", date: "2026-10-29", ref: "test" }];

const pluginItem: Item = {
  id: "demo",
  name: "Demo plugin",
  kind: "plugin",
  tier: "official",
  license: "MIT",
  summary: "s",
  why: "w",
  source: {
    type: "marketplace",
    marketplace: "mkt",
    repo: "o/mkt",
    plugin: "demo",
    reviewedVersion: "1.0.1",
    reviewedRef: "a".repeat(40),
  },
  platforms: ["darwin", "linux", "win32"],
  requires: [],
  risk: "low",
  permissions: [],
  secrets: [],
  install: { scope: "project", steps: [{ run: ["claude", "plugin", "install", "demo@mkt"] }] },
  uninstall: { steps: [{ run: ["claude", "plugin", "uninstall", "demo@mkt"] }] },
  reviews: review,
};

const catalogOf = (items: Item[]): Catalog => ({
  version: "2026.10.29",
  items,
  profiles: [{ id: "base", name: "Base", description: "d", suggest: { always: true }, items: items.map((i) => i.id) }],
});

const ctx = (root: string, over: Partial<ApplyContext> = {}): ApplyContext => ({
  catalog: catalogOf([]),
  env,
  cli: fakeCli(root),
  now: () => new Date("2026-10-29T08:00:00Z"),
  ...over,
});

describe("apply and roll back fixes", () => {
  it("applies the .gitignore and .env fixes, then a full rollback leaves git status clean and files byte-identical", async () => {
    const dir = copyFixture("legacy-messy");
    const gitignore = read(dir, ".gitignore");
    const { runId, results } = await applyActions(dir, ["fix:fix-gitignore", "fix:untrack-env"], ctx(dir));
    assert.deepEqual(
      results.map((r) => [r.id, r.status]),
      [
        ["fix:untrack-env", "applied"],
        ["fix:fix-gitignore", "applied"],
      ],
    );
    assert.match(read(dir, ".gitignore"), /^\.env$/m);
    assert.equal(git(dir, "ls-files", ".env").trim(), "", ".env is no longer tracked");
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.deepEqual(
      lock.fixes.map((f: { id: string }) => f.id),
      ["untrack-env", "fix-gitignore"],
    );
    assert.equal(read(dir, ".agentchainer/.gitignore"), "backups/\nprofile.json\nlocal.json\n");

    // Idempotent: the fixed findings are gone, so a re-run applies nothing.
    const again = await applyActions(dir, ["fix:fix-gitignore"], ctx(dir));
    assert.equal(again.results[0]?.status, "skipped");

    assert.deepEqual(
      rollback(dir, runId, ctx(dir)).map((r) => r.status),
      ["rolled-back", "rolled-back"],
    );
    assert.equal(read(dir, ".gitignore"), gitignore);
    assert.equal(git(dir, "ls-files", ".env").trim(), ".env");
    assert.equal(git(dir, "status", "--porcelain"), "", "no trace of the run");
    assert.equal(existsSync(join(dir, ".agentchainer")), false);
  });

  it("won't overwrite a file edited after the run, unless forced", async () => {
    const dir = copyFixture("legacy-messy");
    const original = read(dir, ".gitignore");
    const { runId } = await applyActions(dir, ["fix:fix-gitignore"], ctx(dir));
    writeFileSync(join(dir, ".gitignore"), `${read(dir, ".gitignore")}my-own-line\n`);
    const [res] = rollback(dir, runId, ctx(dir));
    assert.equal(res?.status, "conflict");
    assert.match(read(dir, ".gitignore"), /my-own-line/, "the user's edit is kept");
    assert.equal(rollback(dir, runId, ctx(dir), { force: true })[0]?.status, "rolled-back");
    assert.equal(read(dir, ".gitignore"), original);
  });

  it("installs the task roles into .claude/agents/, and rolls them back", async () => {
    const dir = copyFixture("sample-app");
    const { runId, results } = await applyActions(dir, ["fix:install-agents"], ctx(dir));
    assert.equal(results[0]?.status, "applied");
    const implementer = read(dir, ".claude/agents/ac-implementer.md");
    assert.match(implementer, /^---\nname: ac-implementer\n/);
    assert.equal(read(dir, ".claude/agents/ac-independent-reviewer.md").includes("model: opus"), true);
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.ok(lock.fixes.some((f: { id: string }) => f.id === "install-agents"));
    // Installed and unchanged: the plan doesn't offer it again.
    const again = await applyActions(dir, ["fix:install-agents"], ctx(dir));
    assert.equal(again.results[0]?.status, "skipped");
    rollback(dir, runId, ctx(dir));
    assert.equal(existsSync(join(dir, ".claude", "agents")), false);
  });

  it("initializes git in an empty folder, and removes it again while it has no commits", async () => {
    const dir = copyFixture("empty");
    const { runId, results } = await applyActions(dir, ["fix:git-init"], ctx(dir));
    assert.equal(results[0]?.status, "applied");
    assert.ok(existsSync(join(dir, ".git")));
    rollback(dir, runId, ctx(dir));
    assert.equal(existsSync(join(dir, ".git")), false);
  });
});

describe("apply catalog items", () => {
  it("installs a reviewed plugin through the CLI, records its version, warns on drift, and rolls back", async () => {
    const dir = copyFixture("ts-pnpm-vite");
    const cli = fakeCli(dir, { version: "1.0.2" });
    const c = ctx(dir, { catalog: catalogOf([pluginItem]), cli });
    const { runId, results } = await applyActions(dir, ["item:demo"], c);
    assert.equal(results[0]?.status, "applied");
    assert.match(results[0]?.warnings[0] ?? "", /Installed 1\.0\.2, but 1\.0\.1 was reviewed/);
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.deepEqual([lock.items[0].id, lock.items[0].version, lock.items[0].scope], ["demo", "1.0.2", "project"]);
    assert.deepEqual(
      rollback(dir, runId, c).map((r) => r.status),
      ["rolled-back"],
    );
    assert.deepEqual(cli.calls, ["install demo@mkt", "uninstall demo@mkt"]);
    assert.equal(existsSync(join(dir, ".claude", "settings.json")), false, "settings.json didn't exist before");
    assert.equal(git(dir, "status", "--porcelain"), "");
  });

  it("refuses unreviewed items and fails clearly when the marketplace isn't set up", async () => {
    const dir = copyFixture("ts-pnpm-vite");
    const unreviewed = await applyActions(
      dir,
      ["item:demo"],
      ctx(dir, { catalog: catalogOf([{ ...pluginItem, reviews: [] }]) }),
    );
    assert.match(unreviewed.results[0]?.message ?? "", /Not reviewed yet/);
    const noMarket = await applyActions(
      dir,
      ["item:demo"],
      ctx(dir, { catalog: catalogOf([pluginItem]), cli: fakeCli(dir, { marketplaces: [] }) }),
    );
    assert.equal(noMarket.results[0]?.status, "failed");
    assert.match(noMarket.results[0]?.message ?? "", /claude plugin marketplace add o\/mkt/);
    assert.equal(existsSync(join(dir, ".claude")), false, "nothing left behind");
    assert.equal(listRuns(dir).length, 0);
  });

  it("copies a pinned git source only when its tree hash matches", async () => {
    const src = mkdtempSync(join(tmpdir(), "ac-skill-"));
    mkdirSync(join(src, "skill", "refs"), { recursive: true });
    writeFileSync(join(src, "skill", "SKILL.md"), "---\nname: demo\n---\nDo things.\n");
    writeFileSync(join(src, "skill", "refs", "a.md"), "ref\n");
    const fetchTree: FetchTree = async () => {
      const copy = mkdtempSync(join(tmpdir(), "ac-fetched-"));
      cpSync(join(src, "skill"), copy, { recursive: true });
      return { dir: copy, cleanup: () => rmSync(copy, { recursive: true, force: true }) };
    };
    const skill = (sha256: string): Item => ({
      ...pluginItem,
      id: "demo-skill",
      kind: "skill",
      tier: "verified-vendor",
      source: { type: "git", repo: "https://github.com/o/skill", ref: "b".repeat(40), path: "skill", sha256 },
      install: { scope: "project", steps: [{ copy: { from: ".", to: ".claude/skills/demo" } }] },
      uninstall: { steps: [{ remove: ".claude/skills/demo" }] },
    });
    try {
      const dir = copyFixture("go-service");
      const bad = await applyActions(
        dir,
        ["item:demo-skill"],
        ctx(dir, { catalog: catalogOf([skill("0".repeat(64))]), fetchTree }),
      );
      assert.match(bad.results[0]?.message ?? "", /Hash mismatch/);
      assert.equal(existsSync(join(dir, ".claude")), false);

      const good = catalogOf([skill(treeHash(join(src, "skill")))]);
      const { runId, results } = await applyActions(dir, ["item:demo-skill"], ctx(dir, { catalog: good, fetchTree }));
      assert.equal(results[0]?.status, "applied");
      assert.equal(read(dir, ".claude/skills/demo/refs/a.md"), "ref\n");
      assert.deepEqual(JSON.parse(read(dir, ".agentchainer/lock.json")).items[0].files, [
        ".claude/skills/demo/SKILL.md",
        ".claude/skills/demo/refs/a.md",
      ]);
      rollback(dir, runId, ctx(dir));
      assert.equal(existsSync(join(dir, ".claude")), false, "copied files and their folders are gone");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("restores a file several actions of one run changed, byte for byte (found by the M2 exit test)", async () => {
    const dir = copyFixture("ts-pnpm-vite");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const settings = '{\n  "permissions": { "allow": ["Read"] }\n}\n';
    writeFileSync(join(dir, ".claude", "settings.json"), settings);
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "settings");
    const second: Item = {
      ...pluginItem,
      id: "demo-two",
      source: { ...pluginItem.source, plugin: "demo-two" } as Item["source"],
    };
    const c = ctx(dir, { catalog: catalogOf([pluginItem, second]) });
    const { runId, results } = await applyActions(dir, ["item:demo", "item:demo-two"], c);
    assert.deepEqual(
      results.map((r) => r.status),
      ["applied", "applied"],
    );
    assert.deepEqual(
      rollback(dir, runId, c).map((r) => r.status),
      ["rolled-back", "rolled-back"],
    );
    assert.equal(read(dir, ".claude/settings.json"), settings);
    assert.equal(git(dir, "status", "--porcelain"), "");
  });

  it("rolls back one action and keeps the rest of the run in the lockfile", async () => {
    const dir = copyFixture("legacy-messy");
    const c = ctx(dir, { catalog: catalogOf([pluginItem]) });
    const { runId } = await applyActions(dir, ["fix:fix-gitignore", "item:demo"], c);
    assert.deepEqual(
      rollback(dir, runId, c, { actionId: "item:demo" }).map((r) => r.status),
      ["rolled-back"],
    );
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.deepEqual([lock.items.length, lock.fixes.map((f: { id: string }) => f.id)], [0, ["fix-gitignore"]]);
    const [run] = listRuns(dir);
    assert.deepEqual(
      run?.actions.map((a) => [a.id, a.status]),
      [
        ["fix:fix-gitignore", "applied"],
        ["item:demo", "rolled-back"],
      ],
    );
  });
});

describe("pluginVersion", () => {
  it("finds the version in the CLI's list output shapes", () => {
    assert.equal(pluginVersion([{ id: "x@m", version: "1.2.3" }], "x@m"), "1.2.3");
    assert.equal(pluginVersion({ plugins: [{ name: "x", marketplace: "m", version: "2.0.0" }] }, "x@m"), "2.0.0");
    assert.equal(pluginVersion(null, "x@m"), undefined);
  });
});

describe("forged run records", () => {
  it("refuses to roll back, and doesn't list, a run.json that points outside the workspace", () => {
    const dir = copyFixture("go-service");
    const outside = join(dir, "..", `ac-forged-${Date.now()}.txt`);
    const runDir = join(dir, ".agentchainer", "backups", "2026-10-29T00-00-00-000Z-forged");
    mkdirSync(join(runDir, "files"), { recursive: true });
    writeFileSync(join(runDir, "files", "payload"), "echo pwned\n");
    const forged = {
      runId: "2026-10-29T00-00-00-000Z-forged",
      startedAt: "2026-10-29T00:00:00.000Z",
      catalogVersion: "x",
      meta: [],
      actions: [
        {
          id: "fix:fix-gitignore",
          title: "Ignore env files",
          status: "applied",
          warnings: [],
          undo: [],
          files: [
            { path: `../${outside.split(/[\\/]/).at(-1)}`, existed: true, backup: "files/payload", afterSha256: null },
          ],
        },
      ],
    };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(forged));
    assert.throws(() => rollback(dir, forged.runId, { cli: null }), /wasn't recorded by AgentChainer/);
    assert.ok(!existsSync(outside), "nothing written outside the workspace");
    assert.deepEqual(listRuns(dir), [], "the forged run isn't listed");
  });
});

describe("release binaries, MCP servers and hooks (M2-15)", () => {
  const work = mkdtempSync(join(tmpdir(), "ac-apply-tools-"));
  after(() => rmSync(work, { recursive: true, force: true }));

  // A release archive with a stand-in binary, served by a fake fetch.
  const exe = process.platform === "win32" ? "fake-scan.exe" : "fake-scan";
  mkdirSync(join(work, "pkg"), { recursive: true });
  writeFileSync(join(work, "pkg", exe), "#!/bin/sh\nexit 0\n");
  execFileSync(systemTar(), ["-czf", join(work, "fake.tar.gz"), "-C", join(work, "pkg"), exe]);
  const archive = readFileSync(join(work, "fake.tar.gz"));
  const fetchAsset = (async () => new Response(new Uint8Array(archive))) as unknown as typeof fetch;
  const key = `${process.platform}-${process.arch}` as "linux-x64";
  const sha256 = createHash("sha256").update(archive).digest("hex");
  const toolEnv: PlanEnv = { ...env, platform: process.platform, arch: process.arch, toolsDir: join(work, "tools") };

  const binaryItem = (over: Partial<Item>): Item => ({
    ...pluginItem,
    id: "fake-scan",
    name: "Fake scan",
    kind: "hook",
    tier: "verified-vendor",
    source: {
      type: "release-asset",
      repo: "https://example.com/fake",
      version: "1.0.0",
      assets: { [key]: { url: "https://example.com/fake.tar.gz", sha256 } },
    },
    install: {
      scope: "project",
      steps: [
        { "download-binary": { binary: "fake-scan" } },
        { "pre-commit-hook": { id: "fake-scan", run: ["{binary}", "--staged"] } },
      ],
    },
    ...over,
  });
  const status = (dir: string) => git(dir, "status", "--porcelain");

  it("downloads a checked binary, adds a local pre-commit hook, records it privately, and rolls back cleanly", async () => {
    const dir = copyFixture("go-service");
    const item = binaryItem({});
    const c = ctx(dir, { catalog: catalogOf([item]), env: toolEnv, fetchAsset });
    const { runId, results } = await applyActions(dir, ["item:fake-scan"], c);
    assert.deepEqual(
      results.map((r) => [r.id, r.status, r.message]),
      [["item:fake-scan", "applied", undefined]],
    );
    const hook = read(dir, ".git/hooks/pre-commit");
    assert.match(hook, /# Added by AgentChainer/);
    assert.ok(hook.includes(join(work, "tools", "fake-scan", "1.0.0", exe).replaceAll("\\", "/")));
    const local = JSON.parse(read(dir, ".agentchainer/local.json"));
    assert.deepEqual(
      local.items.map((i: { id: string; scope: string; archiveSha256: string }) => [i.id, i.scope, i.archiveSha256]),
      [["fake-scan", "local", sha256]],
    );
    assert.ok(!existsSync(join(dir, ".agentchainer/lock.json")), "local items leave the committed lockfile alone");
    assert.equal(read(dir, ".agentchainer/.gitignore"), "backups/\nprofile.json\nlocal.json\n");

    // Re-planning sees it as installed (the real env reads the lockfiles).
    const again = await applyActions(dir, ["item:fake-scan"], {
      ...c,
      env: { ...toolEnv, installedItems: installedItems(dir) },
    });
    assert.match(again.results[0]?.message ?? "", /installed/);

    assert.deepEqual(
      rollback(dir, runId, c).map((r) => r.status),
      ["rolled-back"],
    );
    assert.ok(!existsSync(join(dir, ".git/hooks/pre-commit")));
    assert.ok(!existsSync(join(dir, ".agentchainer")));
    assert.equal(status(dir), "");
    assert.ok(
      existsSync(join(work, "tools", "fake-scan", "1.0.0", exe)),
      "the binary stays in the shared tools folder",
    );
  });

  it("adds the hook to the repo's lefthook config and a committed wrapper script", async () => {
    const dir = copyFixture("go-service");
    writeFileSync(join(dir, "lefthook.yml"), "# hooks\npre-commit:\n  commands:\n    vet:\n      run: go vet ./...\n");
    git(dir, "add", "lefthook.yml");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "lefthook");
    const before = read(dir, "lefthook.yml");
    const c = ctx(dir, { catalog: catalogOf([binaryItem({})]), env: toolEnv, fetchAsset });
    const { runId } = await applyActions(dir, ["item:fake-scan"], c);
    assert.match(read(dir, "lefthook.yml"), /fake-scan:\n\s+run: sh \.agentchainer\/hooks\/fake-scan\.sh/);
    assert.match(read(dir, ".agentchainer/hooks/fake-scan.sh"), /exec "\$bin" --staged/);
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.deepEqual(
      lock.items.map((i: { id: string; scope: string; files: string[] }) => [i.id, i.scope, i.files]),
      [["fake-scan", "project", [".agentchainer/hooks/fake-scan.sh", "lefthook.yml"]]],
    );
    rollback(dir, runId, c);
    assert.equal(read(dir, "lefthook.yml"), before);
    assert.equal(status(dir), "");
  });

  it("registers a downloaded MCP server privately and removes it on rollback", async () => {
    const dir = copyFixture("go-service");
    const cli = fakeCli(dir);
    const item = binaryItem({
      id: "fake-mcp",
      kind: "mcp",
      install: {
        scope: "local",
        steps: [
          { "download-binary": { binary: "fake-scan" } },
          { "mcp-add": { name: "fake", command: ["{binary}", "serve"] } },
        ],
      },
    });
    const c = ctx(dir, { catalog: catalogOf([item]), env: toolEnv, fetchAsset, cli });
    const { runId, results } = await applyActions(dir, ["item:fake-mcp"], c);
    assert.equal(results[0]?.status, "applied");
    assert.deepEqual(cli.calls, [`mcp add local fake ${join(work, "tools", "fake-mcp", "1.0.0", exe)} serve`]);
    rollback(dir, runId, c);
    assert.deepEqual(cli.calls.at(-1), "mcp remove local fake");
    assert.equal(status(dir), "");
  });

  it("merges a pinned npx server into .mcp.json, keeping what's there, and restores it byte for byte", async () => {
    const dir = copyFixture("go-service");
    const before = '{\n  "mcpServers": { "docs": { "type": "http", "url": "https://example.com/mcp" } }\n}\n';
    writeFileSync(join(dir, ".mcp.json"), before);
    git(dir, "add", ".mcp.json");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "mcp");
    const item: Item = {
      ...pluginItem,
      id: "fake-npx",
      kind: "mcp",
      tier: "verified-vendor",
      source: { type: "npm", name: "@example/mcp", version: "1.2.3", integrity: "sha512-x" },
      install: {
        scope: "project",
        steps: [
          {
            "merge-json": {
              path: ".mcp.json",
              value: { mcpServers: { example: { command: "npx", args: ["-y", "@example/mcp@1.2.3"] } } },
            },
          },
        ],
      },
    };
    const c = ctx(dir, { catalog: catalogOf([item]), env: toolEnv });
    const { runId } = await applyActions(dir, ["item:fake-npx"], c);
    assert.deepEqual(Object.keys(JSON.parse(read(dir, ".mcp.json")).mcpServers), ["docs", "example"]);
    rollback(dir, runId, c);
    assert.equal(read(dir, ".mcp.json"), before);
    assert.equal(status(dir), "");
  });
});
