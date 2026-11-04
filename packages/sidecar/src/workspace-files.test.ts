import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { applyFileEdits, listRuns } from "./bootstrap/apply.ts";
import { linkIn, readWorkspaceText, refuseLinks } from "./workspace-files.ts";

/** A cloned repo's symbolic links don't lead the app's own reads and writes out of it (security review 2026-11-04). */

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `ac-${name}-`));
  dirs.push(d);
  return d;
};

describe("workspace files and symbolic links", () => {
  const root = temp("ws");
  const outside = temp("outside");
  writeFileSync(join(outside, "gitconfig"), "[user]\n");
  symlinkSync(outside, join(root, ".claude"));
  symlinkSync(join(outside, "gitconfig"), join(root, "CLAUDE.md"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export {};\n");

  it("finds the first link on the way to a path", () => {
    assert.equal(linkIn(root, ".claude/agents/x.md"), ".claude");
    assert.equal(linkIn(root, "CLAUDE.md"), "CLAUDE.md");
    assert.equal(linkIn(root, "src/a.ts"), null);
    assert.equal(linkIn(root, "new/dir/file.txt"), null);
    assert.throws(() => refuseLinks(root, ".claude/settings.json"), /\.claude is a symbolic link/);
  });

  it("reads nothing through a link for a preview, and caps the size", () => {
    assert.equal(readWorkspaceText(root, "CLAUDE.md"), "");
    assert.equal(readWorkspaceText(root, ".claude/agents/x.md"), "");
    assert.equal(readWorkspaceText(root, "src/a.ts"), "export {};\n");
    assert.equal(readWorkspaceText(root, "src/a.ts", 3), "");
    assert.equal(readWorkspaceText(root, "missing.txt"), "");
  });

  it("refuses to write a recorded change through a link, and leaves no run", () => {
    assert.throws(
      () =>
        applyFileEdits(
          root,
          { id: "agents", title: "Save an agent" },
          [{ path: ".claude/agents/x.md", content: "---\nname: x\n---\n" }],
          "test",
        ),
      /symbolic link/,
    );
    assert.equal(existsSync(join(outside, "agents")), false);
    assert.equal(readFileSync(join(outside, "gitconfig"), "utf8"), "[user]\n");
    assert.equal(listRuns(root).length, 0);
  });

  it("won't use a .agentchainer folder that's a link", () => {
    const repo = temp("repo");
    symlinkSync(outside, join(repo, ".agentchainer"));
    assert.throws(
      () => applyFileEdits(repo, { id: "x", title: "x" }, [{ path: "notes.md", content: "hi\n" }], "test"),
      /\.agentchainer is a symbolic link/,
    );
    assert.equal(existsSync(join(outside, "backups")), false);
  });
});
