import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { FileDiff, FileStatus, Hunk, WorkspaceFile, WorkspaceFiles } from "@agentchainer/protocol";
import { RpcErrorCode } from "@agentchainer/protocol";
import { RpcFailure } from "./rpc.ts";

/**
 * Workspace files, git status, diffs and reverts for the file tree and changes panel (M1-25…M1-27). Everything goes
 * through the system `git` CLI (ARCHITECTURE §2); paths from the UI are relative to the workspace and never leave it.
 */

/** Listing caps, so a huge repo can't flood the IPC channel. */
export const MAX_FILES = 20_000;
const MAX_WALK = 5_000;
/** Contents above this size aren't sent for diffing. */
export const MAX_DIFF_BYTES = 1_000_000;
/** Folders skipped when listing a folder that isn't a git repo. */
const WALK_SKIP = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "__pycache__"]);

type GitResult = { status: number | null; stdout: string; stderr: string };

/**
 * For the listing and the diff: git's status may rewrite `.git/index` to refresh file stats, and the file watcher
 * sees that as a change, so every refresh would trigger another (the diff view jumped back to the top). With this,
 * read-only calls don't write (VS Code does the same); the diff uses plumbing, which never refreshes the index.
 */
const READ = ["--no-optional-locks"];

export function git(
  args: string[],
  cwd: string,
  input?: string,
  opts: { env?: Record<string, string>; timeoutMs?: number } = {},
): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function gitOrThrow(args: string[], cwd: string, input?: string): string {
  const r = git(args, cwd, input);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/**
 * Resolves a workspace-relative path and rejects anything that would leave the workspace: absolute paths, `..`
 * segments, and symlinks are not followed here because git and fs operate on the path itself.
 */
export function insideWorkspace(cwd: string, rel: string): string {
  const parts = rel.split(/[\\/]+/);
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || parts.includes("..")) {
    throw new RpcFailure(RpcErrorCode.invalidParams, `Path must be inside the workspace: ${rel}`);
  }
  return path.join(cwd, ...parts);
}

type StatusEntry = { status: FileStatus; staged: boolean; unstaged: boolean; origPath?: string };

/** Parses `git status --porcelain=v1 -z`. Paths are relative to the repo root. */
export function parseStatus(z: string): Map<string, StatusEntry> {
  const entries = new Map<string, StatusEntry>();
  const fields = z.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue;
    const x = field[0] ?? " ";
    const y = field[1] ?? " ";
    const file = field.slice(3);
    if (x === "!") continue;
    // Renames and copies are followed by the original path as its own field.
    const origPath = x === "R" || x === "C" ? fields[++i] : undefined;
    entries.set(file, {
      status: statusOf(x, y),
      staged: x !== " " && x !== "?",
      unstaged: y !== " ",
      ...(origPath ? { origPath } : {}),
    });
  }
  return entries;
}

function statusOf(x: string, y: string): FileStatus {
  if (x === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) return "conflicted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

type RepoInfo = { top: string; prefix: string };

export function repoOf(cwd: string): RepoInfo | null {
  const r = git(["rev-parse", "--show-toplevel", "--show-prefix"], cwd);
  if (r.status !== 0) return null;
  const [top = "", prefix = ""] = r.stdout.split("\n");
  return { top, prefix };
}

/**
 * Status of files under `cwd`, keyed by path relative to `cwd`. Always for the whole folder: limited to one path,
 * git can't pair a rename's two sides and reports it as an added file.
 */
function statusUnder(cwd: string, repo: RepoInfo): Map<string, StatusEntry> {
  const raw = parseStatus(
    gitOrThrow([...READ, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], cwd),
  );
  const local = new Map<string, StatusEntry>();
  for (const [file, entry] of raw) {
    if (!file.startsWith(repo.prefix)) continue;
    const origPath = entry.origPath?.startsWith(repo.prefix) ? entry.origPath.slice(repo.prefix.length) : undefined;
    local.set(file.slice(repo.prefix.length), {
      status: entry.status,
      staged: entry.staged,
      unstaged: entry.unstaged,
      ...(origPath ? { origPath } : {}),
    });
  }
  return local;
}

function branchOf(cwd: string): string | null {
  const named = git(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
  if (named.status === 0) return named.stdout.trim();
  const sha = git(["rev-parse", "--short", "HEAD"], cwd);
  return sha.status === 0 ? `detached at ${sha.stdout.trim()}` : null;
}

/** Files of the workspace with their git status: tracked + untracked, minus ignored (M1-25). */
export function listFiles(cwd: string): WorkspaceFiles {
  if (!existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  const repo = repoOf(cwd);
  if (!repo) {
    const files = walk(cwd);
    return { isGitRepo: false, branch: null, files: files.slice(0, MAX_WALK), truncated: files.length > MAX_WALK };
  }
  const listed = gitOrThrow([...READ, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd)
    .split("\0")
    .filter(Boolean);
  const status = statusUnder(cwd, repo);
  const paths = new Set([...listed, ...status.keys()]);
  const files: WorkspaceFile[] = [...paths].sort().map((p) => {
    const s = status.get(p);
    return s ? { path: p, ...s } : { path: p };
  });
  return {
    isGitRepo: true,
    branch: branchOf(cwd),
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
  };
}

function walk(root: string): WorkspaceFile[] {
  const out: WorkspaceFile[] = [];
  const visit = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length > MAX_WALK) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) visit(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push({ path: childRel });
      }
    }
  };
  visit(root, "");
  return out;
}

/** HEAD vs working tree for one file, with its hunks for per-hunk revert (M1-27). */
export function fileDiff(cwd: string, rel: string): FileDiff {
  const abs = insideWorkspace(cwd, rel);
  const repo = repoOf(cwd);
  const entry = repo ? statusUnder(cwd, repo).get(rel) : undefined;
  const headPath = entry?.origPath ?? rel;
  const original = repo ? showHead(cwd, headPath) : null;
  const modified = existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs) : null;

  const tooLarge = (original?.length ?? 0) > MAX_DIFF_BYTES || (modified?.length ?? 0) > MAX_DIFF_BYTES;
  const binary = isBinary(original) || isBinary(modified);
  const text = !tooLarge && !binary;
  const hunks =
    text && original !== null && entry?.status !== "renamed"
      ? // Plumbing: porcelain `git diff HEAD` rewrites the index even with --no-optional-locks. Same hunks as the revert's.
        parseHunks(
          gitOrThrow([...READ, "diff-index", "-p", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", rel], cwd),
        )
      : [];
  return {
    path: rel,
    ...(entry ? { status: entry.status } : {}),
    original: text && original !== null ? original.toString("utf8") : null,
    modified: text && modified !== null ? modified.toString("utf8") : null,
    binary,
    tooLarge,
    hunks: hunks.map(({ lines: _lines, ...h }) => h),
  };
}

/** The file's content at HEAD, or null when it isn't in HEAD (new file, or a repo without commits). */
function showHead(cwd: string, rel: string): Buffer | null {
  const r = spawnSync("git", [...READ, "show", `HEAD:./${rel.split(path.sep).join("/")}`], {
    cwd,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

function isBinary(data: Buffer | null): boolean {
  return data?.subarray(0, 8000).includes(0) ?? false;
}

type ParsedHunk = Hunk & { lines: string[] };

/** Parses the hunks of a single-file `git diff -U0`. */
export function parseHunks(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  for (const line of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      current = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
    } else if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"))) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/**
 * Reverts a file to HEAD, or only one of its hunks (M1-27). A new file is deleted. The UI asks for confirmation first.
 */
export function revert(cwd: string, rel: string, hunk?: number): void {
  const abs = insideWorkspace(cwd, rel);
  const repo = repoOf(cwd);
  if (!repo) throw new RpcFailure(RpcErrorCode.invalidParams, "Reverting needs a git repository.");
  const entry = statusUnder(cwd, repo).get(rel);
  if (!entry) throw new RpcFailure(RpcErrorCode.invalidParams, `${rel} has no changes to revert.`);

  if (hunk !== undefined) {
    const diff = gitOrThrow(["diff", "--no-color", "--no-ext-diff", "-U0", "HEAD", "--", rel], cwd);
    const target = parseHunks(diff)[hunk];
    if (!target) throw new RpcFailure(RpcErrorCode.invalidParams, "That change no longer exists. Refresh the diff.");
    const header = diff.slice(0, diff.indexOf("\n@@") + 1);
    const patch = `${header}${target.header}\n${target.lines.join("\n")}\n`;
    // Patch paths are relative to the repo root, so apply from there. Only the working tree changes.
    gitOrThrow(["apply", "-R", "--unidiff-zero", "--whitespace=nowarn", "-"], repo.top, patch);
    return;
  }

  switch (entry.status) {
    case "untracked":
      rmSync(abs, { force: true });
      return;
    case "added":
      gitOrThrow(["rm", "-f", "-q", "--", rel], cwd);
      return;
    case "renamed":
      if (entry.origPath) gitOrThrow(["restore", "--source=HEAD", "--staged", "--worktree", "--", entry.origPath], cwd);
      gitOrThrow(["rm", "-f", "-q", "--", rel], cwd);
      return;
    default:
      gitOrThrow(["restore", "--source=HEAD", "--staged", "--worktree", "--", rel], cwd);
  }
}

/** Offered when the workspace isn't a git repository yet (M1-06). */
export function gitInit(cwd: string): void {
  if (!existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  if (repoOf(cwd)) throw new RpcFailure(RpcErrorCode.invalidParams, "This folder is already in a git repository.");
  gitOrThrow(["init", "-q"], cwd);
}
