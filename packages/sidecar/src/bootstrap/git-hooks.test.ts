import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse } from "yaml";
import { APP_ID, type HookFile, hookChanges, hookSetup } from "./git-hooks.ts";

/** Pre-commit hooks through the repo's hook manager, or a local git hook (M2-22). */

const work = mkdtempSync(join(tmpdir(), "ac-hooks-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
function repo(files: Record<string, string> = {}): string {
  const dir = join(work, `repo-${n++}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const hook = { id: "gitleaks", run: ["{binary}", "git", "--pre-commit", "--staged", "--redact", "--no-banner"] };
const tool = { id: "gitleaks", name: "gitleaks", version: "8.30.1", binary: "/Users/me/App Support/tools/gitleaks" };
const byPath = (files: HookFile[]) => new Map(files.map((f) => [f.path, f]));

describe("hookSetup", () => {
  it("picks the repo's hook manager, or a local hook when there is none", () => {
    assert.deepEqual(hookSetup(repo({ "lefthook.yml": "" })), { manager: "lefthook" });
    assert.deepEqual(hookSetup(repo({ ".pre-commit-config.yaml": "repos: []\n" })), { manager: "pre-commit" });
    assert.deepEqual(hookSetup(repo({ ".husky/pre-commit": "npx lint-staged\n" })), { manager: "husky" });
    assert.deepEqual(hookSetup(repo()), { manager: "local" });
  });

  it("explains when it can't add a hook", () => {
    const plain = join(work, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    assert.match(String((hookSetup(plain) as { reason: string }).reason), /Not a git repository/);

    const foreign = repo({ ".git/hooks/pre-commit": "#!/bin/sh\nmake lint\n" });
    assert.match(String((hookSetup(foreign) as { reason: string }).reason), /already a pre-commit hook/);

    const custom = repo();
    execFileSync("git", ["config", "core.hooksPath", "githooks"], { cwd: custom });
    assert.match(String((hookSetup(custom) as { reason: string }).reason), /core\.hooksPath = githooks/);

    const parent = repo({ "packages/app/package.json": "{}" });
    assert.match(String((hookSetup(join(parent, "packages/app")) as { reason: string }).reason), /top folder/);
  });

  it("knows its own local hook again, so re-planning doesn't call it foreign", () => {
    const dir = repo();
    const [local] = hookChanges(dir, "local", hook, tool);
    writeFileSync(join(dir, ".git/hooks/pre-commit"), local?.after ?? "");
    assert.deepEqual(hookSetup(dir), { manager: "local" });
  });
});

describe("hookChanges", () => {
  it("local: .git/hooks/pre-commit runs the app's binary by its absolute path", () => {
    const [file] = hookChanges(repo(), "local", hook, tool);
    assert.equal(file?.path, ".git/hooks/pre-commit");
    assert.equal(file?.executable, true);
    assert.match(file?.after ?? "", /^#!\/bin\/sh\n# Added by AgentChainer/);
    assert.match(file?.after ?? "", /exec '\/Users\/me\/App Support\/tools\/gitleaks' git --pre-commit --staged/);
  });

  it("lefthook: adds the command and keeps comments and existing commands", () => {
    const before = "# team hooks\npre-commit:\n  commands:\n    lint:\n      run: pnpm lint # fast\n";
    const files = byPath(hookChanges(repo({ "lefthook.yml": before }), "lefthook", hook, tool));
    const yml = files.get("lefthook.yml");
    assert.equal(yml?.before, before);
    assert.match(yml?.after ?? "", /# team hooks/);
    assert.match(yml?.after ?? "", /run: pnpm lint # fast/);
    assert.deepEqual(parse(yml?.after ?? "")["pre-commit"].commands.gitleaks, {
      run: "sh .agentchainer/hooks/gitleaks.sh",
    });
    const script = files.get(".agentchainer/hooks/gitleaks.sh");
    assert.equal(script?.executable, true);
    assert.match(script?.after ?? "", new RegExp(`${APP_ID.replaceAll(".", "\\.")}/tools/gitleaks/\\*/gitleaks`));
    assert.match(script?.after ?? "", /exec "\$bin" git --pre-commit --staged --redact --no-banner/);
  });

  it("pre-commit: appends a local repo hook once", () => {
    const before = "repos:\n  - repo: https://github.com/psf/black\n    rev: 24.1.0\n    hooks:\n      - id: black\n";
    const dir = repo({ ".pre-commit-config.yaml": before });
    const after = byPath(hookChanges(dir, "pre-commit", hook, tool)).get(".pre-commit-config.yaml")?.after ?? "";
    const repos = parse(after).repos;
    assert.equal(repos.length, 2);
    assert.deepEqual(repos[1], {
      repo: "local",
      hooks: [
        {
          id: "gitleaks",
          name: "gitleaks (AgentChainer)",
          entry: "sh .agentchainer/hooks/gitleaks.sh",
          language: "system",
          pass_filenames: false,
        },
      ],
    });
    writeFileSync(join(dir, ".pre-commit-config.yaml"), after);
    const again = byPath(hookChanges(dir, "pre-commit", hook, tool)).get(".pre-commit-config.yaml");
    assert.equal(again?.after, again?.before, "already there: unchanged");
  });

  it("husky: appends the command to .husky/pre-commit", () => {
    const dir = repo({ ".husky/pre-commit": "npx lint-staged" });
    const file = byPath(hookChanges(dir, "husky", hook, tool)).get(".husky/pre-commit");
    assert.equal(file?.after, "npx lint-staged\nsh .agentchainer/hooks/gitleaks.sh\n");
  });

  it("the committed hook blocks a commit the tool rejects, and lets every commit through without the tool", {
    skip: process.platform === "win32" ? "git hooks run through Git Bash on Windows; checked by hand" : false,
  }, () => {
    const dir = repo({ ".husky/pre-commit": "" });
    // husky sets core.hooksPath; here git runs the script directly as its pre-commit hook.
    for (const f of hookChanges(dir, "husky", hook, tool)) {
      mkdirSync(join(dir, f.path, ".."), { recursive: true });
      writeFileSync(join(dir, f.path), f.after);
    }
    writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\nexec sh .agentchainer/hooks/gitleaks.sh\n");
    chmodSync(join(dir, ".git/hooks/pre-commit"), 0o755);
    const bin = join(work, `fake-bin-${n++}`);
    mkdirSync(bin);
    // A stand-in for gitleaks: fails when the staged diff contains "SECRET".
    writeFileSync(join(bin, "gitleaks"), "#!/bin/sh\ngit diff --cached | grep -q SECRET && exit 1\nexit 0\n");
    chmodSync(join(bin, "gitleaks"), 0o755);
    const commit = (file: string, text: string, path: string) => {
      writeFileSync(join(dir, file), text);
      execFileSync("git", ["add", file], { cwd: dir });
      return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", file], {
        cwd: dir,
        env: { ...process.env, PATH: path, HOME: work },
        encoding: "utf8",
      });
    };
    const withTool = `${bin}:/usr/bin:/bin`;
    assert.notEqual(commit("leak.txt", "SECRET=1\n", withTool).status, 0, "the secret is blocked");
    execFileSync("git", ["reset", "-q"], { cwd: dir });
    assert.equal(commit("ok.txt", "hello\n", withTool).status, 0);
    const without = commit("leak2.txt", "SECRET=2\n", "/usr/bin:/bin");
    assert.equal(without.status, 0, "no tool: the commit goes through");
    assert.match(without.stderr, /gitleaks isn't installed/);
  });
});

describe("APP_ID", () => {
  it("matches the app identifier, so the hook finds the tools folder", () => {
    const conf = JSON.parse(
      readFileSync(new URL("../../../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    ) as { identifier: string };
    assert.equal(APP_ID, conf.identifier);
  });
});
