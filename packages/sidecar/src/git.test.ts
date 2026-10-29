import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { branches, cleanDraft, commit, draftContext, draftPrompt, push, stage, switchBranch, unstage } from "./git.ts";
import { listFiles } from "./workspace.ts";

const ID = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const run = (cwd: string, ...args: string[]) => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8" });

describe("git panel operations on real repos", () => {
  let root = "";
  let dir = "";
  let remote = "";
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ac-git-")));
    remote = join(root, "remote.git");
    dir = join(root, "work");
    run(root, "init", "-q", "--bare", "-b", "main", remote);
    run(root, "init", "-q", "-b", "main", dir);
    run(dir, "remote", "add", "origin", remote);
    // Commits made by the code under test need an identity too.
    run(dir, "config", "user.name", "t");
    run(dir, "config", "user.email", "t@example.com");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("stages and unstages, also before the first commit", () => {
    writeFileSync(join(dir, "a.txt"), "a\n");
    stage(dir, ["a.txt"]);
    assert.deepEqual(listFiles(dir).files, [{ path: "a.txt", status: "added", staged: true, unstaged: false }]);
    unstage(dir, ["a.txt"]);
    assert.equal(listFiles(dir).files[0]?.status, "untracked");
    assert.throws(() => stage(dir, ["../outside"]), /inside the workspace/);
  });

  it("commits only what is staged", () => {
    assert.throws(() => commit(dir, "empty"), /Nothing is staged/);
    stage(dir, ["a.txt"]);
    assert.throws(() => commit(dir, "  "), /empty/);
    const sha = commit(dir, "feat: add a\n\nBody line.");
    assert.match(sha, /^[0-9a-f]{7,}$/);
    assert.equal(run(dir, "log", "-1", "--format=%B").trim(), "feat: add a\n\nBody line.");
  });

  it("pushes a new branch with tracking, then reports ahead/behind", () => {
    assert.equal(branches(dir).upstream, null);
    push(dir);
    const b = branches(dir);
    assert.deepEqual([b.current, b.upstream, b.ahead, b.behind], ["main", "origin/main", 0, 0]);
    writeFileSync(join(dir, "a.txt"), "a2\n");
    stage(dir, ["a.txt"]);
    commit(dir, "fix: a2");
    assert.equal(branches(dir).ahead, 1);
  });

  it("never forces: a diverged push fails instead of overwriting the remote", () => {
    const other = join(root, "other");
    run(root, "clone", "-q", remote, other);
    writeFileSync(join(other, "b.txt"), "b\n");
    run(other, "add", "b.txt");
    run(other, "commit", "-q", "-m", "remote change");
    run(other, "push", "-q");
    assert.throws(() => push(dir), /push failed/);
    assert.equal(run(other, "log", "-1", "--format=%s").trim(), "remote change", "remote kept its commit");
  });

  it("switches and creates branches, rejecting bad names", () => {
    switchBranch(dir, "feature/x", true);
    assert.equal(branches(dir).current, "feature/x");
    assert.deepEqual(branches(dir).branches.sort(), ["feature/x", "main"]);
    switchBranch(dir, "main", false);
    for (const bad of ["-x", "a..b", "has space"]) assert.throws(() => switchBranch(dir, bad, true), /valid branch/);
  });

  it("builds the commit-message prompt from the staged diff and recent subjects", () => {
    writeFileSync(join(dir, "c.txt"), "c\n");
    stage(dir, ["c.txt"]);
    const ctx = draftContext(dir);
    assert.match(ctx.stat, /c\.txt/);
    assert.match(ctx.log, /fix: a2/);
    const prompt = draftPrompt(ctx);
    assert.match(prompt, /Staged diff:\n[\s\S]*\+c/);
    unstage(dir, ["c.txt"]);
    assert.throws(() => draftContext(dir), /Nothing is staged/);
  });
});

describe("cleanDraft", () => {
  it("strips code fences and blank lines around the message", () => {
    assert.equal(cleanDraft("\n```\nfeat: x\n\nbody\n```\n"), "feat: x\n\nbody");
    assert.equal(cleanDraft("fix: y"), "fix: y");
  });
});
