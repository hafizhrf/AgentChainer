import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { GitHubStatus, PrCheck } from "@agentchainer/protocol";
import { git } from "./workspace.ts";

/**
 * GitHub through the user's own `gh` CLI (M5-02, docs/design/git-workflow.md §4). Like the `claude` CLI (ADR-0002),
 * the user installs it and signs in themselves; the app only runs fixed commands with it. It never passes
 * `--show-token`, never reads `gh`'s config or credentials, and never runs it through a shell.
 */

export type GhResult = { status: number | null; stdout: string; stderr: string };
/** Runs `gh` with an argument array in `cwd`. Tests pass a stand-in. */
export type Gh = (args: string[], cwd: string) => GhResult;

type Platform = NodeJS.Platform;

/** The user's `gh`: on PATH, then where its installers put it. */
export function findGh(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const local = env.LOCALAPPDATA ?? p.join(home, "AppData", "Local");
    return (
      [...dirs, p.join(programFiles, "GitHub CLI"), p.join(local, "Programs", "GitHub CLI")]
        .map((d) => p.join(d, "gh.exe"))
        .find(exists) ?? null
    );
  }
  const known = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", p.join(home, ".local", "bin", "gh")];
  return [...dirs.map((d) => p.join(d, "gh")), ...known].find(exists) ?? null;
}

/** Never prompts (there is no terminal to answer), no colour or update notices in the output, and a timeout. */
export function ghRunner(binary: string, timeoutMs = 60_000): Gh {
  return (args, cwd) => {
    const r = spawnSync(binary, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        NO_COLOR: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_SPINNER_DISABLED: "1",
      },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
  };
}

export function systemGh(): Gh | null {
  const binary = findGh();
  return binary ? ghRunner(binary) : null;
}

/** The host and `owner/name` of a remote URL: https, `git@host:owner/name` or `ssh://`. Null for anything else. */
export function parseRemote(url: string): { host: string; repo: string } | null {
  const m =
    /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^[^@\s]+@([^:\s]+):([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m?.[1] && m[2] ? { host: m[1].toLowerCase(), repo: m[2] } : null;
}

/**
 * Whether pull requests can be made for `root`: `gh` installed, an `origin` on a GitHub host, and a `gh` login for
 * that host (`gh auth status --hostname`, whose output is dropped: it names the account).
 */
export function githubStatus(root: string, gh: Gh | null): GitHubStatus {
  if (!gh) return { state: "missing" };
  const v = gh(["--version"], root);
  if (v.status !== 0) return { state: "missing" };
  const version = /gh version (\S+)/.exec(v.stdout)?.[1];
  const base = version ? { version } : {};
  const url = git(["remote", "get-url", "origin"], root).stdout.trim();
  const remote = url ? parseRemote(url) : null;
  if (!remote) return { state: "no-remote", ...base };
  const signedIn = gh(["auth", "status", "--hostname", remote.host], root).status === 0;
  if (!signedIn && !remote.host.includes("github")) return { state: "no-remote", ...base };
  return { state: signedIn ? "ready" : "signed-out", ...base, host: remote.host, repo: remote.repo };
}

const PR_FIELDS = "number,url,isDraft,headRefOid,baseRefName,headRefName,state";
type PrView = {
  number: number;
  url: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
  state: string;
};

/** The open PR whose head is `branch`, or null. */
export function findPr(gh: Gh, root: string, branch: string): PrView | null {
  const r = gh(["pr", "view", branch, "--json", PR_FIELDS], root);
  if (r.status !== 0) return null;
  const pr = JSON.parse(r.stdout) as PrView;
  return pr.state === "OPEN" ? pr : null;
}

/** Opens a PR from `head` into `base`, with the body read from a file; returns it as `gh pr view` shows it. */
export function createPr(
  gh: Gh,
  root: string,
  pr: { base: string; head: string; title: string; bodyFile: string; draft: boolean },
): PrView {
  const args = ["pr", "create", "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", pr.bodyFile];
  const r = gh(pr.draft ? [...args, "--draft"] : args, root);
  if (r.status !== 0) throw new Error(`gh pr create failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
  const made = findPr(gh, root, pr.head);
  if (!made) throw new Error(`gh made the pull request, but it can't be read back: ${r.stdout.trim()}`);
  return made;
}

/**
 * The PR's checks. `gh pr checks` exits non-zero while checks fail (1) or are pending (8), and says "no checks
 * reported" when there are none, so the JSON on stdout is what counts.
 */
export function prChecks(gh: Gh, root: string, pr: number): PrCheck[] {
  const r = gh(["pr", "checks", String(pr), "--json", "name,workflow,state,bucket,link,startedAt,completedAt"], root);
  const out = r.stdout.trim();
  if (out.startsWith("[")) return JSON.parse(out) as PrCheck[];
  if (/no checks reported/i.test(r.stderr)) return [];
  throw new Error(`gh pr checks failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
}

/** The state of the PR on GitHub, and the commit its head points at. */
export function prState(gh: Gh, root: string, pr: number): { state: string; draft: boolean; headSha: string } {
  const r = gh(["pr", "view", String(pr), "--json", "state,isDraft,headRefOid"], root);
  if (r.status !== 0) throw new Error(`gh pr view failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
  const v = JSON.parse(r.stdout) as { state: string; isDraft: boolean; headRefOid: string };
  return { state: v.state, draft: v.isDraft, headSha: v.headRefOid };
}

/** A GitHub Actions job's id from a check's link (`…/actions/runs/<run>/job/<job>`), or null for other CI. */
export function jobOf(link: string): string | null {
  return /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(link)?.[1] ?? null;
}

/** Secrets and personal details masked, as in the diagnostics bundle (`diagnostics.rs`). */
const REDACT: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted key]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[redacted key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [
    /\b([A-Z0-9_]*(?:api[_-]?key|token|secret|password|passwd|credential)[A-Z0-9_]*)(\\?"?\s*[:=]\s*\\?"?)[^\s"',\\]*[^\s"',\\0-9][^\s"',\\]*/gi,
    "$1$2[redacted]",
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/g, "[email]"],
];

export function redact(text: string, home = homedir()): string {
  let out = home.length > 1 ? text.split(home).join("~") : text;
  for (const [re, to] of REDACT) out = out.replace(re, to);
  return out;
}

/** CI logs can be long; the end holds the failure. */
export const MAX_LOG_CHARS = 32_000;

/**
 * The failed steps' log of one GitHub Actions job: its last `MAX_LOG_CHARS` characters, redacted. It is untrusted text
 * from whoever can change the repository, so it goes to Claude as data only (design §6, T-02).
 */
export function failedJobLog(gh: Gh, root: string, job: string): string {
  const r = gh(["run", "view", "--job", job, "--log-failed"], root);
  if (r.status !== 0) throw new Error(`gh run view failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
  const log = r.stdout.length > MAX_LOG_CHARS ? `…\n${r.stdout.slice(-MAX_LOG_CHARS)}` : r.stdout;
  return redact(log);
}
