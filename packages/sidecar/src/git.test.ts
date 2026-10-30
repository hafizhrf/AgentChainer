import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  abortMerge,
  branches,
  cleanDraft,
  commit,
  deleteBranch,
  draftContext,
  draftPrompt,
  fetchAll,
  merge,
  pull,
  push,
  renameBranch,
  stage,
  switchBranch,
  unstage,
} from "./git.ts";
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

describe("branch menu operations on real repos", () => {
  let root = "";
  let dir = "";
  let other = "";
  const head = (cwd: string) => run(cwd, "rev-parse", "HEAD").trim();
  /** Writes, stages and commits one file. */
  const change = (cwd: string, file: string, text: string, msg: string) => {
    writeFileSync(join(cwd, file), text);
    run(cwd, "add", file);
    run(cwd, "commit", "-q", "-m", msg);
  };
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ac-branch-")));
    const remote = join(root, "remote.git");
    run(root, "init", "-q", "--bare", "-b", "main", remote);
    other = join(root, "other");
    run(root, "clone", "-q", remote, other);
    change(other, "a.txt", "a\n", "init");
    run(other, "push", "-q", "-u", "origin", "main");
    // A clone, so `origin/HEAD` exists and must be left out of the remote list.
    dir = join(root, "work");
    run(root, "clone", "-q", remote, dir);
    run(dir, "config", "user.name", "t");
    run(dir, "config", "user.email", "t@example.com");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("lists remote-only branches, and checks one out as a tracking branch", () => {
    assert.deepEqual(branches(dir).remote, []);
    run(other, "switch", "-q", "-c", "feature-r");
    change(other, "r.txt", "r\n", "remote feature");
    run(other, "push", "-q", "origin", "feature-r");
    run(other, "switch", "-q", "main");
    fetchAll(dir);
    assert.deepEqual(branches(dir).remote, ["origin/feature-r"]);
    assert.throws(() => switchBranch(dir, "origin/nope", false, true), /Not a remote branch/);
    switchBranch(dir, "origin/feature-r", false, true);
    const b = branches(dir);
    assert.deepEqual([b.current, b.upstream, b.remote], ["feature-r", "origin/feature-r", []]);
    switchBranch(dir, "main", false);
  });

  it("fetch forgets branches deleted on the remote", () => {
    run(other, "push", "-q", "origin", "main:gone");
    fetchAll(dir);
    assert.ok(branches(dir).remote.includes("origin/gone"));
    run(other, "push", "-q", "origin", "--delete", "gone");
    fetchAll(dir);
    assert.ok(!branches(dir).remote.includes("origin/gone"));
  });

  it("pulls fast-forward only: a diverged branch fails and is left as it was", () => {
    change(other, "b.txt", "b\n", "remote b");
    run(other, "push", "-q");
    pull(dir);
    assert.equal(head(dir), head(other));

    change(other, "c.txt", "c\n", "remote c");
    run(other, "push", "-q");
    change(dir, "d.txt", "d\n", "local d");
    const before = head(dir);
    assert.throws(() => pull(dir), /diverged/);
    assert.equal(head(dir), before);
    // The way out the message names: merge the upstream into the branch.
    assert.deepEqual(merge(dir, "origin/main"), { merged: true, conflicts: [] });
    assert.equal(run(dir, "rev-list", "--count", "HEAD..origin/main").trim(), "0");
  });

  it("pull needs an upstream", () => {
    switchBranch(dir, "local-only", true);
    assert.throws(() => pull(dir), /no upstream/);
    switchBranch(dir, "main", false);
  });

  it("deletes merged branches, and asks again before losing unmerged commits", () => {
    run(dir, "branch", "done");
    assert.deepEqual(deleteBranch(dir, "done", false), { deleted: true, unmerged: false });
    switchBranch(dir, "wip", true);
    change(dir, "w.txt", "w\n", "wip");
    assert.throws(() => deleteBranch(dir, "wip", false), /checked out/);
    switchBranch(dir, "main", false);
    assert.deepEqual(deleteBranch(dir, "wip", false), { deleted: false, unmerged: true });
    assert.ok(branches(dir).branches.includes("wip"));
    assert.deepEqual(deleteBranch(dir, "wip", true), { deleted: true, unmerged: false });
    assert.ok(!branches(dir).branches.includes("wip"));
  });

  it("renames branches, rejecting bad names", () => {
    renameBranch(dir, "local-only", "renamed");
    assert.ok(branches(dir).branches.includes("renamed"));
    assert.ok(!branches(dir).branches.includes("local-only"));
    for (const bad of ["-x", "a..b"]) assert.throws(() => renameBranch(dir, "renamed", bad), /valid branch/);
  });

  it("reports a conflicting merge as in progress, and aborts it back to where it was", () => {
    assert.throws(() => merge(dir, "nope"), /No branch/);
    switchBranch(dir, "conflict", true);
    change(dir, "a.txt", "theirs\n", "theirs");
    switchBranch(dir, "main", false);
    change(dir, "a.txt", "ours\n", "ours");
    const before = head(dir);
    assert.deepEqual(merge(dir, "conflict"), { merged: false, conflicts: ["a.txt"] });
    assert.deepEqual(branches(dir).merging, { branch: "conflict", conflicts: ["a.txt"] });
    assert.equal(listFiles(dir).files.find((f) => f.path === "a.txt")?.status, "conflicted");
    abortMerge(dir);
    assert.equal(branches(dir).merging, null);
    assert.equal(head(dir), before);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "ours\n");
  });
});

describe("cleanDraft", () => {
  it("strips code fences and blank lines around the message", () => {
    assert.equal(cleanDraft("\n```\nfeat: x\n\nbody\n```\n"), "feat: x\n\nbody");
    assert.equal(cleanDraft("fix: y"), "fix: y");
  });
});
