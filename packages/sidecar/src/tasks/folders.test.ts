import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Task } from "@agentchainer/protocol";
import { detectWorkspace } from "../detect/detect.ts";
import { draftPrompt } from "./contract.ts";
import { branchFolders, folderDirs, folderFileStats, removeFolderWorktrees, taskFolders } from "./folders.ts";

const ID = "2026-11-03-0000f01d";

describe("a task across a workspace's folders (M8-01)", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ac-folders-")));
  after(() => rmSync(base, { recursive: true, force: true }));
  const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const repo = (name: string) => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `# ${name}\n`);
    g(dir, "init", "-q", "-b", "main");
    g(dir, "config", "user.name", "t");
    g(dir, "config", "user.email", "t@example.invalid");
    g(dir, "config", "core.autocrlf", "false");
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", "init");
    return dir;
  };

  it("names each folder after itself, made unique", () => {
    const names = taskFolders("/w/app", ["/w/api", "/x/api", "/y/app/", "/z/API"]).map((f) => f.name);
    assert.deepEqual(names, ["api", "api-2", "app-2", "API-3"]);
  });

  it("tells drafting the folders and how to name areas in them", () => {
    const prompt = draftPrompt("Add a route", detectWorkspace(base), [], {
      folders: [{ name: "api", path: "/w/api" }],
    });
    assert.match(prompt, /- api: \/w\/api/);
    assert.match(prompt, /`api:src\/index\.ts`/);
  });

  it("gives each git folder a worktree on the task's branch, and lists its changes by folder", () => {
    const api = repo("api");
    const notes = join(base, "notes");
    mkdirSync(notes);
    const task = { id: ID, folders: taskFolders(join(base, "app"), [api, notes]) } as Task;
    const { task: branched, fresh } = branchFolders(task);
    assert.deepEqual(
      fresh.map((f) => f.name),
      ["api"],
      "a folder without git gets no worktree",
    );
    const wt = branched.folders?.[0]?.worktree;
    assert.ok(wt && existsSync(join(wt.path, "README.md")));
    assert.equal(wt.branch, `agentchainer/${ID}`);
    assert.equal(g(api, "status", "--porcelain"), "?? .agentchainer/\n", "the folder's own checkout is untouched");

    const dirs = folderDirs(branched);
    assert.equal(dirs[0]?.dir, wt.path, "steps work in the worktree, not the person's checkout");
    assert.equal(dirs[1]?.dir, notes, "a folder without git is worked in directly");

    writeFileSync(join(wt.path, "routes.txt"), "GET /ready\n");
    assert.deepEqual(
      folderFileStats(branched).map((f) => f.path),
      ["api:routes.txt"],
    );
    assert.equal(branchFolders(branched).fresh.length, 0, "a picked-up run keeps its worktrees");

    const removed = removeFolderWorktrees(branched);
    assert.equal(removed.folders?.[0]?.worktree?.removed, true);
    assert.equal(existsSync(wt.path), false);
    assert.equal(folderDirs(removed)[0]?.dir, api);
  });
});
