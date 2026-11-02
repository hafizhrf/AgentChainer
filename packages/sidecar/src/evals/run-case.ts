import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "@agentchainer/protocol";
import { copyFixture } from "../detect/fixture-copy.ts";
import { WORKFLOWS_DIR } from "../tasks/project-workflows.ts";
import { lastRoundPassed } from "../tasks/run-history.ts";
import type { SidecarClient } from "./client.ts";
import type { EvalCase, Variant } from "./suite.ts";

/** One run of one case with one variant. */
export type CaseRun = {
  case: string;
  variant: string;
  /** Every acceptance check exited 0. */
  passed: boolean;
  /** The task's own verdict, which the acceptance checks don't trust. */
  state: Task["state"];
  gatesPassed: boolean | null;
  /** The gates that failed in the run's last round, e.g. a tool missing on this computer. */
  failedGates: string[];
  costUsd: number;
  durationMs: number;
  fixRounds: number;
  checks: { name: string; exitCode: number }[];
  /** Why the run didn't get as far as the checks, if it didn't. */
  error?: string;
};

/** How long one acceptance check may take. */
const CHECK_TIMEOUT_MS = 180_000;

/**
 * Runs `c` once with `variant` on a fresh copy of its fixture: the written contract is triaged and approved at the
 * case's tier (no drafting, so every variant starts from the same contract), the run goes to its end, then the hidden
 * files are copied in and the acceptance checks run. `cancelAbove` cancels the run once it costs more than that.
 */
export async function runCase(
  client: SidecarClient,
  c: EvalCase,
  variant: Variant,
  opts: { hiddenRoot: string; cancelAbove: number; log?: (line: string) => void },
): Promise<CaseRun> {
  const cwd = copyFixture(c.fixture);
  for (const [f, text] of Object.entries(variant.workflows)) {
    mkdirSync(path.join(cwd, WORKFLOWS_DIR), { recursive: true });
    writeFileSync(path.join(cwd, WORKFLOWS_DIR, f), text);
  }
  const row: CaseRun = {
    case: c.id,
    variant: variant.name,
    passed: false,
    state: "draft",
    gatesPassed: null,
    failedGates: [],
    costUsd: 0,
    durationMs: 0,
    fixRounds: 0,
    checks: [],
  };
  const t0 = Date.now();
  let taskId = "";
  let cancelled = false;
  const stop = client.onUpdate((t) => {
    if (t.id !== taskId) return;
    row.costUsd = t.costUsd;
    if (!cancelled && t.state === "running" && t.costUsd > opts.cancelAbove) {
      cancelled = true;
      opts.log?.(`    over $${opts.cancelAbove.toFixed(2)}: cancelling`);
      void client.request("task.cancel", { cwd, id: t.id }).catch(() => undefined);
    }
  });
  try {
    const created = await client.request("task.create", { cwd, request: c.request });
    taskId = created.id;
    const triaged = await client.request("task.retriage", {
      cwd,
      id: taskId,
      contract: { ...c.contract, task: c.request },
    });
    if (!triaged.contract || !triaged.triage) throw new Error("triage gave no contract");
    await client.request("task.approve", {
      cwd,
      id: taskId,
      contract: triaged.contract,
      tier: c.tier,
      ...(c.tier !== triaged.triage.proposed ? { reason: "eval case tier" } : {}),
      budgetUsd: triaged.triage.budgetUsd,
    });
    const ended = client.ended(taskId);
    await client.request("task.start", { cwd, id: taskId, permissionMode: "acceptEdits", model: variant.model });
    const end = await ended;
    Object.assign(row, {
      state: end.state,
      gatesPassed: end.run ? lastRoundPassed(end.run) : null,
      failedGates: lastRoundFailures(end),
      costUsd: end.costUsd,
      fixRounds: end.run?.fixRounds ?? 0,
    });
    row.durationMs = Date.now() - t0;
    const code = codeFolder(cwd, end);
    if (c.hidden) cpSync(path.join(opts.hiddenRoot, c.id), code, { recursive: true });
    row.checks = c.checks.map((check) => ({ name: check.name, exitCode: runCheck(check.argv, code) }));
    row.passed = row.checks.every((k) => k.exitCode === 0);
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
    row.durationMs = Date.now() - t0;
  } finally {
    stop();
  }
  return row;
}

function lastRoundFailures(task: Task): string[] {
  const gates = task.run?.gates ?? [];
  const last = Math.max(-1, ...gates.map((g) => g.round));
  return gates
    .filter((g) => g.round === last && (g.exitCode !== 0 || g.timedOut))
    .map((g) => `${g.kind} \`${g.command}\``);
}

/** A task's code is in the workspace, unless it ran in a worktree that still exists. */
function codeFolder(cwd: string, task: Task): string {
  const wt = task.worktree;
  return wt && !wt.removed && existsSync(wt.path) ? wt.path : cwd;
}

function runCheck(argv: string[], cwd: string): number {
  const [cmd = "", ...args] = argv;
  // Inside a test runner, a nested `node --test` reports to it and exits 0 whatever happened.
  const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;
  try {
    execFileSync(cmd === "node" ? process.execPath : cmd, args, {
      cwd,
      stdio: "ignore",
      timeout: CHECK_TIMEOUT_MS,
      env: { ...env, CI: "1" },
    });
    return 0;
  } catch (err) {
    return (err as { status?: number | null }).status ?? -1;
  }
}
