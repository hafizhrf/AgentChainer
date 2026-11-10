import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** M3-E2: the task's evidence report against its run, for a run that ended. */
  evidence?: EvidenceCheck;
  /** Why the run didn't get as far as the checks, if it didn't. */
  error?: string;
};

/**
 * M3-E2: a finished task's evidence report against what happened. `reportMatches` when the report's gate runs (the
 * baseline and every round) are exactly the run's records; `rerun` has the last round's commands with the exit code
 * recorded and the one they give when run again by hand, in the same folder.
 */
export type EvidenceCheck = {
  reportMatches: boolean;
  rerun: { gate: string; recorded: number | null; now: number }[];
};

/** Whether a stored report (`evidence.json`) holds exactly the run's recorded gate runs. */
export function reportMatchesRun(task: Task, stored: unknown): boolean {
  const gates = (stored as { gates?: { baseline?: unknown; runs?: unknown } } | null)?.gates;
  return (
    JSON.stringify(gates?.runs ?? null) === JSON.stringify(task.run?.gates ?? []) &&
    JSON.stringify(gates?.baseline ?? null) === JSON.stringify(task.run?.baseline ?? [])
  );
}

/** How long one acceptance check may take. */
const CHECK_TIMEOUT_MS = 180_000;

/**
 * Runs `c` once with `variant` on a fresh copy of its fixture (with the case's start files committed): the written contract is triaged and approved at the
 * case's tier (no drafting, so every variant starts from the same contract), the run goes to its end, then the hidden
 * files are copied in and the acceptance checks run. `cancelAbove` cancels the run once it costs more than that.
 */
export async function runCase(
  client: SidecarClient,
  c: EvalCase,
  variant: Variant,
  opts: { root: string; cancelAbove: number; log?: (line: string) => void },
): Promise<CaseRun> {
  const cwd = copyFixture(c.fixture);
  if (c.start) {
    cpSync(path.join(opts.root, "start", c.start), cwd, { recursive: true });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "start"], {
      cwd,
      stdio: "ignore",
    });
  }
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
    await client.request("task.start", {
      cwd,
      id: taskId,
      permissionMode: "acceptEdits",
      model: variant.model,
      ...(Object.keys(variant.agents).length ? { agents: variant.agents } : {}),
    });
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
    // Before the hidden files go in, so the gates see what the task left.
    if (end.run && end.state !== "cancelled") row.evidence = await checkEvidence(client, cwd, end, code);
    if (c.hidden) cpSync(path.join(opts.root, "hidden", c.id), code, { recursive: true });
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

async function checkEvidence(client: SidecarClient, cwd: string, task: Task, code: string): Promise<EvidenceCheck> {
  const { path: report } = await client.request("task.evidence", { cwd, id: task.id });
  const stored: unknown = JSON.parse(readFileSync(report.replace(/\.md$/, ".json"), "utf8"));
  const gates = task.run?.gates ?? [];
  const last = Math.max(-1, ...gates.map((g) => g.round));
  return {
    reportMatches: reportMatchesRun(task, stored),
    // A gate that timed out has no exit code to compare.
    rerun: gates
      .filter((g) => g.round === last && !g.timedOut)
      .map((g) => ({
        gate: `${g.kind} \`${g.command}\``,
        recorded: g.exitCode,
        now: runShell(g.command, g.package === "." ? code : path.join(code, ...g.package.split("/"))),
      })),
  };
}

/** A gate's command again, through the shell as the gates run it. */
function runShell(command: string, cwd: string): number {
  const { NODE_TEST_CONTEXT: _runner, ...env } = process.env;
  try {
    execSync(command, { cwd, stdio: "ignore", timeout: CHECK_TIMEOUT_MS, env: { ...env, CI: "1" } });
    return 0;
  } catch (err) {
    return (err as { status?: number | null }).status ?? -1;
  }
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
