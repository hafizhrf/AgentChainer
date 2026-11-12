import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  failedJobLog,
  findGh,
  type Gh,
  type GhResult,
  ghCredentialConfig,
  githubStatus,
  hunkTail,
  jobOf,
  MAX_LOG_CHARS,
  parseRemote,
  prChecks,
  redact,
  reviewThreads,
  threadsOf,
} from "./github.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const done = (stdout = "", status = 0): GhResult => ({ status, stdout, stderr: "" });

/** A `gh` stand-in that is signed in to `hosts` and records its calls. */
function fakeGh(hosts: string[] = ["github.com"]): Gh & { calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    if (args[0] === "--version") return done("gh version 2.103.3 (2026-10-26)\n");
    if (args[0] === "auth") return done("", hosts.includes(args[3] ?? "") ? 0 : 1);
    return done("", 1);
  };
  return Object.assign(gh, { calls });
}

const repoWithOrigin = (url: string) => {
  const dir = mkdtempSync(join(tmpdir(), "ac-gh-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (url) execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
  return dir;
};

describe("GitHub through the user's gh (M5-02)", () => {
  it("finds gh on PATH, then where its installers put it", () => {
    const has = (files: string[]) => (p: string) => files.includes(p);
    assert.equal(findGh({ PATH: "/usr/bin:/bin" }, "linux", "/home/u", has(["/usr/bin/gh"])), "/usr/bin/gh");
    assert.equal(
      findGh(
        { Path: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
        "win32",
        "C:\\Users\\u",
        has(["C:\\Program Files\\GitHub CLI\\gh.exe"]),
      ),
      "C:\\Program Files\\GitHub CLI\\gh.exe",
    );
    assert.equal(findGh({ PATH: "" }, "darwin", "/Users/u", has([])), null);
  });

  it("reads the host and owner/name from https, scp-style and ssh remotes", () => {
    assert.deepEqual(parseRemote("https://github.com/acme/app.git"), { host: "github.com", repo: "acme/app" });
    assert.deepEqual(parseRemote("git@github.com:acme/app.git"), { host: "github.com", repo: "acme/app" });
    assert.deepEqual(parseRemote("ssh://git@GitHub.example.com:2222/acme/app"), {
      host: "github.example.com",
      repo: "acme/app",
    });
    assert.equal(parseRemote("/srv/git/app.git"), null);
  });

  it("is ready only with gh, an origin on GitHub, and a login for its host; it never asks for the token", async () => {
    assert.deepEqual(await githubStatus(repoWithOrigin("https://github.com/acme/app.git"), null), { state: "missing" });
    const gh = fakeGh();
    assert.deepEqual(await githubStatus(repoWithOrigin("https://github.com/acme/app.git"), gh), {
      state: "ready",
      version: "2.103.3",
      host: "github.com",
      repo: "acme/app",
    });
    assert.equal((await githubStatus(repoWithOrigin(""), gh)).state, "no-remote");
    assert.equal((await githubStatus(repoWithOrigin("https://gitlab.com/acme/app.git"), gh)).state, "no-remote");
    assert.equal(
      (await githubStatus(repoWithOrigin("https://github.example.com/acme/app.git"), gh)).state,
      "signed-out",
    );
    assert.ok(gh.calls.every((c) => !c.includes("--show-token") && !c.includes("token")));
  });
});

describe("pushing with the user's gh login", () => {
  it("makes gh the credential helper for an https GitHub remote, for one command, and nothing for ssh", () => {
    assert.deepEqual(
      ghCredentialConfig(repoWithOrigin("https://github.com/acme/app.git"), "C:\\Program Files\\GitHub CLI\\gh.exe"),
      [
        "credential.helper=",
        'credential.https://github.com.helper=!"C:/Program Files/GitHub CLI/gh.exe" auth git-credential',
      ],
    );
    assert.equal(ghCredentialConfig(repoWithOrigin("git@github.com:acme/app.git"), "/usr/bin/gh"), null);
    assert.equal(ghCredentialConfig(repoWithOrigin("https://github.com/acme/app.git"), null), null);
  });
});

describe("CI status and logs (M5-03)", () => {
  const answer =
    (r: GhResult): Gh =>
    async () =>
      r;

  it("reads checks from the JSON even when gh exits non-zero for failing or pending checks", async () => {
    const checks = [{ name: "test", workflow: "test", state: "FAILURE", bucket: "fail", link: "https://x/1" }];
    assert.deepEqual(await prChecks(answer(done(JSON.stringify(checks), 1)), ".", 1), checks);
    assert.deepEqual(
      await prChecks(answer({ status: 1, stdout: "", stderr: "no checks reported on the 'x' branch" }), ".", 1),
      [],
    );
    await assert.rejects(prChecks(answer({ status: 4, stdout: "", stderr: "HTTP 401" }), ".", 1), /HTTP 401/);
  });

  it("knows a GitHub Actions job from its check link, and nothing else", () => {
    assert.equal(jobOf("https://github.com/a/b/actions/runs/41297716998/job/124821994093"), "124821994093");
    assert.equal(jobOf("https://github.com/a/b/actions/runs/1/job/2?pr=3"), "2");
    assert.equal(jobOf("https://circleci.com/gh/a/b/123"), null);
  });

  it("keeps the log's end and masks secrets and emails, as diagnostics do", async () => {
    assert.equal(
      redact("token=abc123def and ghp_0123456789abcdefghijABCD by dev@example.com in /home/u/app", "/home/u"),
      "token=[redacted] and [redacted token] by [email] in ~/app",
    );
    const long = `${"x".repeat(MAX_LOG_CHARS)}FAILED here`;
    const log = await failedJobLog(answer(done(long)), ".", "2");
    assert.ok(log.length <= MAX_LOG_CHARS + 2 && log.endsWith("FAILED here") && log.startsWith("…"));
  });
});

describe("a PR's review threads (CP-07)", () => {
  const comment = (body: string, hunk = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c") => ({
    author: { login: "octocat" },
    body,
    createdAt: "2026-11-12T00:00:00Z",
    url: "https://github.com/acme/app/pull/7#discussion_r1",
    diffHunk: hunk,
  });
  const thread = (over: Record<string, unknown>) => ({
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/cart.js",
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    diffSide: "RIGHT",
    subjectType: "LINE",
    comments: { totalCount: 1, nodes: [comment("Use cents here.")] },
    ...over,
  });
  // Shaped like GitHub's GraphQL answer for pullRequest.reviewThreads.
  const answer = (nodes: unknown[], totalCount = nodes.length) => ({
    data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } },
  });

  it("reads each thread's lines, side, quote and comments, unresolved first", () => {
    const { threads, capped } = threadsOf(
      answer([
        thread({ id: "resolved", isResolved: true }),
        thread({ id: "range", startLine: 1, line: 2 }),
        thread({ id: "left", diffSide: "LEFT", line: 2 }),
        thread({ id: "file", subjectType: "FILE", line: null, originalLine: null }),
      ]),
    );
    assert.equal(capped, false);
    assert.deepEqual(
      threads.map((t) => [t.id, t.side, t.start, t.end, t.fileLevel, t.resolved]),
      [
        ["range", "new", 1, 2, false, false],
        ["left", "old", 2, 2, false, false],
        ["file", "new", undefined, undefined, true, false],
        ["resolved", "new", 2, 2, false, true],
      ],
    );
    assert.equal(threads[0]?.quote, "B\nc", "the new side's last lines, without the removed one");
    assert.equal(threads[1]?.quote, "c", "the old side's last line");
    assert.deepEqual(threads[0]?.comments[0], {
      author: "octocat",
      body: "Use cents here.",
      createdAt: "2026-11-12T00:00:00Z",
      url: "https://github.com/acme/app/pull/7#discussion_r1",
    });
  });

  it("keeps an outdated thread on its original lines, and redacts what reviewers wrote", () => {
    const [outdated] = threadsOf(
      answer([
        thread({
          isOutdated: true,
          line: null,
          originalLine: 3,
          comments: { totalCount: 1, nodes: [comment("Token ghp_0123456789abcdefghijABCD0123456789 leaked here")] },
        }),
      ]),
      "",
      "/Users/me",
    ).threads;
    assert.deepEqual([outdated?.outdated, outdated?.start, outdated?.end], [true, 3, 3]);
    assert.doesNotMatch(outdated?.comments[0]?.body ?? "", /ghp_0123/);
  });

  it("makes paths relative to the workspace's folder in the repository, and leaves the rest out", () => {
    const { threads } = threadsOf(
      answer([thread({ id: "in", path: "apps/web/src/a.ts" }), thread({ id: "out", path: "api/b.ts" })]),
      "apps/web/",
    );
    assert.deepEqual(
      threads.map((t) => [t.id, t.path]),
      [["in", "src/a.ts"]],
    );
  });

  it("says when there were more threads or comments than it read, and refuses an answer it can't read", () => {
    assert.equal(threadsOf(answer([thread({})], 101)).capped, true);
    assert.equal(threadsOf(answer([thread({ comments: { totalCount: 60, nodes: [comment("x")] } })])).capped, true);
    assert.throws(() => threadsOf({ data: { repository: null } }), /couldn't be read/);
    assert.equal(hunkTail("@@ -1 +1 @@\n-old\n+new", 1), "new");
    assert.equal(hunkTail("@@ -1 +1 @@\n-old\n+new", 1, "old"), "old");
  });

  it("asks gh with the names as plain strings and the number typed, on the origin's host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-review-"));
    dirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/app.git"], { cwd: dir });
    let asked: string[] = [];
    const gh: Gh = async (args) => {
      asked = args;
      return { status: 0, stdout: JSON.stringify(answer([thread({})])), stderr: "" };
    };
    const { threads } = await reviewThreads(gh, dir, 7);
    assert.equal(threads.length, 1);
    assert.deepEqual(asked.slice(0, 10), [
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      "owner=acme",
      "-f",
      "name=app",
      "-F",
      "number=7",
    ]);
    assert.match(asked[11] ?? "", /^query=query\(\$owner: String!/);
  });
});
