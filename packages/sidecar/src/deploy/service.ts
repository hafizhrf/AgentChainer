import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type DeployPlan,
  type DeployRecord,
  DeployRecordSchema,
  type DeployTarget,
  RpcErrorCode,
} from "@agentchainer/protocol";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { t } from "../i18n/index.ts";
import { RpcFailure } from "../rpc.ts";
import { result } from "../tasks/result.ts";
import { loadTask } from "../tasks/store.ts";
import { codeRootIn } from "../tasks/worktree.ts";
import { git } from "../workspace.ts";
import { ADAPTERS, type Adapter, type DeployContext } from "./adapters.ts";
import { type Cli, cliRunner, type RunCli, resolveCli } from "./cli.ts";
import { runSmoke } from "./smoke.ts";

/**
 * Deploys (M6, docs/design/deploy-and-canvas.md): which providers a workspace can deploy to, a task's preview deploy,
 * production deploys of the workspace and their rollback, each with its smoke test, and the records of every deploy.
 * Always a person's click; agents can't deploy (the guard).
 */

const invalid = (message: string) => new RpcFailure(RpcErrorCode.invalidParams, message);
const DEPLOYS = "deploys";

/** How to reach a CLI: the real one by default; tests pass stand-ins. */
export type Clis = { resolve: (name: string) => Cli | null; runner: (cli: Cli) => RunCli; fetch?: typeof fetch };
const realClis: Clis = { resolve: (n) => resolveCli(n), runner: cliRunner };

/** How to install the provider's CLI and sign in. */
function installHint(a: Adapter): string {
  switch (a.id) {
    case "vercel":
      return t("deploy.hint.npm", { package: "vercel", cli: "vercel" });
    case "cloudflare":
      return t("deploy.hint.npm", { package: "wrangler", cli: "wrangler" });
    case "firebase":
      return t("deploy.hint.npm", { package: "firebase-tools", cli: "firebase" });
    case "fly":
      return t("deploy.hint.fly");
    case "docker":
      return t("deploy.hint.docker");
    default:
      return t("deploy.hint.installCli", { cli: a.cli });
  }
}

/** What "not signed in" means: `<cli> login` unless the provider has its own. */
function signedOutHint(a: Adapter): string {
  if (a.id === "fly") return t("deploy.hint.signIn", { command: "fly auth login" });
  if (a.id === "docker") return t("deploy.hint.dockerNotRunning");
  return t("deploy.hint.signIn", { command: `${a.cli} login` });
}

async function targetOf(a: Adapter, root: string, clis: Clis): Promise<DeployTarget | null> {
  const found = a.detect(root);
  if (!found) return null;
  const base = {
    adapter: a.id,
    label: a.label,
    config: found.config,
    environments: [...a.environments],
    rollbackWithoutRecord: a.rollbackArgs() !== null,
    ...(a.projectName(root) ? { project: a.projectName(root) ?? "" } : {}),
  };
  const cli = clis.resolve(a.cli);
  if (!cli) return { ...base, state: "missing", hint: installHint(a) };
  if (found.problem) return { ...base, state: "not-linked", hint: found.problem };
  const signedIn = await a.signedIn(clis.runner(cli), root);
  return signedIn ? { ...base, state: "ready" } : { ...base, state: "signed-out", hint: signedOutHint(a) };
}

/** The providers `root` can deploy to. */
export async function deployTargets(root: string, clis: Clis = realClis): Promise<DeployTarget[]> {
  const targets = await Promise.all(ADAPTERS.map((a) => targetOf(a, root, clis)));
  return targets.filter((t): t is DeployTarget => t !== null);
}

/* ---------- Records ---------- */

function recordsDir(root: string): string {
  return path.join(root, AC_DIR, DEPLOYS);
}

function saveRecord(root: string, record: DeployRecord): void {
  ensureIgnored(root, `${DEPLOYS}/`);
  mkdirSync(recordsDir(root), { recursive: true });
  writeFileSync(path.join(recordsDir(root), `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

/** The deploys, newest first; a task's only, with `taskId`. Unreadable records are skipped. */
export function listDeploys(root: string, taskId?: string): DeployRecord[] {
  const dir = recordsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const r = DeployRecordSchema.safeParse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
      return r.success ? [r.data] : [];
    })
    .filter((r) => !taskId || r.taskId === taskId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/* ---------- Running a deploy ---------- */

/** Deploys in progress, by workspace and adapter: one at a time each. */
const busy = new Set<string>();

function adapterOf(id: DeployTarget["adapter"]): Adapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw invalid(t("deploy.service.unknownProvider", { id }));
  return adapter;
}

async function exclusive<T>(root: string, adapter: Adapter, work: () => Promise<T>): Promise<T> {
  const key = `${root}\0${adapter.id}`;
  if (busy.has(key)) throw invalid(t("deploy.service.alreadyRunning", { label: adapter.label }));
  busy.add(key);
  try {
    return await work();
  } finally {
    busy.delete(key);
  }
}

function cliOf(adapter: Adapter, clis: Clis): Cli {
  const cli = clis.resolve(adapter.cli);
  if (!cli) throw invalid(t("deploy.service.cliMissing", { cli: adapter.cli }));
  return cli;
}

const newId = (at: Date) => `${at.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
const tailOf = (r: { stdout: string; stderr: string }) =>
  (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ").slice(0, 400);

type Base = Omit<DeployRecord, "endedAt" | "status">;

/**
 * Runs the provider's CLI in `code`, reads the deployment from its output and smoke-tests it. The record is saved
 * whether it worked or not, and returned.
 */
async function runDeploy(
  root: string,
  code: string,
  adapter: Adapter,
  base: Base,
  args: string[],
  ctx: DeployContext,
  clis: Clis,
  now: () => Date,
): Promise<DeployRecord> {
  // A build can take several minutes on the provider's side.
  const r = await clis.runner(cliOf(adapter, clis))(args, code, { timeoutMs: 1_200_000 });
  const out = r.status === 0 ? adapter.parse(r, ctx) : null;
  let record: DeployRecord;
  if (!out) {
    const tail = tailOf(r);
    // Our own words go in English with a ref the app shows in its language (X-15); the CLI's output as it is.
    const why =
      r.status === 0
        ? result("deploy.error.unreadableResult")
        : adapter.id === "cloudflare" && base.env === "preview" && /does not exist|not found|deploy.*first/i.test(tail)
          ? result("deploy.error.notDeployedYet", { tail })
          : null;
    record = {
      ...base,
      endedAt: now().toISOString(),
      status: "failed",
      ...(why ? { error: why.text, errorRef: why.ref } : { error: tail || `exit ${r.status}` }),
    };
  } else {
    // A Docker image has no URL to smoke-test.
    const smoke = out.url ? await runSmoke(code, out.url, clis.fetch) : undefined;
    record = { ...base, endedAt: now().toISOString(), status: "done", ...out, ...(smoke ? { smoke } : {}) };
  }
  saveRecord(root, record);
  return record;
}

/* ---------- Preview ---------- */

/**
 * Deploys a task's worktree as a preview with the provider's CLI, then runs the smoke test on its URL. The record is
 * saved whether it worked or not, and returned.
 */
export async function deployPreview(
  root: string,
  taskId: string,
  adapterId: DeployTarget["adapter"],
  clis: Clis = realClis,
  now = () => new Date(),
): Promise<DeployRecord> {
  const adapter = adapterOf(adapterId);
  if (!adapter.environments.includes("preview")) {
    throw invalid(t("deploy.service.noPreviews", { label: adapter.label }));
  }
  const task = loadTask(root, taskId);
  const wt = task.worktree;
  const code = wt && !wt.removed && existsSync(wt.path) ? codeRootIn(root, wt.path) : root;
  const target = await targetOf(adapter, root, clis);
  if (target?.state !== "ready") {
    throw invalid(target?.hint ?? t("deploy.service.notSetUp", { label: adapter.label }));
  }
  return exclusive(root, adapter, () => {
    adapter.prepare(root, code);
    // Preview aliases are lowercase letters, digits and dashes; the task id's random part keeps it short and unique.
    const commit = git(["rev-parse", "HEAD"], code).stdout.trim();
    const ctx: DeployContext = {
      alias: `task-${taskId.slice(-8)}`,
      message: task.contract?.objective || task.request,
      root,
      commit,
    };
    const args = adapter.deployArgs("preview", ctx);
    const started = now();
    const base: Base = {
      id: newId(started),
      adapter: adapter.id,
      env: "preview",
      taskId,
      ...(wt ? { branch: wt.branch } : {}),
      commit,
      command: `${adapter.cli} ${args.join(" ")}`,
      startedAt: started.toISOString(),
    };
    return runDeploy(root, code, adapter, base, args, ctx, clis, now);
  });
}

/* ---------- Production (M6-02, design §5) ---------- */

/** The production deploy that is live for `adapter`, as far as the app's records go: the newest one that worked. */
function liveProduction(root: string, adapter: DeployTarget["adapter"]): DeployRecord | undefined {
  return listDeploys(root).find((r) => r.env === "production" && r.adapter === adapter && r.status === "done");
}

const previousOf = (r: DeployRecord): NonNullable<DeployRecord["previous"]> => ({
  recordId: r.id,
  ...(r.deploymentId ? { deploymentId: r.deploymentId } : {}),
  ...(r.url ? { url: r.url } : {}),
  ...(r.commit ? { commit: r.commit } : {}),
});

/** What a production deploy of the workspace's current branch would run, and why it can't run yet, if it can't. */
export async function productionPlan(
  root: string,
  adapterId: DeployTarget["adapter"],
  clis: Clis = realClis,
): Promise<DeployPlan> {
  const adapter = adapterOf(adapterId);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], root).stdout.trim();
  const commit = git(["rev-parse", "HEAD"], root).stdout.trim();
  const args = adapter.deployArgs("production", productionContext(root, commit));
  // Untracked files count too: a provider CLI uploads the folder, not the commit. The app's own folder doesn't.
  const dirty = git(["status", "--porcelain", "--", ".", `:(exclude)${AC_DIR}`], root).stdout.trim() !== "";
  const target = await targetOf(adapter, root, clis);
  const current = liveProduction(root, adapter.id);
  const problem =
    target?.state !== "ready"
      ? (target?.hint ?? t("deploy.service.notSetUp", { label: adapter.label }))
      : !commit
        ? t("deploy.plan.noCommits")
        : branch === "HEAD"
          ? t("deploy.plan.detached")
          : dirty
            ? t("deploy.plan.uncommitted")
            : undefined;
  return {
    adapter: adapter.id,
    label: adapter.label,
    // Without a name in the config, the workspace folder's name is what gets typed.
    project: adapter.projectName(root) ?? path.basename(root),
    command: `${adapter.cli} ${args.join(" ")}`,
    branch,
    commit,
    ...(problem ? { problem } : {}),
    ...(current ? { current } : {}),
  };
}

/** A production deploy's context: the commit's subject is its message. */
const productionContext = (root: string, commit: string): DeployContext => ({
  alias: "",
  message: commit ? git(["log", "-1", "--format=%s", commit], root).stdout.trim() : "",
  root,
  commit,
});

function checkTyped(plan: DeployPlan, typed: string): void {
  if (typed.trim() !== plan.project) throw invalid(t("deploy.production.typeName", { project: plan.project }));
}

/**
 * Deploys the workspace's current branch to production with the provider's CLI, then runs the smoke test. Needs the
 * project's name as the person typed it and the commit the plan showed, so nothing deploys that they didn't see.
 */
export async function deployProduction(
  root: string,
  adapterId: DeployTarget["adapter"],
  confirm: { typed: string; commit: string },
  clis: Clis = realClis,
  now = () => new Date(),
): Promise<DeployRecord> {
  const adapter = adapterOf(adapterId);
  const plan = await productionPlan(root, adapterId, clis);
  if (plan.problem) throw invalid(plan.problem);
  checkTyped(plan, confirm.typed);
  if (plan.commit !== confirm.commit) {
    throw invalid(t("deploy.production.branchMoved"));
  }
  return exclusive(root, adapter, () => {
    const ctx = productionContext(root, plan.commit);
    const args = adapter.deployArgs("production", ctx);
    const started = now();
    const before = liveProduction(root, adapter.id);
    const base: Base = {
      id: newId(started),
      adapter: adapter.id,
      env: "production",
      branch: plan.branch,
      commit: plan.commit,
      command: plan.command,
      startedAt: started.toISOString(),
      ...(before ? { previous: previousOf(before) } : {}),
    };
    return runDeploy(root, root, adapter, base, args, ctx, clis, now);
  });
}

/* ---------- Rollback (M6-03, design §6) ---------- */

/**
 * Rolls the live production deploy `id` back to the one before it with the provider's own rollback (or the
 * provider's own previous one, when the app didn't record it), then smoke-tests what is live again. Only the live one
 * can be rolled back; the rollback is recorded and becomes the live one.
 */
export async function rollbackDeploy(
  root: string,
  id: string,
  typed: string,
  clis: Clis = realClis,
  now = () => new Date(),
): Promise<DeployRecord> {
  const record = listDeploys(root).find((r) => r.id === id);
  if (!record) throw invalid(t("deploy.rollback.notRecorded"));
  if (record.env !== "production" || record.status !== "done") {
    throw invalid(t("deploy.rollback.onlyProduction"));
  }
  const adapter = adapterOf(record.adapter);
  if (liveProduction(root, adapter.id)?.id !== record.id) {
    throw invalid(t("deploy.rollback.newerIsLive"));
  }
  const to = record.previous;
  const args = adapter.rollbackArgs(to?.deploymentId);
  if (!args) {
    throw invalid(t("deploy.rollback.noPrevious", { label: adapter.label }));
  }
  checkTyped(await productionPlan(root, adapter.id, clis), typed);
  const cli = cliOf(adapter, clis);
  return exclusive(root, adapter, async () => {
    const started = now();
    // A Fly rollback redeploys an image, which takes as long as a deploy.
    const r = await clis.runner(cli)(args, root, { timeoutMs: 1_200_000 });
    // Each Vercel deployment has its own URL, so what is live again is the previous one's; the others keep theirs.
    const url = adapter.id === "vercel" ? to?.url : record.url;
    const base: Base = {
      id: newId(started),
      adapter: adapter.id,
      env: "production",
      commit: to?.commit ?? "",
      command: `${adapter.cli} ${args.join(" ")}`,
      startedAt: started.toISOString(),
      rollbackOf: record.id,
      previous: previousOf(record),
    };
    let rollback: DeployRecord;
    if (r.status !== 0) {
      rollback = { ...base, endedAt: now().toISOString(), status: "failed", error: tailOf(r) || `exit ${r.status}` };
    } else {
      const smoke = url ? await runSmoke(root, url, clis.fetch) : undefined;
      rollback = {
        ...base,
        endedAt: now().toISOString(),
        status: "done",
        ...(to?.deploymentId ? { deploymentId: to.deploymentId } : {}),
        ...(url ? { url } : {}),
        ...(smoke ? { smoke } : {}),
      };
      saveRecord(root, { ...record, rolledBackBy: rollback.id });
    }
    saveRecord(root, rollback);
    return rollback;
  });
}
