import type { Task } from "@agentchainer/protocol";
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { request } from "../sidecar.ts";
import { fixesUsed, flowStates, type NodeState, type NodeStatus, subtaskGraph } from "../workflows/flowStatus.ts";
import { WorkflowCanvas } from "../workflows/WorkflowCanvas.tsx";
import { STEP_H, STEP_W, type WorkflowEdge, type WorkflowNode, workflowGraph } from "../workflows/workflowGraph.ts";
import { stateLabel } from "./run.ts";

type Loaded = { workflow: Record<string, unknown>; source: "app" | "project" | "task" } | null;

/** A sub-task's state as a step's on the canvas. */
const SUBTASK_STATUS: Record<Task["state"], NodeStatus> = {
  draft: "pending",
  ready: "pending",
  running: "running",
  done: "done",
  accepted: "done",
  failed: "failed",
  unverified: "failed",
  cancelled: "cancelled",
  interrupted: "cancelled",
};

/**
 * A task's Flow tab (UX-14, docs/design/chat-and-tasks.md §6.1): the workflow its run follows on the canvas, each step
 * with its live state, the hand-offs between agents, and the fix rounds used. Clicking a step shows it in the thread.
 * An XL task shows its sub-tasks instead, with what each waits for; clicking one opens it.
 */
export function FlowPanel({
  task,
  cwd,
  subtasks,
  onJump,
  onOpenTask,
  onTask,
}: {
  task: Task;
  cwd: string;
  subtasks: Task[];
  /** Shows a timeline entry (a step) in the thread. */
  onJump: (entryId: string) => void;
  onOpenTask: (id: string) => void;
  /** The task after its own flow was proposed or dropped. */
  onTask: (task: Task) => void;
}) {
  const [busy, setBusy] = useState<"propose" | "drop" | null>(null);
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const run = task.run;
  // A new run, a project workflow changed, or a new tier: draw what it runs now.
  const key = [
    task.id,
    task.triage?.chosen,
    run?.workflow.id,
    run?.workflow.hash,
    run?.startedAt,
    task.flow?.hash,
  ].join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names what the drawn workflow depends on.
  useEffect(() => {
    let live = true;
    request("task.workflow", { cwd, id: task.id }).then(
      (r) => {
        if (!live) return;
        setLoaded(r);
        setError(null);
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [cwd, key]);

  const xl = task.triage?.chosen === "XL" && subtasks.length > 0;
  const graph = useMemo(() => {
    if (xl) {
      const g = subtaskGraph(subtasks);
      const nodes: WorkflowNode[] = g.nodes.map((n) => ({
        id: n.id,
        path: [n.id],
        kind: "agent",
        label: n.label,
        detail: `${n.tier} · ${stateLabel(n.state).label}`,
        x: n.x,
        y: n.y,
        width: STEP_W,
        height: STEP_H,
      }));
      const edges: WorkflowEdge[] = g.edges.map((e) => ({ ...e, kind: "next" }));
      const states: Record<string, NodeState> = Object.fromEntries(
        subtasks.map((t) => [t.id, { status: SUBTASK_STATUS[t.state], costUsd: t.costUsd, turns: 0 }]),
      );
      return { nodes, edges, states, fixes: {} };
    }
    const { nodes, edges } = workflowGraph(loaded?.workflow ?? null);
    return { nodes, edges, states: flowStates(nodes, run), fixes: fixesUsed(edges, run) };
  }, [xl, subtasks, loaded, run]);

  /** A draft S, M or L task can get its own flow from AI, or drop it (UX-14). */
  async function own(kind: "propose" | "drop") {
    setBusy(kind);
    setError(null);
    try {
      onTask(
        kind === "propose"
          ? await request("task.proposeFlow", { cwd, id: task.id })
          : await request("task.dropFlow", { cwd, id: task.id }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }
  const tier = task.triage?.chosen;
  const canOwn = task.state === "draft" && !!task.contract && !!tier && tier !== "XL";
  const ownFlow = canOwn ? (
    task.flow ? (
      <div className="flow-own">
        <p className="flow-text">
          <Sparkles size={13} aria-hidden /> <strong>This task's own flow:</strong> {task.flow.summary}
        </p>
        <p className="muted flow-text">
          It's approved with the contract, and the run follows it instead of the {tier} flow.
        </p>
        <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void own("drop")}>
          {busy === "drop" && <Loader2 size={13} className="spin" />}
          Use the {tier} flow
        </button>
      </div>
    ) : (
      <div className="flow-own">
        <p className="muted flow-text">
          The {tier} flow fits most tasks. Claude can shape one for this task from its contract, e.g. a test planner
          first, or a security review; it's checked like a hand-written workflow.
        </p>
        <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void own("propose")}>
          {busy === "propose" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
          {busy === "propose" ? "Shaping a flow…" : "Suggest a flow for this task"}
        </button>
      </div>
    )
  ) : null;

  if (error) {
    return (
      <>
        <p className="warn flow-note">{error}</p>
        {ownFlow}
      </>
    );
  }
  if (loaded === undefined && !xl) return <p className="muted flow-note">Loading the flow…</p>;
  if (loaded === null && !xl) {
    return <p className="muted flow-note">The flow shows once the task has a tier: draft its contract first.</p>;
  }
  const workflowId = typeof loaded?.workflow.id === "string" ? loaded.workflow.id : "";
  return (
    <div className="flow-panel">
      <p className="muted flow-note">
        {xl
          ? "The sub-tasks, each on its own tier's workflow. Click one to open it."
          : `${loaded?.source === "task" ? "This task's own" : loaded?.source === "project" ? "The project's" : "The app's"} ${workflowId}${
              run ? "" : ", as the run will follow it"
            }. Click a step to see it in the thread.`}
      </p>
      {ownFlow}
      <WorkflowCanvas
        nodes={graph.nodes}
        edges={graph.edges}
        selected={null}
        states={graph.states}
        fixes={graph.fixes}
        onSelect={(id) => {
          if (!id) return;
          if (xl) return onOpenTask(id);
          const entry = graph.states[id]?.entryId;
          if (entry) onJump(entry);
        }}
      />
    </div>
  );
}
