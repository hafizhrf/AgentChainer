import { readFileSync } from "node:fs";
import path from "node:path";
import { RpcErrorCode } from "@agentchainer/protocol";
import { t } from "./i18n/index.ts";
import { RpcFailure } from "./rpc.ts";
import type { AgentSdkModule } from "./sdk-loader.ts";
import { commandFailed, git, gitAsync, gitOrThrow, insideWorkspace, repoOf } from "./workspace.ts";

/**
 * The git panel's operations (M1-30), on the system `git` CLI. There is no force push: no code path here passes
 * `--force` or a `+refspec`, and the agent's own pushes still go through the guard.
 */

export type Branches = {
  current: string | null;
  branches: string[];
  /** Remote branches that have no local branch of the same name yet, e.g. "origin/feature-x". */
  remote: string[];
  /** e.g. "origin/main"; null when the branch has no upstream yet. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** A merge in progress: the branch being merged (when git recorded it) and the files with conflicts. */
  merging: { branch: string | null; conflicts: string[] } | null;
};

/**
 * Network operations: git must not prompt for credentials (there's no terminal to answer), must not hang, and runs
 * without blocking the sidecar (`gitAsync`), which the UI would otherwise restart after its health ping timed out.
 */
const NETWORK = { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000 };

function requireRepo(cwd: string) {
  const repo = repoOf(cwd);
  if (!repo) throw new RpcFailure(RpcErrorCode.invalidParams, t("git.repo.notARepo"));
  return repo;
}

export function branches(cwd: string): Branches {
  requireRepo(cwd);
  const current = git(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
  const list = gitOrThrow(["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd).split("\n").filter(Boolean);
  const local = new Set(list);
  // `origin/HEAD` is a pointer, not a branch (its short name is just "origin"); branches checked out already are local.
  const remote = gitOrThrow(["for-each-ref", "--format=%(refname:short)", "refs/remotes"], cwd)
    .split("\n")
    .filter((r) => r.includes("/") && !r.endsWith("/HEAD") && !local.has(r.slice(r.indexOf("/") + 1)));
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd);
  let ahead = 0;
  let behind = 0;
  if (upstream.status === 0) {
    const counts = git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd).stdout.trim().split(/\s+/);
    behind = Number(counts[0]) || 0;
    ahead = Number(counts[1]) || 0;
  }
  return {
    current: current.status === 0 ? current.stdout.trim() : null,
    branches: list,
    remote,
    upstream: upstream.status === 0 ? upstream.stdout.trim() : null,
    ahead,
    behind,
    merging: mergeState(cwd),
  };
}

function mergeState(cwd: string): Branches["merging"] {
  if (git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd).status !== 0) return null;
  const msgPath = gitOrThrow(["rev-parse", "--git-path", "MERGE_MSG"], cwd).trim();
  let branch: string | null = null;
  try {
    const first = readFileSync(path.resolve(cwd, msgPath), "utf8").split("\n")[0] ?? "";
    branch = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(first)?.[1] ?? null;
  } catch {
    // no message: the branch stays unknown
  }
  return { branch, conflicts: conflicted(cwd) };
}

/** Files with unresolved conflicts, relative to the repository root. */
function conflicted(cwd: string): string[] {
  return gitOrThrow(["diff", "--name-only", "--diff-filter=U"], cwd).split("\n").filter(Boolean);
}

function requireBranchName(cwd: string, branch: string): void {
  if (git(["check-ref-format", "--branch", branch], cwd).status !== 0 || branch.startsWith("-")) {
    throw new RpcFailure(RpcErrorCode.invalidParams, t("git.branch.invalidName", { branch }));
  }
}

/**
 * Switches to `branch`, creating it from HEAD when `create` is set. With `track`, `branch` is a remote branch such as
 * "origin/feature-x", and the local branch that tracks it is created. Git refuses if local changes would be lost.
 */
export function switchBranch(cwd: string, branch: string, create: boolean, track = false): void {
  requireRepo(cwd);
  if (track) {
    if (!branches(cwd).remote.includes(branch)) {
      throw new RpcFailure(RpcErrorCode.invalidParams, t("git.branch.notRemote", { branch }));
    }
    gitOrThrow(["switch", "--track", branch], cwd);
    return;
  }
  requireBranchName(cwd, branch);
  gitOrThrow(create ? ["switch", "-c", branch] : ["switch", branch], cwd);
}

/** Updates every remote's branches, and forgets the ones deleted upstream. */
export async function fetchAll(cwd: string): Promise<string> {
  requireRepo(cwd);
  const r = await gitAsync(["fetch", "--all", "--prune"], cwd, NETWORK);
  if (r.status !== 0) throw commandFailed("git fetch", r.stderr.trim() || `exit ${r.status}`);
  return (r.stderr || r.stdout).trim();
}

/** Brings in the upstream's new commits, fast-forward only: never a merge commit made behind the user's back. */
export async function pull(cwd: string): Promise<string> {
  const { current, upstream } = branches(cwd);
  if (!current) throw new RpcFailure(RpcErrorCode.invalidParams, t("git.branch.detached"));
  if (!upstream) throw new RpcFailure(RpcErrorCode.invalidParams, t("git.branch.noUpstream", { branch: current }));
  const r = await gitAsync(["pull", "--ff-only"], cwd, NETWORK);
  if (r.status !== 0) {
    const err = r.stderr.trim();
    if (/fast-forward|diverg/i.test(err)) {
      throw new RpcFailure(RpcErrorCode.invalidParams, t("git.pull.diverged", { current, upstream }));
    }
    throw commandFailed("git pull", err || `exit ${r.status}`);
  }
  return (r.stdout || r.stderr).trim();
}

/**
 * Deletes a local branch. Without `force`, git refuses a branch whose commits aren't merged anywhere; that comes back
 * as `unmerged`, so the UI can ask again before forcing.
 */
export function deleteBranch(cwd: string, branch: string, force: boolean): { deleted: boolean; unmerged: boolean } {
  requireRepo(cwd);
  requireBranchName(cwd, branch);
  if (branches(cwd).current === branch) {
    throw new RpcFailure(RpcErrorCode.invalidParams, t("git.branch.checkedOut", { branch }));
  }
  const r = git(["branch", force ? "-D" : "-d", branch], cwd);
  if (r.status === 0) return { deleted: true, unmerged: false };
  if (!force && /not fully merged/i.test(r.stderr)) return { deleted: false, unmerged: true };
  throw commandFailed("git branch", r.stderr.trim() || `exit ${r.status}`);
}

export function renameBranch(cwd: string, from: string, to: string): void {
  requireRepo(cwd);
  requireBranchName(cwd, from);
  requireBranchName(cwd, to);
  gitOrThrow(["branch", "-m", from, to], cwd);
}

/**
 * Merges `branch` (local, or remote such as "origin/x") into the current branch. Conflicts aren't an error: the files
 * come back, the merge stays in progress, and the user resolves and commits it, or aborts.
 */
export function merge(cwd: string, branch: string): { merged: boolean; conflicts: string[] } {
  requireRepo(cwd);
  requireBranchName(cwd, branch);
  const known = ["refs/heads/", "refs/remotes/"].some(
    (prefix) => git(["rev-parse", "-q", "--verify", `${prefix}${branch}`], cwd).status === 0,
  );
  if (!known) throw new RpcFailure(RpcErrorCode.invalidParams, t("git.branch.notFound", { branch }));
  const r = git(["merge", "--no-edit", branch], cwd, undefined, { env: { GIT_MERGE_AUTOEDIT: "no" } });
  if (r.status === 0) return { merged: true, conflicts: [] };
  const conflicts = conflicted(cwd);
  if (conflicts.length) return { merged: false, conflicts };
  throw commandFailed("git merge", (r.stderr || r.stdout).trim() || `exit ${r.status}`);
}

/** Abandons the merge in progress and puts the branch back as it was before it. */
export function abortMerge(cwd: string): void {
  requireRepo(cwd);
  gitOrThrow(["merge", "--abort"], cwd);
}

export function stage(cwd: string, paths: string[]): void {
  requireRepo(cwd);
  for (const p of paths) insideWorkspace(cwd, p);
  gitOrThrow(["add", "--", ...paths], cwd);
}

export function unstage(cwd: string, paths: string[]): void {
  requireRepo(cwd);
  for (const p of paths) insideWorkspace(cwd, p);
  // `restore --staged` needs a HEAD; before the first commit, drop the paths from the index instead.
  const hasHead = git(["rev-parse", "--verify", "-q", "HEAD"], cwd).status === 0;
  gitOrThrow(hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-q", "--", ...paths], cwd);
}

/** Commits what is staged and returns the new commit's short sha. */
export function commit(cwd: string, message: string): string {
  requireRepo(cwd);
  if (!message.trim()) throw new RpcFailure(RpcErrorCode.invalidParams, t("git.commit.emptyMessage"));
  if (git(["diff", "--cached", "--quiet"], cwd).status === 0) {
    throw new RpcFailure(RpcErrorCode.invalidParams, t("git.commit.nothingStaged"));
  }
  gitOrThrow(["commit", "-q", "-F", "-"], cwd, message);
  return gitOrThrow(["rev-parse", "--short", "HEAD"], cwd).trim();
}

/** Pushes the current branch; a branch without an upstream is pushed to `origin` and tracked. Never forced. */
export async function push(cwd: string): Promise<string> {
  const { upstream, current } = branches(cwd);
  if (!current) throw new RpcFailure(RpcErrorCode.invalidParams, t("git.branch.detached"));
  const args = upstream ? ["push"] : ["push", "-u", "origin", current];
  const r = await gitAsync(args, cwd, NETWORK);
  if (r.status !== 0) throw commandFailed("git push", r.stderr.trim() || `exit ${r.status}`);
  return (r.stderr || r.stdout).trim();
}

/**
 * Pushes `branch` to `origin` and tracks it, from any checkout of the repository: a task's branch (M5-02). Never forced.
 * `config` adds `-c` settings for this one command, e.g. `gh` as the credential helper (`ghCredentialConfig`).
 */
export async function pushBranch(cwd: string, branch: string, config: string[] = []): Promise<string> {
  const args = [
    ...config.flatMap((c) => ["-c", c]),
    "push",
    "-u",
    "origin",
    `refs/heads/${branch}:refs/heads/${branch}`,
  ];
  const r = await gitAsync(args, cwd, NETWORK);
  if (r.status !== 0) throw commandFailed("git push", r.stderr.trim() || `exit ${r.status}`);
  return (r.stderr || r.stdout).trim();
}

/** Diff caps for the commit-message prompt: enough to describe the change, bounded in cost. */
const MAX_DIFF_CHARS = 24_000;

/** What the commit-message draft is based on: the staged diff and recent subjects (to match the repo's style). */
export function draftContext(cwd: string): { stat: string; diff: string; log: string } {
  requireRepo(cwd);
  const stat = gitOrThrow(["diff", "--cached", "--stat"], cwd).trim();
  if (!stat) throw new RpcFailure(RpcErrorCode.invalidParams, t("git.commit.nothingStaged"));
  const full = gitOrThrow(["diff", "--cached", "--no-color", "--no-ext-diff"], cwd);
  const diff = full.length > MAX_DIFF_CHARS ? `${full.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : full;
  const log = git(["log", "-10", "--format=%s"], cwd).stdout.trim();
  return { stat, diff, log };
}

export function draftPrompt(ctx: { stat: string; diff: string; log: string }): string {
  return [
    "Write a git commit message for the staged changes below.",
    "Match the style of the recent commit subjects if there are any (for example Conventional Commits).",
    "Subject line under 72 characters, then a blank line and a short body only if it helps. No code fences.",
    "Reply with the commit message only.",
    "",
    "Recent commit subjects:",
    ctx.log || "(none yet)",
    "",
    "Staged files:",
    ctx.stat,
    "",
    "Staged diff:",
    ctx.diff,
  ].join("\n");
}

/** Trims what models like to wrap a message in: code fences and surrounding blank lines. */
export function cleanDraft(text: string): string {
  return text
    .trim()
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/, "")
    .trim();
}

/**
 * Drafts a commit message with a one-shot query on haiku (cheap; the user edits the result). No tools, no settings
 * (so no hooks or MCP servers run), not saved as a session.
 */
export async function draftMessage(sdk: AgentSdkModule, claudePath: string, cwd: string): Promise<string> {
  const q = sdk.query({
    prompt: draftPrompt(draftContext(cwd)),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claudePath,
      model: "haiku",
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
    },
  });
  for await (const m of q) {
    if (m.type !== "result") continue;
    if (m.subtype !== "success") throw new Error(t("git.draft.failed", { subtype: m.subtype }));
    return cleanDraft(m.result);
  }
  throw new Error(t("git.draft.noResult"));
}
