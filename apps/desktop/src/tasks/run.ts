import type { AgentEvent, GateRun, StepRun, Task } from "@agentchainer/protocol";
import { minutesSeconds } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { applyEvent, closeAssistant, type Item } from "../transcript.ts";

/** A task's run on the task page (M3-06): what may run, how states read, step transcripts and gate rounds. */

/** Tiers that run in this version. */
export const RUNNABLE_TIERS: ReadonlySet<string> = new Set(["S", "M", "L", "XL"]);
const STARTABLE: ReadonlySet<Task["state"]> = new Set([
  "ready",
  "done",
  "accepted",
  "failed",
  "unverified",
  "cancelled",
]);

/** Failed and not verified runs can end as accepted with risk, with a reason (M3-10). */
export const canAcceptRisk = (task: Task) => (task.state === "failed" || task.state === "unverified") && !!task.run;

/**
 * Why the task can't run now, or null when it can. An XL task runs once its sub-tasks are approved (`children`, in
 * the split's order); after that it goes on with Continue.
 */
export function runBlocker(task: Task, children: Task[] = []): string | null {
  const tier = task.triage?.chosen;
  if (task.state === "running") return t("tasks.blocker.running");
  if (task.state === "interrupted") return t("tasks.blocker.interrupted");
  if (!tier || !task.contract?.approvedAt || !STARTABLE.has(task.state)) return t("tasks.blocker.approveFirst");
  if (!RUNNABLE_TIERS.has(tier)) return t("tasks.blocker.laterUpdate", { tier });
  if (tier === "XL") {
    if (task.state !== "ready") return t("tasks.blocker.xlContinue");
    if (!task.subtasks?.length) return t("tasks.blocker.splitFirst");
    if (children.length < task.subtasks.length || children.some((c) => c.state !== "ready"))
      return t("tasks.blocker.approveSubtasks");
  }
  return null;
}

export const isXl = (task: Task) => task.triage?.chosen === "XL";

/** An XL run that stopped, failed or was cut off picks up where it was. */
export const canContinue = (task: Task) =>
  isXl(task) && !!task.run && ["failed", "unverified", "cancelled"].includes(task.state);

/** Why a sub-task can't run on its own now, or null: only in its worktree, and not while its XL task runs. */
export function childRunBlocker(child: Task, parent: Task | null): string | null {
  if (parent?.state === "running") return t("tasks.blocker.parentRunning");
  if (!child.worktree || child.worktree.removed) return t("tasks.blocker.runFromParent");
  if (child.state === "done") return t("tasks.blocker.childDone");
  return runBlocker(child);
}

/** "after 1, 3": the sub-tasks one waits for, by their numbers in the split. */
export function dependsLabel(child: Task, order: string[]): string | null {
  const numbers = (child.dependsOn ?? []).map((id) => order.indexOf(id) + 1).filter((n) => n > 0);
  return numbers.length ? t("tasks.subtasks.after", { numbers: numbers.join(", ") }) : null;
}

export type Tone = "ok" | "warn" | "err" | "busy" | "muted";

export function stateLabel(state: Task["state"]): { label: string; tone: Tone } {
  switch (state) {
    case "running":
      return { label: t("tasks.state.running"), tone: "busy" };
    case "done":
      return { label: t("tasks.state.done"), tone: "ok" };
    case "accepted":
      return { label: t("tasks.state.accepted"), tone: "warn" };
    case "failed":
      return { label: t("tasks.state.failed"), tone: "err" };
    case "unverified":
      return { label: t("tasks.state.unverified"), tone: "warn" };
    case "cancelled":
      return { label: t("tasks.state.cancelled"), tone: "muted" };
    case "interrupted":
      return { label: t("tasks.state.interrupted"), tone: "warn" };
    case "ready":
      return { label: t("tasks.state.ready"), tone: "ok" };
    default:
      return { label: t("tasks.state.draft"), tone: "muted" };
  }
}

/** Step transcripts by session id, from the events the page receives. */
export type StepItems = Record<string, Item[]>;

export function withStepEvent(items: StepItems, sessionId: string, event: AgentEvent, now?: number): StepItems {
  return { ...items, [sessionId]: applyEvent(items[sessionId] ?? [], event, now) };
}

/** A finished step's transcript, from its stored session. */
export function fromHistory(events: AgentEvent[]): Item[] {
  return closeAssistant(events.reduce<Item[]>((acc, e) => applyEvent(acc, e), []));
}

/** Gate runs by round, oldest first. */
export function gateRounds(runs: GateRun[]): GateRun[][] {
  const rounds = new Map<number, GateRun[]>();
  for (const r of runs) rounds.set(r.round, [...(rounds.get(r.round) ?? []), r]);
  return [...rounds.entries()].sort(([a], [b]) => a - b).map(([, rs]) => rs);
}

/**
 * The gate runs a timeline entry stands for: the baseline entry its own, gates entries rounds 0, 1, 2, … in order (an
 * XL run's integration gates included).
 */
export function runsOfEntry(task: Task, entry: StepRun): GateRun[] {
  const run = task.run;
  if (run && entry.kind === "baseline") return run.baseline;
  if (!run || entry.kind !== "gates") return [];
  const round = run.steps.filter((s) => s.kind === "gates").findIndex((s) => s.id === entry.id);
  return run.gates.filter((g) => g.round === round);
}

/** "8 s", "3 min 4 s". */
export function duration(start: string, end: string | undefined, now = Date.now()): string {
  return minutesSeconds(Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000)));
}

export const passedGate = (g: GateRun) => g.exitCode === 0 && !g.timedOut;

/** A gate is the same gate in another round when its kind and package match. */
export const gateKey = (g: GateRun) => `${g.kind}:${g.package}`;

/** The gates that already failed before the task started: their failures aren't the task's doing. */
export const failedBefore = (task: Task): ReadonlySet<string> =>
  new Set((task.run?.baseline ?? []).filter((g) => !passedGate(g)).map(gateKey));

/**
 * The version of a task to show. A run's notifications can overtake the reply of the request that started it, so a
 * reply only replaces what's shown when it's strictly newer; a notification also when it's as new.
 */
export function newer(current: Task | null, next: Task, from: "reply" | "notification"): Task {
  if (!current || current.id !== next.id) return next;
  const a = Date.parse(current.updatedAt);
  const b = Date.parse(next.updatedAt);
  return b > a || (from === "notification" && b === a) ? next : current;
}
