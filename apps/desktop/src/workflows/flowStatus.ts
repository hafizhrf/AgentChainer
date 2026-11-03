import type { Task, TaskRun } from "@agentchainer/protocol";
import type { WorkflowEdge, WorkflowNode } from "./workflowGraph.ts";

/**
 * A run on its workflow's canvas (UX-14, docs/design/chat-and-tasks.md §6.1): each step's state from the run's
 * timeline, and how many fix rounds each fix edge has used. Pure, so the canvas and its tests read the same thing.
 */

export type NodeStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";
export type NodeState = {
  status: NodeStatus;
  costUsd: number;
  /** The step's latest timeline entry, which the thread can scroll to. */
  entryId?: string;
  /** Turns of the step in the run: its first one, and each fix round it took. */
  turns: number;
};

/**
 * By node id: the state of each step the run's timeline names. A step with no entry yet is pending. `live` is whether
 * the run is going on: a step still "running" in a run that isn't (the app closed mid-run, UX-17) is shown stopped.
 */
export function flowStates(
  nodes: WorkflowNode[],
  run: TaskRun | null | undefined,
  live = true,
): Record<string, NodeState> {
  const out: Record<string, NodeState> = {};
  const ended = run ? !run.steps.some((s) => s.status === "running") && run.endedAt !== undefined : false;
  for (const node of nodes) {
    if (!node.stepId) continue;
    // A step's own entries and its fix rounds; the baseline (the gates before the task) isn't the gates step.
    const entries = (run?.steps ?? []).filter((e) => e.step === node.stepId && e.kind !== "baseline");
    const last = entries.at(-1);
    out[node.id] = {
      status: entries.some((e) => e.status === "running")
        ? live
          ? "running"
          : "cancelled"
        : last
          ? last.status
          : ended
            ? "skipped"
            : "pending",
      costUsd: entries.reduce((sum, e) => sum + e.costUsd, 0),
      ...(last ? { entryId: last.id } : {}),
      turns: entries.filter((e) => e.kind === "agent" || e.kind === "fix").length,
    };
  }
  return out;
}

/** By edge id: the fix rounds a step took, on each fix edge into it. */
export function fixesUsed(edges: WorkflowEdge[], run: TaskRun | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) {
    if (e.kind !== "fix" || !e.targetStep) continue;
    out[e.id] = (run?.steps ?? []).filter((s) => s.kind === "fix" && s.step === e.targetStep).length;
  }
  return out;
}

/** An XL task's sub-tasks as a graph: each one a node, in rows by what it waits for, with an edge per dependency. */
export function subtaskGraph(subtasks: Task[]): {
  nodes: { id: string; label: string; state: Task["state"]; tier: string; x: number; y: number }[];
  edges: { id: string; source: string; target: string }[];
} {
  const level = new Map<string, number>();
  const depth = (t: Task, seen = new Set<string>()): number => {
    const known = level.get(t.id);
    if (known !== undefined) return known;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const deps = (t.dependsOn ?? []).map((d) => subtasks.find((s) => s.id === d)).filter((s): s is Task => !!s);
    const d = deps.length ? 1 + Math.max(...deps.map((x) => depth(x, seen))) : 0;
    level.set(t.id, d);
    return d;
  };
  const rows = new Map<number, number>();
  const nodes = subtasks.map((t) => {
    const d = depth(t);
    const col = rows.get(d) ?? 0;
    rows.set(d, col + 1);
    return {
      id: t.id,
      label: t.title ?? t.request,
      state: t.state,
      tier: t.triage?.chosen ?? "",
      x: col * 260,
      y: d * 112,
    };
  });
  const edges = subtasks.flatMap((t) =>
    (t.dependsOn ?? []).filter((d) => level.has(d)).map((d) => ({ id: `${d}->${t.id}`, source: d, target: t.id })),
  );
  return { nodes, edges };
}
