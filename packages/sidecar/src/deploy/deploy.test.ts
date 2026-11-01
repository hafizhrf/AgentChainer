import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { RunResult } from "../run-async.ts";
import { newTask, taskBranch } from "../tasks/service.ts";
import { saveTask } from "../tasks/store.ts";
import { vercel } from "./adapters.ts";
import { resolveCli, scriptFromNpmShim } from "./cli.ts";
import { type Clis, deployPreview, deployTargets, listDeploys } from "./service.ts";
import { runSmoke } from "./smoke.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ac-deploy-"));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const result = (status: number, stdout = "", stderr = ""): RunResult => ({ status, stdout, stderr });

/** A git workspace linked to Vercel, with a task that has its own worktree. */
const linkedWorkspace = () => {
  const root = tmp();
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root });
  g("init", "-q", "-b", "main");
  put(root, "index.html", "<h1>hi</h1>\n");
  put(root, ".gitignore", ".vercel\n");
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  put(root, ".vercel/project.json", '{"projectId":"prj_1","orgId":"team_1"}\n');
  const { task } = taskBranch(root, newTask(root, "Ship the page"));
  saveTask(root, task);
  return { root, task };
};

/** CLIs that are installed and answer with `answers` by first argument; `calls` records what ran where. */
const fakeClis = (
  answers: Record<string, RunResult>,
  status = 200,
): Clis & { calls: { args: string[]; cwd: string }[] } => {
  const calls: { args: string[]; cwd: string }[] = [];
  return {
    calls,
    resolve: (name) => ({ bin: name, prefix: [] }),
    runner: () => async (args, cwd) => {
      calls.push({ args, cwd });
      return answers[args[0] ?? ""] ?? result(1, "", "unknown command");
    },
    fetch: (async () => new Response("ok", { status })) as unknown as typeof fetch,
  };
};

describe("provider CLIs without a shell (M6-01)", () => {
  it("runs an npm .cmd shim's script with node instead of through cmd", () => {
    const shim =
      '@ECHO off\r\n…\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\vercel\\dist\\vc.js" %*\r\n';
    assert.equal(scriptFromNpmShim(shim, "C:\\npm"), "C:\\npm\\node_modules\\vercel\\dist\\vc.js");
    const find = (n: string) => (n === "node" ? "C:\\node\\node.exe" : "C:\\npm\\vercel.cmd");
    assert.deepEqual(
      resolveCli(
        "vercel",
        find,
        () => shim,
        () => true,
      ),
      {
        bin: "C:\\node\\node.exe",
        prefix: ["C:\\npm\\node_modules\\vercel\\dist\\vc.js"],
      },
    );
    assert.equal(
      resolveCli(
        "vercel",
        (n) => (n === "node" ? null : "C:\\npm\\vercel.cmd"),
        () => shim,
        () => true,
      ),
      null,
    );
    assert.deepEqual(
      resolveCli("vercel", () => "/usr/local/bin/vercel"),
      { bin: "/usr/local/bin/vercel", prefix: [] },
    );
    assert.equal(
      resolveCli("vercel", () => null),
      null,
    );
  });
});

describe("the Vercel adapter (M6-01)", () => {
  it("knows a linked project, asks to link one that only has vercel.json, and copies the link into a worktree", () => {
    const root = tmp();
    assert.equal(vercel.detect(root), null);
    put(root, "vercel.json", "{}");
    assert.match(vercel.detect(root)?.problem ?? "", /vercel link/);
    put(root, ".vercel/project.json", "{}");
    assert.deepEqual(vercel.detect(root), { config: ".vercel/project.json" });
    const code = tmp();
    vercel.prepare(root, code);
    assert.ok(existsSync(path.join(code, ".vercel", "project.json")));
  });

  it("reads the deployment URL from stdout, and builds preview, production and rollback commands", () => {
    const out = result(
      0,
      "https://app-abc123-team.vercel.app\n",
      "Vercel CLI 65.9.0\nInspect: https://vercel.com/team/app/xyz\n",
    );
    assert.deepEqual(vercel.parse(out), {
      url: "https://app-abc123-team.vercel.app",
      deploymentId: "https://app-abc123-team.vercel.app",
    });
    assert.equal(vercel.parse(result(0, "", "Error: something")), null);
    assert.deepEqual(vercel.deployArgs("preview"), ["deploy", "--yes"]);
    assert.deepEqual(vercel.deployArgs("production"), ["deploy", "--prod", "--yes"]);
    assert.deepEqual(vercel.rollbackArgs("https://a.vercel.app"), ["rollback", "https://a.vercel.app", "--yes"]);
  });
});

describe("deploy targets and a task's preview (M6-01, M6-03)", () => {
  it("says what's missing: the CLI, the link, or the sign-in", async () => {
    const { root } = linkedWorkspace();
    assert.deepEqual(
      (await deployTargets(root, { ...fakeClis({}), resolve: () => null })).map((t) => t.state),
      ["missing"],
    );
    assert.deepEqual(
      (await deployTargets(root, fakeClis({ whoami: result(1) }))).map((t) => [t.state, t.hint]),
      [["signed-out", "Sign in with `vercel login` in a terminal."]],
    );
    assert.equal((await deployTargets(root, fakeClis({ whoami: result(0, "someone") })))[0]?.state, "ready");
    assert.deepEqual(await deployTargets(tmp(), fakeClis({})), []);
  });

  it("deploys the task's worktree as a preview, smoke-tests the URL and records it", async () => {
    const { root, task } = linkedWorkspace();
    const clis = fakeClis({ whoami: result(0), deploy: result(0, "https://ship-1.vercel.app\n") });
    const r = await deployPreview(root, task.id, "vercel", clis);
    assert.deepEqual(
      [r.status, r.env, r.url, r.command, r.branch, r.smoke?.ok, r.smoke?.how],
      ["done", "preview", "https://ship-1.vercel.app", "vercel deploy --yes", task.worktree?.branch, true, "http"],
    );
    const deploy = clis.calls.find((c) => c.args[0] === "deploy");
    assert.equal(deploy?.cwd, task.worktree?.path, "from the task's worktree");
    assert.ok(!deploy?.args.includes("--prod"), "never production");
    assert.ok(existsSync(path.join(task.worktree?.path ?? "", ".vercel", "project.json")), "linked like the workspace");
    assert.deepEqual(
      listDeploys(root, task.id).map((d) => d.id),
      [r.id],
    );
    assert.match(readFileSync(path.join(root, ".agentchainer", ".gitignore"), "utf8"), /deploys\//);
  });

  it("records a failed deploy with the CLI's last words, and a failed smoke test", async () => {
    const { root, task } = linkedWorkspace();
    const failed = await deployPreview(
      root,
      task.id,
      "vercel",
      fakeClis({ whoami: result(0), deploy: result(1, "", "Error: Build failed\n") }),
    );
    assert.deepEqual([failed.status, failed.error], ["failed", "Error: Build failed"]);
    const down = await deployPreview(
      root,
      task.id,
      "vercel",
      fakeClis({ whoami: result(0), deploy: result(0, "https://ship-2.vercel.app\n") }, 502),
    );
    assert.deepEqual(
      [down.status, down.smoke?.ok, down.smoke?.detail],
      ["done", false, "GET https://ship-2.vercel.app answered 502."],
    );
    assert.equal(listDeploys(root, task.id).length, 2);
  });

  it("refuses when the provider isn't ready", async () => {
    const { root, task } = linkedWorkspace();
    await assert.rejects(deployPreview(root, task.id, "vercel", fakeClis({ whoami: result(1) })), /vercel login/);
  });
});

describe("the smoke test (M6-03)", () => {
  it("runs the project's smoke script with SMOKE_URL set", async () => {
    const code = tmp();
    put(
      code,
      "scripts/smoke.mjs",
      'if (process.env.SMOKE_URL !== "https://x.example") process.exit(3);\nconsole.log("ok");\n',
    );
    const ok = await runSmoke(code, "https://x.example");
    assert.deepEqual([ok.ok, ok.how], [true, "script"]);
    const wrong = await runSmoke(code, "https://other.example");
    assert.deepEqual([wrong.ok, wrong.how], [false, "script"]);
  });
});
