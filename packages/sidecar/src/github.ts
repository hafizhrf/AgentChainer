import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type GitHubStatus, type PrCheck, redactForLog } from "@agentchainer/protocol";
import { t } from "./i18n/index.ts";
import { runAsync } from "./run-async.ts";
import { commandFailed, git } from "./workspace.ts";

/**
 * GitHub through the user's own `gh` CLI (M5-02, docs/design/git-workflow.md §4). Like the `claude` CLI (ADR-0002),
 * the user installs it and signs in themselves; the app only runs fixed commands with it. It never passes
 * `--show-token`, never reads `gh`'s config or credentials, and never runs it through a shell.
 */

export type GhResult = { status: number | null; stdout: string; stderr: string };
/**
 * Runs `gh` with an argument array in `cwd`, without blocking the sidecar: its calls go over the network (`runAsync`).
 * Tests pass a stand-in.
 */
export type Gh = (args: string[], cwd: string) => Promise<GhResult>;

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
  return (args, cwd) =>
    runAsync(binary, args, {
      cwd,
      timeoutMs,
      env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1" },
    });
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
export async function githubStatus(root: string, gh: Gh | null): Promise<GitHubStatus> {
  if (!gh) return { state: "missing" };
  const v = await gh(["--version"], root);
  if (v.status !== 0) return { state: "missing" };
  const version = /gh version (\S+)/.exec(v.stdout)?.[1];
  const base = version ? { version } : {};
  const url = git(["remote", "get-url", "origin"], root).stdout.trim();
  const remote = url ? parseRemote(url) : null;
  if (!remote) return { state: "no-remote", ...base };
  const signedIn = (await (await gh(["auth", "status", "--hostname", remote.host], root)).status) === 0;
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
export async function findPr(gh: Gh, root: string, branch: string): Promise<PrView | null> {
  const r = await gh(["pr", "view", branch, "--json", PR_FIELDS], root);
  if (r.status !== 0) return null;
  const pr = JSON.parse(r.stdout) as PrView;
  return pr.state === "OPEN" ? pr : null;
}

/** Opens a PR from `head` into `base`, with the body read from a file; returns it as `gh pr view` shows it. */
export async function createPr(
  gh: Gh,
  root: string,
  pr: { base: string; head: string; title: string; bodyFile: string; draft: boolean },
): Promise<PrView> {
  const args = ["pr", "create", "--base", pr.base, "--head", pr.head, "--title", pr.title, "--body-file", pr.bodyFile];
  const r = await gh(pr.draft ? [...args, "--draft"] : args, root);
  if (r.status !== 0) throw commandFailed("gh pr create", (r.stderr || r.stdout).trim() || `exit ${r.status}`);
  const made = await findPr(gh, root, pr.head);
  if (!made) throw new Error(t("git.github.unreadablePr", { output: r.stdout.trim() }));
  return made;
}

/**
 * The PR's checks. `gh pr checks` exits non-zero while checks fail (1) or are pending (8), and says "no checks
 * reported" when there are none, so the JSON on stdout is what counts.
 */
export async function prChecks(gh: Gh, root: string, pr: number): Promise<PrCheck[]> {
  const r = await gh(
    ["pr", "checks", String(pr), "--json", "name,workflow,state,bucket,link,startedAt,completedAt"],
    root,
  );
  const out = r.stdout.trim();
  if (out.startsWith("[")) return JSON.parse(out) as PrCheck[];
  if (/no checks reported/i.test(r.stderr)) return [];
  throw commandFailed("gh pr checks", (r.stderr || r.stdout).trim() || `exit ${r.status}`);
}

/** The state of the PR on GitHub, and the commit its head points at. */
export async function prState(
  gh: Gh,
  root: string,
  pr: number,
): Promise<{ state: string; draft: boolean; headSha: string }> {
  const r = await gh(["pr", "view", String(pr), "--json", "state,isDraft,headRefOid"], root);
  if (r.status !== 0) throw commandFailed("gh pr view", (r.stderr || r.stdout).trim() || `exit ${r.status}`);
  const v = JSON.parse(r.stdout) as { state: string; isDraft: boolean; headRefOid: string };
  return { state: v.state, draft: v.isDraft, headSha: v.headRefOid };
}

/** A GitHub Actions job's id from a check's link (`…/actions/runs/<run>/job/<job>`), or null for other CI. */
export function jobOf(link: string): string | null {
  return /\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(link)?.[1] ?? null;
}

/** Secrets and personal details masked, as everywhere else (X-03, `redactForLog` in the protocol package). */
export const redact = (text: string, home = homedir()): string => redactForLog(text, home);

/** CI logs can be long; the end holds the failure. */
export const MAX_LOG_CHARS = 32_000;

/**
 * The failed steps' log of one GitHub Actions job: its last `MAX_LOG_CHARS` characters, redacted. It is untrusted text
 * from whoever can change the repository, so it goes to Claude as data only (design §6, T-02).
 */
export async function failedJobLog(gh: Gh, root: string, job: string): Promise<string> {
  const r = await gh(["run", "view", "--job", job, "--log-failed"], root);
  if (r.status !== 0) throw commandFailed("gh run view", (r.stderr || r.stdout).trim() || `exit ${r.status}`);
  const log = r.stdout.length > MAX_LOG_CHARS ? `…\n${r.stdout.slice(-MAX_LOG_CHARS)}` : r.stdout;
  return redact(log);
}

type Method = "merge" | "squash" | "rebase";

/** The merge methods the repository allows, and the one GitHub would pick for this user. */
export async function mergeMethods(gh: Gh, root: string): Promise<{ methods: Method[]; defaultMethod: Method }> {
  const r = await gh(
    ["repo", "view", "--json", "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,viewerDefaultMergeMethod"],
    root,
  );
  if (r.status !== 0) throw commandFailed("gh repo view", (r.stderr || r.stdout).trim() || `exit ${r.status}`);
  const v = JSON.parse(r.stdout) as {
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    viewerDefaultMergeMethod: string;
  };
  const methods: Method[] = [
    ...(v.mergeCommitAllowed ? ["merge" as const] : []),
    ...(v.squashMergeAllowed ? ["squash" as const] : []),
    ...(v.rebaseMergeAllowed ? ["rebase" as const] : []),
  ];
  const named = v.viewerDefaultMergeMethod.toLowerCase();
  const preferred = methods.find((m) => named.startsWith(m)) ?? methods[0] ?? "merge";
  return { methods, defaultMethod: preferred };
}

/**
 * Merges the PR, a person's decision (M5-05): marks a draft ready first, then `gh pr merge` with the head the gates
 * were worked out for, so a newer push fails the merge instead of slipping in. Never `--auto`.
 */
export async function mergePullRequest(
  gh: Gh,
  root: string,
  pr: number,
  method: Method,
  headSha: string,
  draft: boolean,
): Promise<void> {
  if (draft) {
    const ready = await gh(["pr", "ready", String(pr)], root);
    if (ready.status !== 0) throw commandFailed("gh pr ready", (ready.stderr || ready.stdout).trim());
  }
  const r = await gh(["pr", "merge", String(pr), `--${method}`, "--match-head-commit", headSha], root);
  if (r.status !== 0) throw commandFailed("gh pr merge", (r.stderr || r.stdout).trim() || `exit ${r.status}`);
}

/**
 * Git settings that make one `git push` to a GitHub host use the user's `gh` login, as `gh auth setup-git` would
 * configure for good: the helper list is cleared for this command, then `gh auth git-credential` answers for that host.
 * The app never sees the token; `gh` hands it to git. Null without `gh` or for a remote elsewhere.
 */
export function ghCredentialConfig(root: string, binary = findGh()): string[] | null {
  if (!binary) return null;
  const url = git(["remote", "get-url", "origin"], root).stdout.trim();
  // An ssh remote uses the user's ssh keys, not a credential helper.
  const remote = /^https?:/.test(url) ? parseRemote(url) : null;
  if (!remote) return null;
  const helper = `!"${binary.replace(/\\/g, "/")}" auth git-credential`;
  return ["credential.helper=", `credential.https://${remote.host}.helper=${helper}`];
}
