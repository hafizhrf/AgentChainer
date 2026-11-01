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
  githubStatus,
  jobOf,
  MAX_LOG_CHARS,
  parseRemote,
  prChecks,
  redact,
} from "./github.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const done = (stdout = "", status = 0): GhResult => ({ status, stdout, stderr: "" });

/** A `gh` stand-in that is signed in to `hosts` and records its calls. */
function fakeGh(hosts: string[] = ["github.com"]): Gh & { calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
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

  it("is ready only with gh, an origin on GitHub, and a login for its host; it never asks for the token", () => {
    assert.deepEqual(githubStatus(repoWithOrigin("https://github.com/acme/app.git"), null), { state: "missing" });
    const gh = fakeGh();
    assert.deepEqual(githubStatus(repoWithOrigin("https://github.com/acme/app.git"), gh), {
      state: "ready",
      version: "2.103.3",
      host: "github.com",
      repo: "acme/app",
    });
    assert.equal(githubStatus(repoWithOrigin(""), gh).state, "no-remote");
    assert.equal(githubStatus(repoWithOrigin("https://gitlab.com/acme/app.git"), gh).state, "no-remote");
    assert.equal(githubStatus(repoWithOrigin("https://github.example.com/acme/app.git"), gh).state, "signed-out");
    assert.ok(gh.calls.every((c) => !c.includes("--show-token") && !c.includes("token")));
  });
});

describe("CI status and logs (M5-03)", () => {
  const answer =
    (r: GhResult): Gh =>
    () =>
      r;

  it("reads checks from the JSON even when gh exits non-zero for failing or pending checks", () => {
    const checks = [{ name: "test", workflow: "test", state: "FAILURE", bucket: "fail", link: "https://x/1" }];
    assert.deepEqual(prChecks(answer(done(JSON.stringify(checks), 1)), ".", 1), checks);
    assert.deepEqual(
      prChecks(answer({ status: 1, stdout: "", stderr: "no checks reported on the 'x' branch" }), ".", 1),
      [],
    );
    assert.throws(() => prChecks(answer({ status: 4, stdout: "", stderr: "HTTP 401" }), ".", 1), /HTTP 401/);
  });

  it("knows a GitHub Actions job from its check link, and nothing else", () => {
    assert.equal(jobOf("https://github.com/a/b/actions/runs/41297716998/job/124821994093"), "124821994093");
    assert.equal(jobOf("https://github.com/a/b/actions/runs/1/job/2?pr=3"), "2");
    assert.equal(jobOf("https://circleci.com/gh/a/b/123"), null);
  });

  it("keeps the log's end and masks secrets and emails, as diagnostics do", () => {
    assert.equal(
      redact("token=abc123def and ghp_0123456789abcdefghijABCD by dev@example.com in /home/u/app", "/home/u"),
      "token=[redacted] and [redacted token] by [email] in ~/app",
    );
    const long = `${"x".repeat(MAX_LOG_CHARS)}FAILED here`;
    const log = failedJobLog(answer(done(long)), ".", "2");
    assert.ok(log.length <= MAX_LOG_CHARS + 2 && log.endsWith("FAILED here") && log.startsWith("…"));
  });
});
