import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listRuns, rollback } from "../bootstrap/apply.ts";
import { fakeCli } from "../bootstrap/fake-cli.ts";
import { describeSteps, installSteps } from "../bootstrap/plan.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { addWorktree, branchOf, commitAll, headOf, worktreePath } from "./worktree.ts";
import {
  allowScript,
  copyIncluded,
  includedFiles,
  isAllowed,
  MAX_COPY_FILES,
  mainCheckoutOf,
  readConfig,
  runCommand,
  saveWorktreeSetup,
  setupCommand,
} from "./worktree-setup.ts";
import { setupWorktree } from "./xl-world.ts";

// CP-04: what a task's new worktree gets besides the tracked files, on real repositories and worktrees.

const roots: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const write = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...rel.split("/")), text);
};

/** A committed repository with `tracked` files, then `untracked` ones written after the commit. */
function repo(tracked: Record<string, string>, untracked: Record<string, string> = {}) {
  const root = temp("ac-wt-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [rel, text] of Object.entries(tracked)) write(root, rel, text);
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: root });
  for (const [rel, text] of Object.entries(untracked)) write(root, rel, text);
  return root;
}

let n = 0;
function worktree(root: string) {
  const id = `2026-11-11-0000000${n++}`;
  const dir = worktreePath(root, id);
  addWorktree(root, dir, branchOf(id), headOf(root) ?? "HEAD");
  return dir;
}

const trust = () => ({ AGENTCHAINER_TRUST_FILE: join(temp("ac-trust-"), "trusted-scripts.json") });

describe("copying gitignored files into a worktree (CP-04)", () => {
  const gitignore = ".env\n.env.local\nsecret/\nnode_modules/\ncache/\n";

  it("copies only what .worktreeinclude names and git ignores, so a commit never takes them", () => {
    const root = repo(
      { ".gitignore": gitignore, ".env.example": "A=\n", ".worktreeinclude": ".env*\nsecret/\nnotes.txt\n" },
      {
        ".env": "A=1\n",
        ".env.local": "B=2\n",
        "secret/key.json": "{}\n",
        "node_modules/x/index.js": "x\n",
        "notes.txt": "not ignored\n",
      },
    );
    const dir = worktree(root);
    const { copied, capped } = copyIncluded(root, dir);
    assert.deepEqual(copied, [".env", ".env.local", "secret/key.json"]);
    assert.equal(capped, false);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "A=1\n");
    assert.equal(existsSync(join(dir, "notes.txt")), false);
    assert.equal(existsSync(join(dir, "node_modules")), false);
    // The tracked example is the worktree's own, and nothing copied is committed.
    assert.equal(readFileSync(join(dir, ".env.example"), "utf8"), "A=\n");
    assert.equal(commitAll(dir, "nothing", []), null);
  });

  it("skips a link and keeps a file the worktree already has", () => {
    const outside = temp("ac-outside-");
    writeFileSync(join(outside, "real.txt"), "outside\n");
    const root = repo({ ".gitignore": gitignore, ".worktreeinclude": ".env*\nsecret/\n" }, { ".env": "A=1\n" });
    mkdirSync(join(root, "secret"));
    symlinkSync(join(outside, "real.txt"), join(root, "secret", "link.txt"));
    const dir = worktree(root);
    writeFileSync(join(dir, ".env"), "A=mine\n");
    assert.deepEqual(copyIncluded(root, dir).copied, []);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "A=mine\n");
    assert.equal(existsSync(join(dir, "secret", "link.txt")), false);
  });

  it("copies nothing without a .worktreeinclude, and stops at its caps", () => {
    const plain = repo({ ".gitignore": gitignore }, { ".env": "A=1\n" });
    assert.deepEqual(copyIncluded(plain, worktree(plain)).copied, []);

    const files = Object.fromEntries(
      Array.from({ length: MAX_COPY_FILES + 5 }, (_, i) => [`cache/${String(i).padStart(3, "0")}.txt`, "x"]),
    );
    const big = repo({ ".gitignore": gitignore, ".worktreeinclude": "cache/\n" }, files);
    const listed = includedFiles(big);
    assert.equal(listed.files.length, MAX_COPY_FILES);
    assert.equal(listed.capped, true);
    // A draft is listed without saving it.
    assert.deepEqual(
      includedFiles(big, "cache/001.txt\n").files.map((f) => f.path),
      ["cache/001.txt"],
    );
  });

  it("finds the main checkout a worktree mirrors", () => {
    const root = join(tmpdir(), "proj");
    assert.equal(mainCheckoutOf(join(root, ".agentchainer", "worktrees", "2026-11-11-00000000")), root);
    assert.equal(
      mainCheckoutOf(join(root, ".agentchainer", "worktrees", "2026-11-11-00000000", "apps", "web")),
      join(root, "apps", "web"),
    );
    assert.equal(mainCheckoutOf(root), null);
  });
});

describe("setup and run scripts", () => {
  const scripts = (setup: string, run?: string) => JSON.stringify({ setup, ...(run ? { run } : {}) });

  it("runs the project's setup script only once it's allowed here, and asks again when it changes", () => {
    const env = trust();
    const pkg = JSON.stringify({ name: "x", scripts: { dev: "vite" } });
    const root = repo({ "package.json": pkg, ".agentchainer/worktree.json": scripts("node -e 0") });
    assert.deepEqual(setupCommand(root, root, env), {
      steps: [{ command: "npm install", dir: "." }],
      scriptNotAllowed: true,
    });
    allowScript(root, "setup", "node -e 0", env);
    assert.deepEqual(setupCommand(root, root, env), { steps: [{ command: "node -e 0", dir: "." }] });
    write(root, ".agentchainer/worktree.json", scripts("node -e 1"));
    assert.equal(setupCommand(root, root, env).scriptNotAllowed, true);
    // Without a trust file (tests, scripts), nothing is ever allowed or kept.
    allowScript(root, "setup", "node -e 1", {});
    assert.equal(isAllowed(root, "setup", "node -e 1", {}), false);
  });

  it("reads a broken scripts file as none, with why", () => {
    const root = repo({ ".agentchainer/worktree.json": "{ nope" });
    const r = readConfig(root);
    assert.deepEqual(r.config, {});
    assert.match(r.problem ?? "", /isn't valid/);
  });

  it("starts the app with the run script, else the detected dev command", () => {
    const pkg = JSON.stringify({ name: "x", scripts: { dev: "vite" } });
    const plain = repo({ "package.json": pkg });
    assert.deepEqual(runCommand(plain, plain), { command: "npm run dev", script: false });
    const scripted = repo({ "package.json": pkg, ".agentchainer/worktree.json": scripts("x", "pnpm dev --port 4000") });
    assert.deepEqual(runCommand(scripted, scripted), { command: "pnpm dev --port 4000", script: true });
    assert.equal(runCommand(repo({ "a.txt": "x" }), repo({ "a.txt": "x" })), null);
  });

  it("saves the include file and scripts as one History run, allowing what it saved", () => {
    const env = trust();
    const root = repo({ "a.txt": "x" });
    const runId = saveWorktreeSetup(root, { include: ".env\n", setup: "npm ci", run: "npm run dev" }, "test", env);
    assert.ok(runId);
    assert.equal(readFileSync(join(root, ".worktreeinclude"), "utf8"), ".env\n");
    assert.deepEqual(readConfig(root).config, { setup: "npm ci", run: "npm run dev" });
    assert.equal(isAllowed(root, "setup", "npm ci", env), true);
    assert.equal(isAllowed(root, "run", "npm run dev", env), true);
    assert.equal(saveWorktreeSetup(root, { include: ".env", setup: "npm ci", run: "npm run dev" }, "test", env), null);
    assert.equal(listRuns(root).length, 1);
    rollback(root, runId ?? "", { cli: fakeCli(root) });
    assert.equal(existsSync(join(root, ".worktreeinclude")), false);
    assert.equal(existsSync(join(root, ".agentchainer", "worktree.json")), false);
  });

  it("refuses a script that spans lines or holds a key", () => {
    const root = repo({ "a.txt": "x" });
    assert.throws(() => saveWorktreeSetup(root, { include: "", setup: "a\nb", run: "" }, "test"), /one line/);
    assert.throws(
      () =>
        saveWorktreeSetup(
          root,
          { include: "", setup: "", run: "TOKEN=ghp_0123456789abcdefghijABCD npm start" },
          "test",
        ),
      /key or token/,
    );
  });
});

describe("a new worktree's setup, end to end", () => {
  it("copies, then runs the allowed setup script in the worktree, and says so", async () => {
    const env = trust();
    const before = process.env.AGENTCHAINER_TRUST_FILE;
    process.env.AGENTCHAINER_TRUST_FILE = env.AGENTCHAINER_TRUST_FILE;
    try {
      const root = repo(
        {
          ".gitignore": ".env\n",
          ".worktreeinclude": ".env\n",
          ".agentchainer/worktree.json": JSON.stringify({ setup: "node -e 0" }),
        },
        { ".env": "A=1\n" },
      );
      allowScript(root, "setup", "node -e 0");
      const dir = worktree(root);
      const r = await setupWorktree(dir, new AbortController().signal);
      assert.equal(r?.command, "node -e 0");
      assert.equal(r?.exitCode, 0);
      assert.deepEqual(r?.copied, [".env"]);
      assert.ok(existsSync(join(dir, ".env")));
    } finally {
      if (before === undefined) delete process.env.AGENTCHAINER_TRUST_FILE;
      else process.env.AGENTCHAINER_TRUST_FILE = before;
    }
  });
});

describe("installing in each package's own folder", () => {
  const pkg = JSON.stringify({ name: "x", scripts: { test: "node --test" } });

  it("runs the root's install alone, else each package's in its folder", () => {
    const steps = (files: Record<string, string>) => installSteps(detectWorkspace(repo(files)));
    assert.deepEqual(steps({ "package.json": pkg, "web/package.json": pkg }), [{ command: "npm install", dir: "." }]);
    assert.deepEqual(steps({ "web/package.json": pkg }), [{ command: "npm install", dir: "web" }]);
    // A web app and a Python API side by side: each installs in its own folder.
    assert.deepEqual(
      steps({ "web/package.json": pkg, "api/pyproject.toml": "[project]\nname = 'api'\n", "api/uv.lock": "" }),
      [
        { command: "uv sync", dir: "api" },
        { command: "npm install", dir: "web" },
      ],
    );
    assert.deepEqual(steps({ "README.md": "x" }), []);
    assert.equal(
      describeSteps([
        { command: "npm install", dir: "web" },
        { command: "uv sync", dir: "api" },
      ]),
      "npm install (web); uv sync (api)",
    );
  });

  it("sets up a worktree whose only package is in a folder, there", async () => {
    const root = repo({ "web/package.json": JSON.stringify({ name: "web", private: true }) });
    const r = await setupWorktree(worktree(root), new AbortController().signal);
    assert.equal(r?.command, "npm install (web)");
    assert.equal(r?.exitCode, 0, r?.tail);
  });
});
