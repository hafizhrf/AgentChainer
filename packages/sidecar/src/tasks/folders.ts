import { existsSync } from "node:fs";
import path from "node:path";
import type { Task, TaskFolder } from "@agentchainer/protocol";
import { git, repoOf } from "../workspace.ts";
import { fileStats, untracked } from "./runner.ts";
import { addWorktree, branchOf, codeRootIn, headOf, removeWorktree, worktreePath } from "./worktree.ts";

/**
 * A task across a multi-folder workspace's folders (M8-01, docs/design/workspaces-and-fleet.md §5.5). The task's
 * records stay in the primary folder; each other git folder gets a worktree of its own repository on the task's
 * branch, under its own `.agentchainer/worktrees/`, and one without git is worked in directly.
 */

/** The other folders with names that prefix their paths (`api:src/x.ts`): each folder's own name, made unique. */
export function taskFolders(primary: string, dirs: string[]): TaskFolder[] {
  const taken = new Set([path.basename(primary).toLowerCase()]);
  return dirs.map((dir) => {
    const base = path.basename(dir.replace(/[\\/]+$/, "")) || "folder";
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
    taken.add(name.toLowerCase());
    return { name, path: dir };
  });
}

const live = (wt: TaskFolder["worktree"]): boolean => !!wt && !wt.removed && existsSync(wt.path);

/** Where each other folder's code is: its worktree while it exists, otherwise the folder itself. */
export function folderDirs(task: Task): { name: string; dir: string; folder: TaskFolder }[] {
  return (task.folders ?? []).map((folder) => ({
    name: folder.name,
    dir: folder.worktree && live(folder.worktree) ? codeRootIn(folder.path, folder.worktree.path) : folder.path,
    folder,
  }));
}

/**
 * Gives each other git folder with a commit its worktree on `agentchainer/<id>`, as `taskBranch` does for the primary
 * one, or keeps the one it has. Returns the task and the folders whose worktree is new, so the run sets them up.
 */
export function branchFolders(task: Task): { task: Task; fresh: TaskFolder[] } {
  if (!task.folders?.length) return { task, fresh: [] };
  const fresh: TaskFolder[] = [];
  const folders = task.folders.map((folder) => {
    if (live(folder.worktree) || !existsSync(folder.path)) return folder;
    const head = repoOf(folder.path) ? headOf(folder.path) : null;
    if (!head) return folder;
    const base = folder.worktree?.base ?? head;
    const dir = worktreePath(folder.path, task.id);
    addWorktree(folder.path, dir, branchOf(task.id), base);
    const from =
      folder.worktree?.from ?? (git(["symbolic-ref", "--short", "-q", "HEAD"], folder.path).stdout.trim() || undefined);
    const next: TaskFolder = {
      ...folder,
      worktree: {
        path: dir,
        branch: branchOf(task.id),
        base,
        ...(from ? { from } : {}),
        untracked: untracked(codeRootIn(folder.path, dir)),
      },
    };
    fresh.push(next);
    return next;
  });
  return { task: { ...task, folders }, fresh };
}

/** The files a run changed in the other folders, each path prefixed with its folder's name. */
export function folderFileStats(task: Task): ReturnType<typeof fileStats> {
  return folderDirs(task).flatMap(({ name, dir, folder }) => {
    const wt = folder.worktree;
    if (!wt) return [];
    return fileStats(dir, wt.base, wt.untracked).map((f) => ({ ...f, path: `${name}:${f.path}` }));
  });
}

/** Removes the other folders' worktrees; their branches stay. Returns the task with them marked removed. */
export function removeFolderWorktrees(task: Task): Task {
  if (!task.folders?.length) return task;
  const folders = task.folders.map((folder) => {
    const wt = folder.worktree;
    if (!wt || wt.removed) return folder;
    removeWorktree(folder.path, wt.path);
    return { ...folder, worktree: { ...wt, removed: true } };
  });
  return { ...task, folders };
}
