import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  type MetricsSummary,
  type MetricsTask,
  type RunSummary,
  type Task,
  TaskIdSchema,
  type TIERS,
} from "@agentchainer/protocol";
import { AC_DIR } from "../ac-dir.ts";
import { allRuns } from "./run-history.ts";
import { loadTask } from "./store.ts";

/**
 * Local metrics (M7-01, docs/design/evals.md §4), from the workspace's own task records; nothing leaves the computer.
 * A task counts when it has run at least once. An XL task counts once: its sub-tasks' costs are already in it.
 */

type Tier = (typeof TIERS)[number];
export type MetricsFilter = { since?: string; tier?: Tier };

/** Every top-level task in the workspace; unreadable ones are left out, as the task list does. */
export function loadAllTasks(root: string): Task[] {
  const dir = path.join(root, AC_DIR, "tasks");
  if (!existsSync(dir)) return [];
  const out: Task[] = [];
  for (const id of readdirSync(dir)) {
    if (!TaskIdSchema.safeParse(id).success) continue;
    try {
      const t = loadTask(root, id);
      if (!t.parent) out.push(t);
    } catch {
      // not a valid task
    }
  }
  return out;
}

/** Done, or its PR was merged with every gate green. */
export const succeeded = (t: Task) => t.state === "done" || (t.pr?.merged !== undefined && !t.pr.merged.accepted);

/** A person had to step in: accepted with risk, merged with gates not green, or a Fix CI round. */
export const neededPerson = (t: Task) =>
  t.state === "accepted" || Boolean(t.pr?.merged?.accepted) || (t.pr?.fixes?.length ?? 0) > 0;

/** The value below which `p` of the sorted samples fall (nearest rank). */
export function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

const finished = (r: RunSummary) => r.state !== "running";
const rate = (part: number, whole: number) => (whole ? part / whole : null);

/** A workflow's key and its name in the breakdown: the app's by id, a project's by file and hash. */
function workflowOf(r: RunSummary): { key: string; label: string } {
  const w = r.workflow;
  return w.source === "task"
    ? { key: `${w.id}@${w.hash}`, label: `a task's own flow (${w.hash})` }
    : w.source === "project"
      ? { key: `${w.id}@${w.hash}`, label: `${w.file ?? w.id} (${w.hash})` }
      : { key: w.id, label: `${w.id} v${w.version}` };
}

export function computeMetrics(tasks: Task[], filter: MetricsFilter = {}): MetricsSummary {
  const picked = tasks.filter(
    (t) =>
      allRuns(t).length > 0 &&
      (!filter.since || t.createdAt >= filter.since) &&
      (!filter.tier || t.triage?.chosen === filter.tier),
  );
  const rows: MetricsTask[] = picked
    .map((t) => {
      const runs = allRuns(t);
      const last = runs.at(-1);
      return {
        id: t.id,
        request: t.request,
        tier: t.triage?.chosen ?? null,
        state: t.state,
        createdAt: t.createdAt,
        costUsd: t.costUsd,
        runs: runs.length,
        gatesPassed: last?.gatesPassed ?? null,
        fixRounds: runs.reduce((n, r) => n + r.fixRounds, 0),
        ciFixes: t.pr?.fixes?.length ?? 0,
        success: succeeded(t),
        neededPerson: neededPerson(t),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const runs = picked.flatMap(allRuns).filter(finished);
  const judged = runs.filter((r) => r.gatesPassed !== null);
  const durations = runs
    .flatMap((r) => (r.endedAt ? [Date.parse(r.endedAt) - Date.parse(r.startedAt)] : []))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const total = rows.reduce((n, r) => n + r.costUsd, 0);
  const successes = rows.filter((r) => r.success).length;

  const byTier = new Map<string, { tasks: number; successes: number; costUsd: number }>();
  for (const r of rows) {
    const key = r.tier ?? "—";
    const e = byTier.get(key) ?? { tasks: 0, successes: 0, costUsd: 0 };
    byTier.set(key, {
      tasks: e.tasks + 1,
      successes: e.successes + (r.success ? 1 : 0),
      costUsd: e.costUsd + r.costUsd,
    });
  }
  const byWorkflow = new Map<
    string,
    { label: string; runs: number; judged: number; passed: number; costUsd: number }
  >();
  for (const r of runs) {
    const { key, label } = workflowOf(r);
    const e = byWorkflow.get(key) ?? { label, runs: 0, judged: 0, passed: 0, costUsd: 0 };
    byWorkflow.set(key, {
      label,
      runs: e.runs + 1,
      judged: e.judged + (r.gatesPassed === null ? 0 : 1),
      passed: e.passed + (r.gatesPassed ? 1 : 0),
      costUsd: e.costUsd + r.costUsd,
    });
  }

  return {
    tasks: rows.length,
    runs: runs.length,
    gatePass: {
      rate: rate(judged.filter((r) => r.gatesPassed).length, judged.length),
      judged: judged.length,
      unjudged: runs.length - judged.length,
    },
    costUsd: { total, perTask: rate(total, rows.length), perSuccess: successes ? total / successes : null, successes },
    durationMs: durations.length
      ? { p50: percentile(durations, 0.5), p90: percentile(durations, 0.9), count: durations.length }
      : null,
    retries: {
      extraRuns: rows.reduce((n, r) => n + r.runs - 1, 0),
      fixRounds: rows.reduce((n, r) => n + r.fixRounds, 0),
      ciFixes: rows.reduce((n, r) => n + r.ciFixes, 0),
    },
    humanFix: {
      rate: rate(rows.filter((r) => r.neededPerson).length, rows.length),
      tasks: rows.filter((r) => r.neededPerson).length,
    },
    byTier: [...byTier].map(([tier, e]) => ({ tier, ...e })).sort((a, b) => a.tier.localeCompare(b.tier)),
    byWorkflow: [...byWorkflow]
      .map(([key, e]) => ({
        key,
        label: e.label,
        runs: e.runs,
        gatePassRate: rate(e.passed, e.judged),
        costUsd: e.costUsd,
      }))
      .sort((a, b) => b.runs - a.runs),
    taskList: rows,
  };
}
