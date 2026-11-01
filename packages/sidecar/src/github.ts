import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { GitHubStatus } from "@agentchainer/protocol";
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
