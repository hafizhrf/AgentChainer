import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { STOP_COMMAND, STOP_SCRIPT, stopHookFiles, stopHookScript } from "./stop-hook.ts";

/** The optional Stop hook that runs the tests (M2-22). */

const work = mkdtempSync(join(tmpdir(), "ac-stop-hook-"));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const folder = (files: Record<string, string> = {}) => {
  const dir = join(work, `w${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("stopHookFiles", () => {
  it("adds a Stop entry and keeps existing settings and hooks", () => {
    const before = JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }], PostToolUse: [] },
    });
    const files = stopHookFiles(folder({ ".claude/settings.json": before }), { dir: ".", run: "npm test" });
    const settings = JSON.parse(files?.[0]?.after ?? "");
    assert.deepEqual(settings.permissions, { allow: ["Read"] });
    assert.deepEqual(settings.hooks.PostToolUse, []);
    assert.equal(settings.hooks.Stop.length, 2);
    assert.deepEqual(settings.hooks.Stop[1], { hooks: [{ type: "command", command: STOP_COMMAND, timeout: 300 }] });
    assert.equal(files?.[1]?.path, STOP_SCRIPT);
    assert.equal(files?.[1]?.executable, true);
  });

  it("offers nothing when the settings aren't valid JSON or already run the script", () => {
    assert.equal(stopHookFiles(folder({ ".claude/settings.json": "{ oops" }), { dir: ".", run: "npm test" }), null);
    const done = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: STOP_COMMAND }] }] } });
    assert.equal(stopHookFiles(folder({ ".claude/settings.json": done }), { dir: ".", run: "npm test" }), null);
  });
});

describe("the hook script", { skip: process.platform === "win32" ? "runs through Git Bash on Windows" : false }, () => {
  const run = (dir: string, input: string, command: string, sub = ".") => {
    writeFileSync(join(dir, "hook.sh"), stopHookScript({ dir: sub, run: command }));
    return spawnSync("sh", ["hook.sh"], {
      cwd: dir,
      input,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: "utf8",
    });
  };

  it("exits 0 when the tests pass and 2 with the failures when they don't", () => {
    const dir = folder();
    assert.equal(run(dir, "{}", "true").status, 0);
    const failed = run(dir, "{}", "echo 'expected 1, got 2'; exit 1");
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /The tests fail/);
    assert.match(failed.stderr, /expected 1, got 2/);
  });

  it("doesn't loop: with stop_hook_active it exits 0 without running the tests", () => {
    const dir = folder();
    const r = run(dir, '{"session_id":"x","stop_hook_active":true}', "echo ran >&2; exit 1");
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  });

  it("runs in the package folder of a monorepo package", () => {
    const dir = folder({ "packages/app/marker": "" });
    assert.equal(run(dir, "{}", "test -f marker", "packages/app").status, 0);
  });
});

describe("applying the fix", {
  skip: process.platform === "win32" ? "runs through Git Bash on Windows" : false,
}, () => {
  it("is offered unselected, writes the hook, verifies it, and rolls back", async () => {
    const { applyActions, rollback } = await import("./apply.ts");
    const { buildPlan } = await import("./plan.ts");
    const { detectWorkspace } = await import("../detect/detect.ts");
    const { auditWorkspace } = await import("../detect/audit.ts");
    const dir = folder({
      "package.json": JSON.stringify({ name: "demo", scripts: { test: 'node -e "process.exit(0)"' } }),
    });
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.x", ...a], { cwd: dir });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    const env = {
      platform: process.platform,
      arch: process.arch,
      hasTool: () => true,
      remoteHost: null,
      enabledPlugins: new Set<string>(),
      toolsDir: null,
      installedItems: new Set<string>(),
    };
    const catalog = { version: "2026.10.29", items: [], profiles: [] };
    const profile = detectWorkspace(dir);
    const action = buildPlan(dir, profile, auditWorkspace(dir, profile), catalog, env).actions.find(
      (a) => a.id === "fix:stop-tests",
    );
    assert.equal(action?.selected, false, "optional: not pre-selected");
    const { runId, results } = await applyActions(dir, ["fix:stop-tests"], { catalog, env, cli: null });
    assert.equal(results[0]?.status, "applied");
    assert.equal(results[0]?.checks?.[0]?.status, "pass");
    rollback(dir, runId, { cli: null });
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
  });
});
