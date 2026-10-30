import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileDiff, gitInit, insideWorkspace, listFiles, parseHunks, parseStatus, revert } from "./workspace.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

/** A repo with one commit: a.txt (3 lines), sub/b.txt, an ignored file. */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ac-ws-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "b.txt"), "bee\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "ignored.log"), "x");
  return dir;
}

describe("parseStatus", () => {
  it("maps porcelain codes and keeps a rename's original path", () => {
    const entries = parseStatus(" M a.txt\0A  new.txt\0?? u.txt\0R  moved.txt\0old.txt\0UU c.txt\0 D gone.txt\0");
    assert.deepEqual(Object.fromEntries(entries), {
      "a.txt": { status: "modified", staged: false, unstaged: true },
      "new.txt": { status: "added", staged: true, unstaged: false },
      "u.txt": { status: "untracked", staged: false, unstaged: true },
      "moved.txt": { status: "renamed", staged: true, unstaged: false, origPath: "old.txt" },
      "c.txt": { status: "conflicted", staged: true, unstaged: true },
      "gone.txt": { status: "deleted", staged: false, unstaged: true },
    });
  });
});

describe("parseHunks", () => {
  it("reads ranges, including the one-line short form", () => {
    const hunks = parseHunks(
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2 +2 @@\n-two\n+TWO\n@@ -5,0 +6,2 @@\n+x\n+y\n",
    );
    assert.deepEqual(
      hunks.map(({ oldStart, oldLines, newStart, newLines, lines }) => [oldStart, oldLines, newStart, newLines, lines]),
      [
        [2, 1, 2, 1, ["-two", "+TWO"]],
        [5, 0, 6, 2, ["+x", "+y"]],
      ],
    );
  });
});

describe("insideWorkspace", () => {
  it("rejects paths that leave the workspace", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:\\x", "..\\x", ""]) {
      assert.throws(() => insideWorkspace("/repo", bad), /inside the workspace/, bad);
    }
    assert.equal(insideWorkspace("/repo", "src/a.ts"), join("/repo", "src", "a.ts"));
  });
});

describe("refreshing never writes the index", () => {
  it("lists and diffs without touching .git/index, which plain git status would rewrite", () => {
    const dir = makeRepo();
    try {
      // Same content, newer timestamp: git's stat info for a.txt is stale, so a plain status refreshes the index.
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(dir, "a.txt"), later, later);
      const index = join(dir, ".git", "index");
      const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };
      listFiles(dir);
      fileDiff(dir, "a.txt");
      assert.deepEqual(readFileSync(index), before.bytes, "index unchanged");
      assert.equal(statSync(index).mtimeMs, before.mtime, "index not rewritten (no watcher event)");
      git(dir, "status", "--porcelain");
      assert.notEqual(statSync(index).mtimeMs, before.mtime, "plain git status does rewrite it: the loop we avoid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace on a real git repo", () => {
  let dir = "";
  before(() => {
    dir = makeRepo();
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("lists tracked and untracked files with status, without ignored ones", () => {
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    const ws = listFiles(dir);
    assert.equal(ws.isGitRepo, true);
    assert.equal(ws.branch, "main");
    assert.deepEqual(
      ws.files.map((f) => [f.path, f.status ?? null]),
      [
        [".gitignore", null],
        ["a.txt", "modified"],
        ["new.txt", "untracked"],
        ["sub/b.txt", null],
      ],
    );
  });

  it("lists paths relative to a subfolder workspace", () => {
    writeFileSync(join(dir, "sub", "b.txt"), "bee!\n");
    const ws = listFiles(join(dir, "sub"));
    assert.deepEqual(ws.files, [{ path: "b.txt", status: "modified", staged: false, unstaged: true }]);
    git(dir, "checkout", "-q", "--", "sub/b.txt");
  });

  it("diffs HEAD against the working tree, hunk by hunk", () => {
    const d = fileDiff(dir, "a.txt");
    assert.equal(d.original, "one\ntwo\nthree\n");
    assert.equal(d.modified, "one\nTWO\nthree\nfour\n");
    assert.equal(d.hunks.length, 2);
    const fresh = fileDiff(dir, "new.txt");
    assert.equal(fresh.original, null);
    assert.equal(fresh.status, "untracked");
  });

  it("reverts a single hunk and leaves the others", () => {
    revert(dir, "a.txt", 0);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\nfour\n");
    assert.equal(fileDiff(dir, "a.txt").hunks.length, 1);
  });

  it("reverts whole files: modified back to HEAD, new files deleted", () => {
    revert(dir, "a.txt");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\n");
    revert(dir, "new.txt");
    assert.equal(
      listFiles(dir).files.some((f) => f.path === "new.txt"),
      false,
    );
    assert.throws(() => revert(dir, "a.txt"), /no changes/);
  });

  it("reverts a staged rename", () => {
    git(dir, "mv", "sub/b.txt", "sub/c.txt");
    revert(dir, "sub/c.txt");
    assert.deepEqual(
      listFiles(dir).files.map((f) => [f.path, f.status ?? null]),
      [
        [".gitignore", null],
        ["a.txt", null],
        ["sub/b.txt", null],
      ],
    );
  });

  it("flags binary files instead of sending their bytes", () => {
    writeFileSync(join(dir, "img.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const d = fileDiff(dir, "img.bin");
    assert.equal(d.binary, true);
    assert.equal(d.modified, null);
    rmSync(join(dir, "img.bin"));
  });
});

describe("workspace outside git", () => {
  it("walks the folder, skips heavy folders, and can git init", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ac-ws-plain-")));
    try {
      writeFileSync(join(dir, "x.txt"), "x");
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "dep", "i.js"), "");
      const ws = listFiles(dir);
      assert.deepEqual(ws, { isGitRepo: false, branch: null, files: [{ path: "x.txt" }], truncated: false });
      gitInit(dir);
      assert.equal(listFiles(dir).isGitRepo, true);
      assert.throws(() => gitInit(dir), /already/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
