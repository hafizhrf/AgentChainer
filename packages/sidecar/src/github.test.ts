import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findGh, type Gh, type GhResult, githubStatus, parseRemote } from "./github.ts";

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
