import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { RunResult } from "../run-async.ts";
import { newTask, taskBranch } from "../tasks/service.ts";
import { saveTask } from "../tasks/store.ts";
import { cloudflare, firebase, fly, vercel } from "./adapters.ts";
import { resolveCli, scriptFromNpmShim } from "./cli.ts";
import {
  type Clis,
  deployPreview,
  deployProduction,
  deployTargets,
  listDeploys,
  productionPlan,
  rollbackDeploy,
} from "./service.ts";
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
const CTX = { alias: "task-1a2b3c4d", message: "Ship the page" };

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
    assert.deepEqual(vercel.deployArgs("preview", CTX), ["deploy", "--yes"]);
    assert.deepEqual(vercel.deployArgs("production", CTX), ["deploy", "--prod", "--yes"]);
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

/** What `wrangler versions upload` prints (the shape of wrangler 4.x). */
const UPLOADED = [
  "Total Upload: 0.19 KiB / gzip: 0.16 KiB",
  "Uploaded shop (1.20 sec)",
  "Worker Startup Time: 2 ms",
  "Worker Version ID: 0f3c6c1a-9b7d-4b8e-8a8e-2b1c3d4e5f60",
  "Version Preview URL: https://0f3c6c1a-shop.team.workers.dev",
  "Version Preview Alias URL: https://task-1a2b3c4d-shop.team.workers.dev",
].join("\n");

describe("the Cloudflare Workers adapter (M6-01)", () => {
  it("finds wrangler's config, and leaves Pages projects for later", () => {
    const root = tmp();
    assert.equal(cloudflare.detect(root), null);
    put(root, "wrangler.toml", 'name = "shop"\nmain = "src/index.js"\n');
    assert.deepEqual(cloudflare.detect(root), { config: "wrangler.toml" });
    const pages = tmp();
    put(pages, "wrangler.json", '{"name":"site","pages_build_output_dir":"dist"}');
    assert.match(cloudflare.detect(pages)?.problem ?? "", /Pages/);
  });

  it("is signed in only when whoami doesn't say otherwise (it exits 0 either way)", async () => {
    const run = (r: RunResult) => async () => r;
    assert.equal(await cloudflare.signedIn(run(result(0, "You are logged in with an OAuth Token")), "."), true);
    assert.equal(
      await cloudflare.signedIn(run(result(0, "You are not authenticated. Please run `wrangler login`.")), "."),
      false,
    );
  });

  it("uploads a preview version with the task's alias, reads its URL and version, and rolls back to a version", () => {
    assert.deepEqual(cloudflare.deployArgs("preview", CTX), [
      "versions",
      "upload",
      "--preview-alias",
      "task-1a2b3c4d",
      "--message",
      "Ship the page",
    ]);
    assert.deepEqual(cloudflare.parse(result(0, UPLOADED)), {
      url: "https://task-1a2b3c4d-shop.team.workers.dev",
      deploymentId: "0f3c6c1a-9b7d-4b8e-8a8e-2b1c3d4e5f60",
    });
    assert.equal(cloudflare.parse(result(0, "Uploaded shop")), null);
    assert.deepEqual(cloudflare.rollbackArgs("0f3c6c1a"), [
      "rollback",
      "0f3c6c1a",
      "--message",
      "Rolled back from AgentChainer",
      "--yes",
    ]);
  });

  it("previews a task through the service, and explains a Worker that was never deployed", async () => {
    const { root, task } = linkedWorkspace();
    put(root, "wrangler.toml", 'name = "shop"\nmain = "src/index.js"\n');
    const clis = fakeClis({ whoami: result(0, "logged in"), versions: result(0, UPLOADED) });
    const r = await deployPreview(root, task.id, "cloudflare", clis);
    assert.deepEqual(
      [r.status, r.adapter, r.url, r.deploymentId, r.smoke?.ok],
      [
        "done",
        "cloudflare",
        "https://task-1a2b3c4d-shop.team.workers.dev",
        "0f3c6c1a-9b7d-4b8e-8a8e-2b1c3d4e5f60",
        true,
      ],
    );
    assert.ok(r.command.startsWith(`wrangler versions upload --preview-alias task-${task.id.slice(-8)}`));
    const never = await deployPreview(
      root,
      task.id,
      "cloudflare",
      fakeClis({
        whoami: result(0, "logged in"),
        versions: result(1, "", "✘ [ERROR] This Worker does not exist on your account."),
      }),
    );
    assert.match(never.error ?? "", /hasn't been deployed yet[\s\S]*wrangler deploy/);
  });

  it("names the Worker from its config, and reads what `wrangler deploy` prints", () => {
    const toml = tmp();
    put(toml, "wrangler.toml", 'name = "shop"\nmain = "src/index.js"\n');
    assert.equal(cloudflare.projectName(toml), "shop");
    const jsonc = tmp();
    put(jsonc, "wrangler.jsonc", '// the shop\n{ "name": "shop-api", "main": "src/index.ts" }\n');
    assert.equal(cloudflare.projectName(jsonc), "shop-api");
    assert.deepEqual(
      cloudflare.parse(
        result(
          0,
          "Uploaded shop (1.1 sec)\nDeployed shop triggers (0.3 sec)\n  https://shop.team.workers.dev\nCurrent Version ID: 9a8b7c6d-1111-2222-3333-444455556666\n",
        ),
      ),
      { url: "https://shop.team.workers.dev", deploymentId: "9a8b7c6d-1111-2222-3333-444455556666" },
    );
    assert.deepEqual(cloudflare.rollbackArgs(), ["rollback", "--message", "Rolled back from AgentChainer", "--yes"]);
  });
});

describe("production deploys and rollback (M6-02, M6-03)", () => {
  const vercelAt = (url: string) => fakeClis({ whoami: result(0), deploy: result(0, `${url}\n`) });

  /** A Vercel workspace whose project.json names the project, on a clean `main`. */
  const named = () => {
    const w = linkedWorkspace();
    put(w.root, ".vercel/project.json", '{"projectId":"prj_1","orgId":"team_1","projectName":"shop"}\n');
    return w;
  };

  it("plans the workspace's branch and commit, and needs a clean tree", async () => {
    const { root } = named();
    const plan = await productionPlan(root, "vercel", vercelAt("https://x"));
    assert.deepEqual(
      [plan.project, plan.command, plan.branch, plan.problem],
      ["shop", "vercel deploy --prod --yes", "main", undefined],
    );
    assert.equal(plan.commit.length, 40);
    put(root, "draft.txt", "not committed\n");
    assert.match((await productionPlan(root, "vercel", vercelAt("https://x"))).problem ?? "", /uncommitted/);
  });

  it("deploys only with the project's name typed and the commit the plan showed", async () => {
    const { root } = named();
    const clis = vercelAt("https://shop-a1.vercel.app");
    const { commit } = await productionPlan(root, "vercel", clis);
    await assert.rejects(
      deployProduction(root, "vercel", { typed: "shp", commit }, clis),
      /Type the project's name, shop/,
    );
    await assert.rejects(deployProduction(root, "vercel", { typed: "shop", commit: "0".repeat(40) }, clis), /moved/);
    assert.equal(clis.calls.filter((c) => c.args[0] === "deploy").length, 0);
    const r = await deployProduction(root, "vercel", { typed: " shop ", commit }, clis);
    assert.deepEqual(
      [r.env, r.status, r.url, r.branch, r.smoke?.ok, r.previous],
      ["production", "done", "https://shop-a1.vercel.app", "main", true, undefined],
    );
    assert.deepEqual(clis.calls.at(-1), { args: ["deploy", "--prod", "--yes"], cwd: root });
  });

  it("rolls the live production deploy back to the one before it, and records both ways", async () => {
    const { root } = named();
    const { commit } = await productionPlan(root, "vercel", vercelAt("https://x"));
    const first = await deployProduction(
      root,
      "vercel",
      { typed: "shop", commit },
      vercelAt("https://shop-a1.vercel.app"),
    );
    const second = await deployProduction(
      root,
      "vercel",
      { typed: "shop", commit },
      vercelAt("https://shop-b2.vercel.app"),
    );
    assert.equal(second.previous?.deploymentId, "https://shop-a1.vercel.app");

    const clis = fakeClis({ whoami: result(0), rollback: result(0, "Success") });
    await assert.rejects(rollbackDeploy(root, first.id, "shop", clis), /newer production deploy is live/);
    await assert.rejects(rollbackDeploy(root, second.id, "nope", clis), /Type the project's name/);
    const back = await rollbackDeploy(root, second.id, "shop", clis);
    assert.deepEqual(clis.calls.at(-1), { args: ["rollback", "https://shop-a1.vercel.app", "--yes"], cwd: root });
    assert.deepEqual(
      [back.status, back.rollbackOf, back.url, back.commit, back.smoke?.ok],
      ["done", second.id, "https://shop-a1.vercel.app", commit, true],
    );
    const records = listDeploys(root);
    assert.equal(records.find((r) => r.id === second.id)?.rolledBackBy, back.id);
    // The rollback is what is live now, so it's the one to roll back next (forward again).
    await assert.rejects(rollbackDeploy(root, second.id, "shop", clis), /newer production deploy is live/);
    assert.equal((await productionPlan(root, "vercel", clis)).current?.id, back.id);
  });

  it("refuses to roll back a preview", async () => {
    const { root, task } = named();
    const preview = await deployPreview(root, task.id, "vercel", vercelAt("https://shop-git-task.vercel.app"));
    await assert.rejects(
      rollbackDeploy(root, preview.id, "shop", vercelAt("https://x")),
      /previews don't take traffic/,
    );
  });
});

describe("the Firebase Hosting and Fly.io adapters (M6-01)", () => {
  /** What firebase-tools 15 prints with --json (command.js wraps the command's result). */
  const CHANNEL = JSON.stringify({
    status: "success",
    result: {
      shop: { site: "shop", url: "https://shop--task-1a2b3c4d-x1y2.web.app", version: "abc123", expireTime: "" },
    },
  });
  const LIVE = JSON.stringify({ status: "success", result: { hosting: "projects/p1/sites/shop/versions/def456" } });

  it("finds Firebase Hosting with a default project, and reads channel and live deploys", () => {
    const root = tmp();
    assert.equal(firebase.detect(root), null);
    put(root, "firebase.json", '{"hosting":{"public":"dist"}}');
    assert.match(firebase.detect(root)?.problem ?? "", /firebase use --add/);
    put(root, ".firebaserc", '{"projects":{"default":"shop-prod"}}');
    assert.deepEqual(firebase.detect(root), { config: "firebase.json" });
    assert.equal(firebase.projectName(root), "shop-prod");
    assert.deepEqual(firebase.deployArgs("preview", CTX).slice(0, 4), [
      "hosting:channel:deploy",
      "task-1a2b3c4d",
      "--expires",
      "7d",
    ]);
    assert.deepEqual(firebase.parse(result(0, `i  deploying\n${CHANNEL}`)), {
      url: "https://shop--task-1a2b3c4d-x1y2.web.app",
      deploymentId: "shop@abc123",
    });
    assert.deepEqual(firebase.parse(result(0, LIVE)), { url: "https://shop.web.app", deploymentId: "shop@def456" });
    assert.deepEqual(firebase.rollbackArgs("shop@def456"), [
      "hosting:clone",
      "shop@def456",
      "shop:live",
      "--non-interactive",
    ]);
    assert.equal(firebase.rollbackArgs(), null);
  });

  it("deploys Fly.io to production only, and rolls back by redeploying the recorded image", () => {
    const root = tmp();
    put(root, "fly.toml", "# fly.toml\napp = 'shop-api'\nprimary_region = 'sin'\n");
    assert.deepEqual(
      [fly.detect(root), fly.projectName(root), fly.environments],
      [{ config: "fly.toml" }, "shop-api", ["production"]],
    );
    const out =
      "image: registry.fly.io/shop-api:deployment-01JABC\nVisit your newly deployed app at https://shop-api.fly.dev/\n";
    assert.deepEqual(fly.parse(result(0, out)), {
      url: "https://shop-api.fly.dev",
      deploymentId: "registry.fly.io/shop-api:deployment-01JABC",
    });
    assert.deepEqual(fly.rollbackArgs("registry.fly.io/shop-api:deployment-01JABC"), [
      "deploy",
      "--image",
      "registry.fly.io/shop-api:deployment-01JABC",
      "--remote-only",
      "--yes",
    ]);
    assert.equal(fly.rollbackArgs(), null);
  });

  it("refuses a Fly.io preview, and a rollback with no recorded deploy to go back to", async () => {
    const { root, task } = linkedWorkspace();
    rmSync(path.join(root, ".vercel"), { recursive: true });
    put(root, "fly.toml", 'app = "shop-api"\n');
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root });
    g("add", "fly.toml");
    g("commit", "-q", "-m", "fly");
    const clis = fakeClis({
      auth: result(0),
      deploy: result(0, "image: registry.fly.io/shop-api:deployment-1\nhttps://shop-api.fly.dev/\n"),
    });
    const [target] = await deployTargets(root, clis);
    assert.deepEqual(
      [target?.adapter, target?.environments, target?.rollbackWithoutRecord],
      ["fly", ["production"], false],
    );
    await assert.rejects(deployPreview(root, task.id, "fly", clis), /no previews/);
    const { commit } = await productionPlan(root, "fly", clis);
    const first = await deployProduction(root, "fly", { typed: "shop-api", commit }, clis);
    assert.equal(first.deploymentId, "registry.fly.io/shop-api:deployment-1");
    await assert.rejects(rollbackDeploy(root, first.id, "shop-api", clis), /no record of the Fly\.io deploy before/);
    const second = await deployProduction(root, "fly", { typed: "shop-api", commit }, clis);
    await rollbackDeploy(root, second.id, "shop-api", clis);
    assert.deepEqual(clis.calls.at(-1)?.args, [
      "deploy",
      "--image",
      "registry.fly.io/shop-api:deployment-1",
      "--remote-only",
      "--yes",
    ]);
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
