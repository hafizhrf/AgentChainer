import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { WorkspaceProfile } from "@agentchainer/protocol";
import { passed, resolveGates, runGates, smokeCommand } from "./gates.ts";

const cmd = (run: string) => ({ run, source: "test", confidence: "high" as const });

function profile(packages: { path: string; commands: Record<string, string> }[]): WorkspaceProfile {
  return {
    stacks: ["node"],
    monorepo: packages.length > 1 ? "pnpm-workspace" : null,
    packages: packages.map((p) => ({
      path: p.path,
      stack: "node",
      packageManager: "pnpm",
      frameworks: [],
      testFrameworks: [],
      commands: Object.fromEntries(Object.entries(p.commands).map(([k, v]) => [k, cmd(v)])),
    })),
    ci: [],
  };
}

describe("gates", () => {
  let root = "";
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ac-gates-")));
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root });
    mkdirSync(join(root, "packages", "ui"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "messy  \n");
    writeFileSync(join(root, "keep.txt"), "keep\n");
    g("init", "-q", "-b", "main");
    // Exact bytes when the guard restores a file, on Windows too.
    g("config", "core.autocrlf", "false");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("runs a root command once, and each package's own otherwise, in the order asked", () => {
    const p = profile([
      { path: ".", commands: { test: "pnpm -r test", lint: "biome check" } },
      { path: "packages/ui", commands: { test: "vitest", typecheck: "tsc" } },
      { path: "packages/core", commands: { typecheck: "tsc -b" } },
    ]);
    const gates = resolveGates(root, p, ["lint", "typecheck", "test", "build"]);
    assert.deepEqual(
      gates.map((g) => `${g.kind}:${g.package}:${g.command}`),
      ["lint:.:biome check", "typecheck:packages/ui:tsc", "typecheck:packages/core:tsc -b", "test:.:pnpm -r test"],
    );
    assert.equal(gates[1]?.cwd, join(root, "packages", "ui"));
  });

  it("finds the smoke script", () => {
    assert.equal(smokeCommand(root), null);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "smoke.mjs"), "process.exit(0)\n");
    assert.equal(smokeCommand(root), "node scripts/smoke.mjs");
    rmSync(join(root, "scripts"), { recursive: true });
  });

  it("records real exit codes, runs every gate after a failure, keeps format's changes and reverts a check's", async () => {
    // node -e: the same in sh and cmd.
    const node = (js: string) => `node -e "${js}"`;
    const gates = [
      // A formatter: rewrites a.txt.
      {
        kind: "format" as const,
        command: node("require('fs').writeFileSync('a.txt','clean\\n')"),
        package: ".",
        cwd: root,
      },
      // A check that fails and dirties keep.txt on the way: the change must be reverted.
      {
        kind: "lint" as const,
        command: node(
          "require('fs').appendFileSync('keep.txt','dirty\\n');console.log('lint: 2 problems');process.exit(1)",
        ),
        package: ".",
        cwd: root,
      },
      { kind: "test" as const, command: node("console.log('tests ok')"), package: ".", cwd: root },
    ];
    const runs = await runGates(root, gates, 0);
    assert.deepEqual(
      runs.map((r) => [r.kind, r.exitCode]),
      [
        ["format", 0],
        ["lint", 1],
        ["test", 0],
      ],
    );
    assert.deepEqual(runs[0]?.changed, ["a.txt"]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "clean\n", "format's change stays");
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "keep\n", "the check's change is reverted");
    assert.deepEqual(runs[1]?.changed, ["keep.txt"]);
    assert.match(runs[1]?.tail ?? "", /lint: 2 problems/);
    assert.equal(passed(runs), false);
    assert.equal(passed(runs.filter((r) => r.exitCode === 0)), true);
  });

  it("stops when aborted", async () => {
    const abort = new AbortController();
    const started = Date.now();
    // `&&` makes every shell run node as a child rather than replacing itself with it: stopping must reach the child.
    const command = `node -e "setTimeout(() => {}, 30000)" && node -e "0"`;
    const pending = runGates(root, [{ kind: "test", command, package: ".", cwd: root }], 0, abort.signal);
    setTimeout(() => abort.abort(), 200);
    const runs = await pending;
    assert.ok(Date.now() - started < 10_000);
    assert.notEqual(runs[0]?.exitCode, 0);
  });
});
