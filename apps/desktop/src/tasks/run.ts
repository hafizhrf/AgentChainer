import type { AgentEvent, GateRun, StepRun, Task } from "@agentchainer/protocol";
import { applyEvent, closeAssistant, type Item } from "../transcript.ts";

/** A task's run on the task page (M3-06): what may run, how states read, step transcripts and gate rounds. */

/** Tiers that run in this version; L and XL arrive with their workflows. */
export const RUNNABLE_TIERS: ReadonlySet<string> = new Set(["S", "M"]);
const STARTABLE: ReadonlySet<Task["state"]> = new Set(["ready", "done", "failed", "unverified", "cancelled"]);

/** Why the task can't run now, or null when it can. */
export function runBlocker(task: Task): string | null {
  const tier = task.triage?.chosen;
  if (task.state === "running") return "The task is running.";
  if (task.state === "interrupted") return "Resume the interrupted run, or revise the task.";
  if (!tier || !task.contract?.approvedAt || !STARTABLE.has(task.state))
    return "Approve the contract and the tier first.";
  if (!RUNNABLE_TIERS.has(tier)) return `${tier} tasks run in a later update; S and M tasks run now.`;
  return null;
}

export type Tone = "ok" | "warn" | "err" | "busy" | "muted";

export function stateLabel(state: Task["state"]): { label: string; tone: Tone } {
  switch (state) {
    case "running":
      return { label: "Running", tone: "busy" };
    case "done":
      return { label: "Done", tone: "ok" };
    case "failed":
      return { label: "Failed", tone: "err" };
    case "unverified":
      return { label: "Not verified", tone: "warn" };
    case "cancelled":
      return { label: "Stopped", tone: "muted" };
    case "interrupted":
      return { label: "Interrupted", tone: "warn" };
    case "ready":
      return { label: "Ready", tone: "ok" };
    default:
      return { label: "Draft", tone: "muted" };
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

/** The gate runs a timeline entry stands for: its gates entries are rounds 0, 1, 2, … in order. */
export function runsOfEntry(task: Task, entry: StepRun): GateRun[] {
  const run = task.run;
  if (!run || entry.kind !== "gates") return [];
  const round = run.steps.filter((s) => s.kind === "gates").findIndex((s) => s.id === entry.id);
  return run.gates.filter((g) => g.round === round);
}

/** "8 s", "3 min 4 s". */
export function duration(start: string, end: string | undefined, now = Date.now()): string {
  const seconds = Math.max(0, Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export const passedGate = (g: GateRun) => g.exitCode === 0 && !g.timedOut;

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
