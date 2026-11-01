import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type DeployRecord, DeployRecordSchema, type DeployTarget, RpcErrorCode } from "@agentchainer/protocol";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { RpcFailure } from "../rpc.ts";
import { loadTask } from "../tasks/store.ts";
import { codeRootIn } from "../tasks/worktree.ts";
import { git } from "../workspace.ts";
import { ADAPTERS, type Adapter } from "./adapters.ts";
import { type Cli, cliRunner, type RunCli, resolveCli } from "./cli.ts";
import { runSmoke } from "./smoke.ts";

/**
 * Deploys (M6, docs/design/deploy-and-canvas.md): which providers a workspace can deploy to, a task's preview deploy
 * with its smoke test, and the records of every deploy. Always a person's click; agents can't deploy (the guard).
 */

const invalid = (message: string) => new RpcFailure(RpcErrorCode.invalidParams, message);
const DEPLOYS = "deploys";

/** How to reach a CLI: the real one by default; tests pass stand-ins. */
export type Clis = { resolve: (name: string) => Cli | null; runner: (cli: Cli) => RunCli; fetch?: typeof fetch };
const realClis: Clis = { resolve: (n) => resolveCli(n), runner: cliRunner };

const HINTS: Record<string, string> = {
  vercel: "Install it with `npm i -g vercel`, then sign in with `vercel login` in a terminal.",
};

async function targetOf(a: Adapter, root: string, clis: Clis): Promise<DeployTarget | null> {
  const found = a.detect(root);
  if (!found) return null;
  const base = { adapter: a.id, label: a.label, config: found.config };
  const cli = clis.resolve(a.cli);
  if (!cli) return { ...base, state: "missing", hint: HINTS[a.id] ?? `Install the ${a.cli} CLI.` };
  if (found.problem) return { ...base, state: "not-linked", hint: found.problem };
  const signedIn = await a.signedIn(clis.runner(cli), root);
  return signedIn
    ? { ...base, state: "ready" }
    : { ...base, state: "signed-out", hint: `Sign in with \`${a.cli} login\` in a terminal.` };
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

/* ---------- Preview ---------- */

/** Deploys in progress, by workspace and adapter: one at a time each. */
const busy = new Set<string>();

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
  const adapter = ADAPTERS.find((a) => a.id === adapterId);
  if (!adapter) throw invalid(`Unknown deploy provider: ${adapterId}.`);
  const task = loadTask(root, taskId);
  const wt = task.worktree;
  const code = wt && !wt.removed && existsSync(wt.path) ? codeRootIn(root, wt.path) : root;
  const target = await targetOf(adapter, root, clis);
  if (target?.state !== "ready") throw invalid(target?.hint ?? `This workspace isn't set up for ${adapter.label}.`);
  const key = `${root}\0${adapter.id}`;
  if (busy.has(key)) throw invalid(`A ${adapter.label} deploy is already running in this workspace.`);
  busy.add(key);
  try {
    adapter.prepare(root, code);
    const cli = clis.resolve(adapter.cli);
    if (!cli) throw invalid(`The ${adapter.cli} CLI isn't installed.`);
    const args = adapter.deployArgs("preview");
    const started = now();
    const base = {
      id: `${started.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`,
      adapter: adapter.id,
      env: "preview" as const,
      taskId,
      ...(wt ? { branch: wt.branch } : {}),
      commit: git(["rev-parse", "HEAD"], code).stdout.trim(),
      command: `${adapter.cli} ${args.join(" ")}`,
      startedAt: started.toISOString(),
    };
    // A build can take several minutes on the provider's side.
    const r = await clis.runner(cli)(args, code, { timeoutMs: 1_200_000 });
    const out = r.status === 0 ? adapter.parse(r) : null;
    let record: DeployRecord;
    if (!out) {
      const tail = (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ").slice(0, 400);
      record = {
        ...base,
        endedAt: now().toISOString(),
        status: "failed",
        error:
          r.status === 0
            ? "The deploy finished, but its URL couldn't be read from the output."
            : tail || `exit ${r.status}`,
      };
    } else {
      const smoke = await runSmoke(code, out.url, clis.fetch);
      record = { ...base, endedAt: now().toISOString(), status: "done", ...out, smoke };
    }
    saveRecord(root, record);
    return record;
  } finally {
    busy.delete(key);
  }
}
