import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  type GitHubStatus,
  type IssueSummary,
  type PrCheck,
  type ReviewThread,
  redactForLog,
} from "@agentchainer/protocol";
import { z } from "zod";
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

/**
 * A `gh` call that failed, with what `gh` said. When it was refused for its credentials while `GITHUB_TOKEN` or
 * `GH_TOKEN` is set (a shell profile can set it for the app too), it says so: gh uses that token before its own
 * login. Only whether the variable is set is looked at, never its value.
 */
export function ghFailed(command: string, r: GhResult, env: NodeJS.ProcessEnv = process.env): Error {
  const said = (r.stderr || r.stdout).trim() || `exit ${r.status}`;
  const refused = /\b401\b|bad credentials|authentication/i.test(said);
  const token = env.GH_TOKEN ? "GH_TOKEN" : env.GITHUB_TOKEN ? "GITHUB_TOKEN" : null;
  return commandFailed(command, refused && token ? `${said} ${t("git.gh.envToken", { name: token })}` : said);
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
  if (r.status !== 0) throw ghFailed("gh pr create", r);
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
  throw ghFailed("gh pr checks", r);
}

/** The state of the PR on GitHub, and the commit its head points at. */
export async function prState(
  gh: Gh,
  root: string,
  pr: number,
): Promise<{ state: string; draft: boolean; headSha: string }> {
  const r = await gh(["pr", "view", String(pr), "--json", "state,isDraft,headRefOid"], root);
  if (r.status !== 0) throw ghFailed("gh pr view", r);
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
  if (r.status !== 0) throw ghFailed("gh run view", r);
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
  if (r.status !== 0) throw ghFailed("gh repo view", r);
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
    if (ready.status !== 0) throw ghFailed("gh pr ready", ready);
  }
  const r = await gh(["pr", "merge", String(pr), `--${method}`, "--match-head-commit", headSha], root);
  if (r.status !== 0) throw ghFailed("gh pr merge", r);
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

/* ---------- A PR's review threads (CP-07) ---------- */

/** How many review threads, and comments a thread, are read; the UI says when there were more. */
export const MAX_REVIEW_THREADS = 100;
export const MAX_THREAD_COMMENTS = 50;

/**
 * The PR's review threads, with whether each is resolved or outdated: only GraphQL tells those. A fixed query with
 * typed variables, read-only (a GraphQL query is a POST, but this one changes nothing).
 */
const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${MAX_REVIEW_THREADS}) {
        totalCount
        nodes {
          id isResolved isOutdated path line startLine originalLine originalStartLine diffSide subjectType
          comments(first: ${MAX_THREAD_COMMENTS}) {
            totalCount
            nodes { author { login } body createdAt url diffHunk }
          }
        }
      }
    }
  }
}`;

const ThreadsAnswer = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            reviewThreads: z.object({
              totalCount: z.number(),
              nodes: z.array(
                z.object({
                  id: z.string(),
                  isResolved: z.boolean(),
                  isOutdated: z.boolean(),
                  path: z.string(),
                  line: z.number().nullable(),
                  startLine: z.number().nullable(),
                  originalLine: z.number().nullable(),
                  originalStartLine: z.number().nullable(),
                  diffSide: z.enum(["LEFT", "RIGHT"]),
                  subjectType: z.enum(["LINE", "FILE"]).nullable().optional(),
                  comments: z.object({
                    totalCount: z.number(),
                    nodes: z.array(
                      z.object({
                        author: z.object({ login: z.string() }).nullable(),
                        body: z.string(),
                        createdAt: z.string(),
                        url: z.string(),
                        diffHunk: z.string(),
                      }),
                    ),
                  }),
                }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

/**
 * The last `count` lines of one side of a diff hunk (the commented ones; GitHub's hunk ends at the comment's line),
 * without their +, − or space: the new side leaves the removed lines out, the old side the added ones.
 */
export function hunkTail(hunk: string, count: number, side: "new" | "old" = "new"): string {
  const other = side === "new" ? "-" : "+";
  const lines = hunk.split("\n").filter((l) => !l.startsWith("@@") && !l.startsWith(other));
  return lines
    .slice(-Math.max(1, count))
    .map((l) => (/^[+\- ]/.test(l) ? l.slice(1) : l))
    .join("\n");
}

/**
 * GitHub's answer as review threads: paths made relative to the task's code folder (the repository's `prefix`), a
 * thread outside it left out; outdated ones on their original lines; every comment redacted.
 */
export function threadsOf(json: unknown, prefix = "", home = homedir()): { threads: ReviewThread[]; capped: boolean } {
  const parsed = ThreadsAnswer.safeParse(json);
  const answer = parsed.success ? parsed.data.data.repository?.pullRequest?.reviewThreads : undefined;
  if (!answer) throw new Error(t("git.review.unreadable"));
  let capped = answer.totalCount > answer.nodes.length;
  const threads: ReviewThread[] = [];
  for (const n of answer.nodes) {
    if (prefix && !n.path.startsWith(prefix)) continue;
    capped ||= n.comments.totalCount > n.comments.nodes.length;
    const end = n.line ?? n.originalLine ?? undefined;
    const start = (n.line !== null ? n.startLine : n.originalStartLine) ?? end;
    const fileLevel = n.subjectType === "FILE" || end === undefined;
    const first = n.comments.nodes[0];
    threads.push({
      id: n.id,
      path: n.path.slice(prefix.length),
      side: n.diffSide === "LEFT" ? "old" : "new",
      ...(fileLevel || start === undefined ? {} : { start, end }),
      resolved: n.isResolved,
      outdated: n.isOutdated,
      fileLevel,
      quote:
        fileLevel || !first || start === undefined || end === undefined
          ? ""
          : hunkTail(first.diffHunk, end - start + 1, n.diffSide === "LEFT" ? "old" : "new"),
      comments: n.comments.nodes.map((c) => ({
        author: c.author?.login ?? "ghost",
        body: redact(c.body, home),
        createdAt: c.createdAt,
        url: c.url,
      })),
    });
  }
  // Unresolved first, in GitHub's order.
  threads.sort((a, b) => Number(a.resolved) - Number(b.resolved));
  return { threads, capped };
}

/** The PR's review threads, through the person's `gh`, on the host and repository of `root`'s origin. */
export async function reviewThreads(
  gh: Gh,
  root: string,
  number: number,
  prefix = "",
): Promise<{ threads: ReviewThread[]; capped: boolean }> {
  const url = git(["remote", "get-url", "origin"], root).stdout.trim();
  const remote = url ? parseRemote(url) : null;
  const [owner, name] = remote?.repo.split("/") ?? [];
  if (!remote || !owner || !name) throw new Error(t("git.review.noRemote"));
  // `-f` passes the names as plain strings (never read as a file or a number); `-F` types the PR number.
  const r = await gh(
    [
      "api",
      "graphql",
      "--hostname",
      remote.host,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${number}`,
      "-f",
      `query=${REVIEW_THREADS_QUERY}`,
    ],
    root,
  );
  if (r.status !== 0) throw ghFailed("gh api graphql", r);
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(t("git.review.unreadable"));
  }
  return threadsOf(json, prefix);
}

/* ---------- The repository's issues (CP-08) ---------- */

/** How many open issues the picker lists, and how much of an issue's text drafting reads. */
export const MAX_ISSUES = 50;
export const MAX_ISSUE_CHARS = 12_000;

/** The origin's repository as `gh -R` takes it: `host/owner/name`. */
function originRepo(root: string): string {
  const url = git(["remote", "get-url", "origin"], root).stdout.trim();
  const remote = url ? parseRemote(url) : null;
  if (!remote) throw new Error(t("git.review.noRemote"));
  return `${remote.host}/${remote.repo}`;
}

const IssueList = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    labels: z.array(z.object({ name: z.string() })).default([]),
    author: z.object({ login: z.string() }).nullable().optional(),
    updatedAt: z.string(),
    url: z.string(),
  }),
);

/** The open issues of `root`'s origin repository, newest first, matching `search` when given (gh's own search). */
export async function openIssues(
  gh: Gh,
  root: string,
  search?: string,
): Promise<{ issues: IssueSummary[]; capped: boolean }> {
  const args = [
    "issue",
    "list",
    "-R",
    originRepo(root),
    "--state",
    "open",
    // One more than shown tells whether there were more.
    "--limit",
    String(MAX_ISSUES + 1),
    "--json",
    "number,title,labels,author,updatedAt,url",
    ...(search?.trim() ? ["--search", search.trim()] : []),
  ];
  const r = await gh(args, root);
  if (r.status !== 0) throw ghFailed("gh issue list", r);
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(t("git.issues.unreadable"));
  }
  const parsed = IssueList.safeParse(json);
  if (!parsed.success) throw new Error(t("git.issues.unreadable"));
  const issues = parsed.data.slice(0, MAX_ISSUES).map((i) => ({
    number: i.number,
    title: i.title,
    labels: i.labels.map((l) => l.name),
    author: i.author?.login ?? "ghost",
    updatedAt: i.updatedAt,
    url: i.url,
  }));
  return { issues, capped: parsed.data.length > MAX_ISSUES };
}

const IssueView = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable().default(""),
  url: z.string(),
  state: z.string(),
  author: z.object({ login: z.string() }).nullable().optional(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  comments: z
    .array(z.object({ author: z.object({ login: z.string() }).nullable().optional(), body: z.string() }))
    .default([]),
});

/**
 * One issue of `root`'s origin repository, for drafting (CP-08): its header, its body and its latest comments, all
 * redacted, within `MAX_ISSUE_CHARS` (the body first, then comments from the newest back). Written by anyone who can
 * open an issue, so it only ever reaches drafting, as data.
 */
export async function readIssue(
  gh: Gh,
  root: string,
  number: number,
  home = homedir(),
): Promise<{ number: number; title: string; url: string; context: string; capped: boolean }> {
  if (!Number.isInteger(number) || number <= 0) throw new Error(t("git.issues.badNumber"));
  const r = await gh(
    [
      "issue",
      "view",
      String(number),
      "-R",
      originRepo(root),
      "--json",
      "number,title,body,url,state,author,labels,comments",
    ],
    root,
  );
  if (r.status !== 0) throw ghFailed("gh issue view", r);
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(t("git.issues.unreadable"));
  }
  const parsed = IssueView.safeParse(json);
  if (!parsed.success) throw new Error(t("git.issues.unreadable"));
  const i = parsed.data;
  return { number: i.number, title: i.title, url: i.url, ...issueContext(i, home) };
}

/** An issue as drafting reads it: header, body, then as many of the newest comments as fit, in their order. */
export function issueContext(i: z.infer<typeof IssueView>, home = homedir()): { context: string; capped: boolean } {
  const labels = i.labels.map((l) => l.name);
  const head = [
    `Issue #${i.number}: ${i.title}`,
    `State: ${i.state.toLowerCase()}${labels.length ? ` · Labels: ${labels.join(", ")}` : ""} · Opened by ${i.author?.login ?? "ghost"}`,
  ].join("\n");
  const body = redact((i.body ?? "").trim() || "(no description)", home);
  // Room for the comments' heading, so the whole stays within the cap.
  const limit = MAX_ISSUE_CHARS - 100;
  let text = `${head}\n\n${body}`;
  let capped = false;
  if (text.length > limit) return { context: `${text.slice(0, limit - 1)}…`, capped: true };
  const kept: string[] = [];
  for (const c of [...i.comments].reverse()) {
    const said = `${c.author?.login ?? "ghost"}: ${redact(c.body.trim(), home)}`;
    const next = `\n\n---\n${said}`;
    if (text.length + next.length + kept.join("").length > limit) {
      capped = true;
      break;
    }
    kept.unshift(next);
  }
  if (kept.length)
    text += `\n\nComments (${kept.length < i.comments.length ? `the latest ${kept.length} of ${i.comments.length}` : kept.length}):${kept.join("")}`;
  return { context: text, capped };
}
