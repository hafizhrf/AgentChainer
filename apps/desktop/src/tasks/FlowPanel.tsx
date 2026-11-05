import type { Task } from "@agentchainer/protocol";
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n/index.ts";
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

/** Whose workflow the canvas draws, and whether the run has started on it. */
function sourceNote(source: "app" | "project" | "task" | undefined, workflow: string, started: boolean): string {
  switch (source) {
    case "task":
      return started ? t("tasks.flow.sourceTask", { workflow }) : t("tasks.flow.sourceTaskPlanned", { workflow });
    case "project":
      return started ? t("tasks.flow.sourceProject", { workflow }) : t("tasks.flow.sourceProjectPlanned", { workflow });
    default:
      return started ? t("tasks.flow.sourceApp", { workflow }) : t("tasks.flow.sourceAppPlanned", { workflow });
  }
}

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
        subtasks.map((sub) => [sub.id, { status: SUBTASK_STATUS[sub.state], costUsd: sub.costUsd, turns: 0 }]),
      );
      return { nodes, edges, states, fixes: {} };
    }
    const { nodes, edges } = workflowGraph(loaded?.workflow ?? null);
    return { nodes, edges, states: flowStates(nodes, run, task.state === "running"), fixes: fixesUsed(edges, run) };
  }, [xl, subtasks, loaded, run, task.state]);

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
          <Sparkles size={13} aria-hidden /> <strong>{t("tasks.flow.ownFlow")}</strong> {task.flow.summary}
        </p>
        <p className="muted flow-text">{t("tasks.flow.ownFlowNote", { tier: tier ?? "" })}</p>
        <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void own("drop")}>
          {busy === "drop" && <Loader2 size={13} className="spin" />}
          {t("tasks.flow.useTierFlow", { tier: tier ?? "" })}
        </button>
      </div>
    ) : (
      <div className="flow-own">
        <p className="muted flow-text">{t("tasks.flow.suggestNote", { tier: tier ?? "" })}</p>
        <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void own("propose")}>
          {busy === "propose" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
          {busy === "propose" ? t("tasks.flow.shaping") : t("tasks.flow.suggest")}
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
  if (loaded === undefined && !xl) return <p className="muted flow-note">{t("tasks.flow.loading")}</p>;
  if (loaded === null && !xl) {
    return <p className="muted flow-note">{t("tasks.flow.noTier")}</p>;
  }
  const workflowId = typeof loaded?.workflow.id === "string" ? loaded.workflow.id : "";
  return (
    <div className="flow-panel">
      <p className="muted flow-note">
        {xl ? t("tasks.flow.subtasksNote") : sourceNote(loaded?.source, workflowId, !!run)}
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
