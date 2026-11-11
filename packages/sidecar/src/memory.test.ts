import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listRuns, rollback } from "./bootstrap/apply.ts";
import { fakeCli } from "./bootstrap/fake-cli.ts";
import { memoryFiles, memoryWarnings, readMemory, saveMemory, scanMemory, scanProject } from "./memory.ts";

// CP-03: the CLAUDE.md editor and the scan across projects, on throwaway workspaces.

const roots: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A git repository with `files`; untracked files are listed too, ignored ones aren't. */
function workspace(files: Record<string, string> = {}) {
  const root = temp("ac-memory-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split("/")), text);
  }
  return root;
}

describe("CLAUDE.md files in a workspace (CP-03)", () => {
  it("lists the project's, the personal one, the folders' and the user's own", () => {
    const config = temp("ac-config-");
    writeFileSync(join(config, "CLAUDE.md"), "# Mine\n");
    const root = workspace({
      "CLAUDE.md": "# Project\nRun `npm test`.\n",
      "CLAUDE.local.md": "# Just me\n",
      "packages/api/CLAUDE.md": "# API\n",
      "node_modules/x/CLAUDE.md": "# not ours\n",
      ".gitignore": "node_modules/\n",
    });
    const files = memoryFiles(root, config);
    assert.deepEqual(
      files.map((f) => [f.kind, f.path, f.exists, f.lines]),
      [
        ["project", "CLAUDE.md", true, 3],
        ["local", "CLAUDE.local.md", true, 2],
        ["folder", "packages/api/CLAUDE.md", true, 2],
        ["user", join(config, "CLAUDE.md"), true, 2],
      ],
    );
  });

  it("offers a missing CLAUDE.md to start, and uses .claude/CLAUDE.md when that's the one", () => {
    const config = temp("ac-config-");
    assert.deepEqual(
      memoryFiles(workspace(), config).map((f) => [f.path, f.exists]),
      [
        ["CLAUDE.md", false],
        [join(config, "CLAUDE.md"), false],
      ],
    );
    const alt = workspace({ ".claude/CLAUDE.md": "# Here\n" });
    assert.equal(memoryFiles(alt, config)[0]?.path, ".claude/CLAUDE.md");
  });

  it("won't open a CLAUDE.md that's a link", () => {
    const outside = temp("ac-outside-");
    writeFileSync(join(outside, "secret.txt"), "not yours\n");
    const root = workspace();
    symlinkSync(join(outside, "secret.txt"), join(root, "CLAUDE.md"));
    const [f] = memoryFiles(root, temp("ac-config-"));
    assert.equal(f?.exists, true);
    assert.match(f?.refused ?? "", /is a link/);
    assert.throws(() => readMemory(root, { path: "CLAUDE.md" }), /is a link/);
    assert.throws(() => saveMemory(root, "CLAUDE.md", "x", null, "test"), /is a link/);
  });

  it("reads a file with its sha256, and a missing one as empty", () => {
    const root = workspace({ "CLAUDE.md": "# Hi\n" });
    const r = readMemory(root, { path: "CLAUDE.md" });
    assert.equal(r.text, "# Hi\n");
    assert.match(r.sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(readMemory(root, { path: "CLAUDE.local.md" }), { text: "", sha256: null });
    const config = temp("ac-config-");
    writeFileSync(join(config, "CLAUDE.md"), "# Mine\n");
    assert.equal(readMemory(root, { user: true }, config).text, "# Mine\n");
  });
});

describe("saving a CLAUDE.md", () => {
  it("is a History run that Roll back undoes, byte for byte", () => {
    const root = workspace({ "CLAUDE.md": "# Before\r\n" });
    const { sha256 } = readMemory(root, { path: "CLAUDE.md" });
    const saved = saveMemory(root, "CLAUDE.md", "# After\n", sha256, "test");
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# After\n");
    assert.deepEqual(saved.warnings, []);
    assert.equal(readMemory(root, { path: "CLAUDE.md" }).sha256, saved.sha256);
    const [run] = listRuns(root);
    assert.equal(run?.actions[0]?.title, "Edit CLAUDE.md");
    assert.deepEqual(rollback(root, saved.runId, { cli: fakeCli(root) }), [
      { id: "memory:CLAUDE.md", status: "rolled-back" },
    ]);
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), "# Before\r\n");
  });

  it("starts a missing CLAUDE.md, which Roll back deletes again", () => {
    const root = workspace();
    const saved = saveMemory(root, "CLAUDE.md", "# New\n", null, "test");
    assert.ok(existsSync(join(root, "CLAUDE.md")));
    rollback(root, saved.runId, { cli: fakeCli(root) });
    assert.equal(existsSync(join(root, "CLAUDE.md")), false);
  });

  it("refuses a file that changed since it was read, a key, a huge file and a path outside", () => {
    const root = workspace({ "CLAUDE.md": "# Before\n", "docs/CLAUDE.md": "# Docs\n" });
    const { sha256 } = readMemory(root, { path: "CLAUDE.md" });
    writeFileSync(join(root, "CLAUDE.md"), "# Someone else\n");
    assert.throws(() => saveMemory(root, "CLAUDE.md", "# Mine\n", sha256, "test"), /changed since you opened it/);
    const now = readMemory(root, { path: "CLAUDE.md" }).sha256;
    assert.throws(
      () => saveMemory(root, "CLAUDE.md", "Use ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop", now, "test"),
      /key or token/,
    );
    assert.throws(() => saveMemory(root, "CLAUDE.md", "x".repeat(205 * 1024), now, "test"), /over 200 KB/);
    assert.throws(() => saveMemory(root, "../CLAUDE.md", "x", null, "test"), /outside|\.\./i);
    assert.throws(() => saveMemory(root, "missing/CLAUDE.md", "x", null, "test"), /doesn't exist/);
    // Documentation that names a key is fine.
    const ok = saveMemory(root, "CLAUDE.md", "Set `ANTHROPIC_API_KEY=` in .env.\n", now, "test");
    assert.deepEqual(ok.warnings, []);
    assert.equal(listRuns(root).length, 1);
  });

  it("warns, without stopping, about length, home-folder paths and passwords in URLs", () => {
    assert.match(memoryWarnings(`${"line\n".repeat(300)}`)[0] ?? "", /301 lines/);
    assert.deepEqual(memoryWarnings("line\n".repeat(299)), []);
    assert.match(memoryWarnings("See /Users/someone/notes")[0] ?? "", /home folder/);
    assert.match(memoryWarnings("DATABASE_URL=postgres://app:app@localhost/app")[0] ?? "", /password/);
  });
});

describe("the scan across projects", () => {
  const npm = { "package.json": JSON.stringify({ name: "x", scripts: { test: "node --test" } }) };

  it("checks each project like the readiness audit", () => {
    const ok = workspace({ ...npm, "CLAUDE.md": "Run `npm test` before you push.\n" });
    const noTest = workspace({ ...npm, "CLAUDE.md": "# Notes\n" });
    const long = workspace({ ...npm, "CLAUDE.md": `npm test\n${"x\n".repeat(320)}` });
    const missing = workspace({ ...npm, "docs/CLAUDE.md": "# Docs\n", "CLAUDE.local.md": "me\n" });
    const gone = join(tmpdir(), "ac-memory-not-there");
    const config = temp("ac-config-");
    const scan = scanMemory([ok, noTest, long, missing, gone, ok], config);
    assert.deepEqual(
      scan.projects.map((p) => p.status),
      ["ok", "noTest", "long", "missing", "gone"],
    );
    assert.equal(scan.projects[1]?.testCommand, "npm test");
    assert.deepEqual([scan.projects[3]?.folders, scan.projects[3]?.local], [1, true]);
    assert.equal(scan.user.exists, false);
    assert.equal(scan.user.absolute, join(config, "CLAUDE.md"));
  });

  it("doesn't read a project's CLAUDE.md through a link", () => {
    const outside = temp("ac-outside-");
    writeFileSync(join(outside, "x.md"), "secret\n");
    const root = workspace();
    symlinkSync(join(outside, "x.md"), join(root, "CLAUDE.md"));
    assert.equal(scanProject(root).status, "refused");
  });
});
