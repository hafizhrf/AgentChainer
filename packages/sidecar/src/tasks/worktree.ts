import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TaskIdSchema } from "@agentchainer/protocol";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { git, gitOrThrow, repoOf } from "../workspace.ts";

/**
 * XL's worktrees (M3-07): one for the task and one per sub-task, under `.agentchainer/worktrees/` (git-ignored), each on
 * its own `agentchainer/<id>` branch. Only these branches get the app's own commits; the user's branch changes only
 * when they merge the result.
 */
export const WORKTREES = "worktrees";

export const branchOf = (id: string) => `agentchainer/${id}`;

/** Where a task's worktree goes; ids are checked, so the path can't leave `.agentchainer/worktrees/`. */
export function worktreePath(root: string, id: string): string {
  TaskIdSchema.parse(id);
  return path.join(root, AC_DIR, WORKTREES, id);
}

/** The folder in a worktree that matches the workspace, which can be a subfolder of its repository. */
export function codeRootIn(root: string, worktree: string): string {
  const prefix = repoOf(root)?.prefix.replace(/\/$/, "") ?? "";
  return prefix ? path.join(worktree, ...prefix.split("/")) : worktree;
}

export function headOf(root: string): string | null {
  const r = git(["rev-parse", "-q", "--verify", "HEAD"], root);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The commit a branch points at. */
export function tipOf(root: string, branch: string): string {
  return gitOrThrow(["rev-parse", `refs/heads/${branch}`], root).trim();
}

/** Adds the worktree on `branch`, made from `from`; a branch that exists already (a picked-up run) is used as it is. */
export function addWorktree(root: string, dir: string, branch: string, from: string): void {
  ensureIgnored(root, `${WORKTREES}/`);
  if (existsSync(dir)) return;
  mkdirSync(path.dirname(dir), { recursive: true });
  const exists = git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`], root).status === 0;
  gitOrThrow(
    exists ? ["worktree", "add", "-q", dir, branch] : ["worktree", "add", "-q", "-b", branch, dir, from],
    root,
  );
}

/** Removes a worktree with whatever is in it (installed dependencies); its branch stays. */
export function removeWorktree(root: string, dir: string): void {
  if (existsSync(dir) && git(["worktree", "remove", "--force", dir], root).status !== 0) {
    rmSync(dir, { recursive: true, force: true });
  }
  git(["worktree", "prune"], root);
}

export function deleteBranch(root: string, branch: string): void {
  git(["branch", "-D", "-q", branch], root);
}

/**
 * Commits what a sub-task changed, from its code folder: not AgentChainer's own folder, and not the files that were
 * already untracked after its setup. The user's commit hooks run. Returns the commit, or null when nothing changed.
 */
export function commitAll(dir: string, message: string, untrackedBefore: string[]): string | null {
  gitOrThrow(["add", "-A", "--", ".", `:(exclude)${AC_DIR}`], dir);
  if (untrackedBefore.length) {
    gitOrThrow(["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], dir, untrackedBefore.join("\0"));
  }
  if (git(["diff", "--cached", "--quiet"], dir).status === 0) return null;
  gitOrThrow(["commit", "-q", "-F", "-"], dir, message);
  return gitOrThrow(["rev-parse", "HEAD"], dir).trim();
}

/** Merges `branch` into the worktree's branch, always as a merge commit. Conflicts leave the merge in progress. */
export function mergeInto(dir: string, branch: string, message: string): { merged: boolean; conflicts: string[] } {
  const r = git(["merge", "--no-ff", "-m", message, branch], dir, undefined, { env: { GIT_MERGE_AUTOEDIT: "no" } });
  if (r.status === 0) return { merged: true, conflicts: [] };
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"], dir).stdout.split("\n").filter(Boolean);
  if (conflicts.length) return { merged: false, conflicts };
  throw new Error(`git merge failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
}

/** Whether the workspace has changes to tracked files, which a merge into it could mix with. */
export function hasTrackedChanges(root: string): boolean {
  return git(["status", "--porcelain", "--untracked-files=no"], root).stdout.trim() !== "";
}
