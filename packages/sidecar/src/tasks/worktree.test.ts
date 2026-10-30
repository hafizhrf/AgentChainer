import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  addWorktree,
  branchOf,
  codeRootIn,
  commitAll,
  hasTrackedChanges,
  headOf,
  mergeInto,
  removeWorktree,
  tipOf,
  worktreePath,
} from "./worktree.ts";

const ID = "2026-10-30-0000abcd";
const CHILD_A = "2026-10-30-0000aaaa";
const CHILD_B = "2026-10-30-0000bbbb";

describe("XL worktrees", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-wt-")));
  after(() => rmSync(root, { recursive: true, force: true }));
  // Commits need an identity; the app uses the user's, the test sets one for the repository.
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  it("keeps the worktrees inside .agentchainer/worktrees/, by task id", () => {
    assert.equal(worktreePath(root, ID), join(root, ".agentchainer", "worktrees", ID));
    assert.throws(() => worktreePath(root, "../../etc"));
  });

  it("adds a task worktree on its own branch, git-ignored", () => {
    writeFileSync(join(root, "cart.js"), "export const total = 1;\n");
    writeFileSync(join(root, "README.md"), "# app\n");
    g(root, "init", "-q", "-b", "main");
    g(root, "config", "user.name", "t");
    g(root, "config", "user.email", "t@example.invalid");
    g(root, "config", "core.autocrlf", "false");
    g(root, "add", "-A");
    g(root, "commit", "-q", "-m", "init");
    const head = headOf(root);
    assert.ok(head);
    addWorktree(root, worktreePath(root, ID), branchOf(ID), head);
    assert.ok(existsSync(join(worktreePath(root, ID), "cart.js")));
    assert.equal(tipOf(root, branchOf(ID)), head);
    assert.match(readFileSync(join(root, ".agentchainer", ".gitignore"), "utf8"), /^worktrees\/$/m);
    assert.equal(g(root, "status", "--porcelain"), "?? .agentchainer/\n", "the worktree isn't listed on its own");
    assert.equal(hasTrackedChanges(root), false);
  });

  it("commits only a sub-task's changes, merges it, and stops on a conflict", () => {
    const task = worktreePath(root, ID);
    const a = worktreePath(root, CHILD_A);
    const b = worktreePath(root, CHILD_B);
    addWorktree(root, a, branchOf(CHILD_A), tipOf(root, branchOf(ID)));
    addWorktree(root, b, branchOf(CHILD_B), tipOf(root, branchOf(ID)));

    // Sub-task A: a change, a file installed before it started, and AgentChainer's own folder.
    writeFileSync(join(a, "cart.js"), "export const total = 2;\n");
    writeFileSync(join(a, "coupon.js"), "export const coupon = 1;\n");
    writeFileSync(join(a, "installed.txt"), "from setup\n");
    mkdirSync(join(a, ".agentchainer"));
    writeFileSync(join(a, ".agentchainer", "x.json"), "{}");
    const commit = commitAll(a, "Sub-task A", ["installed.txt"]);
    assert.ok(commit);
    assert.deepEqual(g(a, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(), [
      "cart.js",
      "coupon.js",
    ]);
    assert.equal(commitAll(a, "again", ["installed.txt"]), null, "nothing left to commit");
    assert.deepEqual(mergeInto(task, branchOf(CHILD_A), "Merge sub-task A"), { merged: true, conflicts: [] });
    assert.equal(readFileSync(join(task, "cart.js"), "utf8"), "export const total = 2;\n");

    // Sub-task B changed the same line from the same start: a conflict, left for the user.
    writeFileSync(join(b, "cart.js"), "export const total = 3;\n");
    assert.ok(commitAll(b, "Sub-task B", []));
    assert.deepEqual(mergeInto(task, branchOf(CHILD_B), "Merge sub-task B"), { merged: false, conflicts: ["cart.js"] });
    g(task, "merge", "--abort");

    removeWorktree(root, a);
    assert.equal(existsSync(a), false);
    assert.ok(tipOf(root, branchOf(CHILD_A)), "the branch stays");
  });

  it("finds the workspace folder inside a worktree when the workspace is a subfolder", () => {
    const sub = join(root, "apps", "web");
    mkdirSync(sub, { recursive: true });
    assert.equal(codeRootIn(sub, "/wt"), join("/wt", "apps", "web"));
    assert.equal(codeRootIn(root, "/wt"), "/wt");
  });
});
