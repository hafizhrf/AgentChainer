import "@xyflow/react/dist/base.css";
import {
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { CircleCheck, CircleDashed, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { DotGrid } from "../graph/DotGrid.tsx";
import { usd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { agentLabel, costText } from "../tasks/stepAgent.ts";
import type { NodeState, NodeStatus } from "./flowStatus.ts";
import type { WorkflowEdge, WorkflowNode } from "./workflowGraph.ts";

type NodeData = { node: WorkflowNode; selected: boolean; state?: NodeState };
type FlowNode = Node<NodeData>;

const KIND_TEXT: Record<WorkflowNode["kind"], string> = {
  get agent() {
    return t("workflows.canvas.kindAgent");
  },
  get gates() {
    return t("workflows.canvas.kindGates");
  },
  get group() {
    return t("workflows.canvas.kindGroup");
  },
  get member() {
    return t("workflows.canvas.kindMember");
  },
  get split() {
    return t("workflows.canvas.kindSplit");
  },
  get subtasks() {
    return t("workflows.canvas.kindSubtasks");
  },
  get integration() {
    return t("workflows.canvas.kindIntegration");
  },
};

const STATUS_TEXT: Record<NodeStatus, string> = {
  get pending() {
    return t("workflows.canvas.statusPending");
  },
  get running() {
    return t("workflows.canvas.statusRunning");
  },
  get done() {
    return t("workflows.canvas.statusDone");
  },
  get failed() {
    return t("workflows.canvas.statusFailed");
  },
  get cancelled() {
    return t("workflows.canvas.statusCancelled");
  },
  get skipped() {
    return t("workflows.canvas.statusSkipped");
  },
};

/** A step's state on a run's canvas (UX-14): an icon and a word, never color alone (X-12). */
function StatusMark({ state }: { state: NodeState }) {
  const Icon =
    state.status === "running"
      ? LoaderCircle
      : state.status === "done"
        ? CircleCheck
        : state.status === "failed"
          ? CircleX
          : state.status === "cancelled" || state.status === "skipped"
            ? CircleMinus
            : CircleDashed;
  return (
    <span className={`step-status ${state.status}`}>
      <Icon size={12} className={state.status === "running" ? "spin" : undefined} aria-hidden />
      {STATUS_TEXT[state.status]}
      {state.turns > 1 ? ` · ${t("workflows.canvas.turns", { count: state.turns })}` : ""}
      {state.costUsd > 0 || state.costKind === "unknown"
        ? ` · ${costText(usd(state.costUsd, 3), state.costKind, undefined).text}`
        : ""}
    </span>
  );
}

const StepView = memo(function StepView({ data }: NodeProps<FlowNode>) {
  const { node, selected, state } = data;
  return (
    <div
      className={`graph-node workflow-step ${node.kind}${selected ? " selected" : ""}${state ? ` status-${state.status}` : ""}`}
      title={
        state
          ? t("workflows.canvas.stepTitleWithStatus", {
              kind: KIND_TEXT[node.kind],
              label: node.label,
              status: STATUS_TEXT[state.status],
            })
          : t("workflows.canvas.stepTitle", { kind: KIND_TEXT[node.kind], label: node.label })
      }
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {/* Fix loops run beside the column on the right (UX-17): out lower down, back in higher up. */}
      <Handle id="fix-in" type="target" position={Position.Right} style={{ top: "35%" }} isConnectable={false} />
      {state ? <StatusMark state={state} /> : <span className="workflow-step-kind">{KIND_TEXT[node.kind]}</span>}
      <strong className="truncate">{node.label}</strong>
      {/* With its agent's chip below, the detail gets one line so the node keeps its size. */}
      <span className={`muted ${state?.agent || state?.model ? "clamp-1" : "clamp-2"}`} title={node.detail}>
        {node.detail}
      </span>
      {(state?.agent || state?.model) && (
        <span
          className={`chip step-agent${state.agent && state.agent !== "claude" ? " other" : ""}`}
          title={t("tasks.run.ranBy", { agent: agentLabel(state.agent, state.model) })}
        >
          {agentLabel(state.agent, state.model)}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <Handle id="fix-out" type="source" position={Position.Right} style={{ top: "65%" }} isConnectable={false} />
    </div>
  );
});

const GroupView = memo(function GroupView({ data }: NodeProps<FlowNode>) {
  const { node, selected } = data;
  return (
    <div className={`workflow-group${selected ? " selected" : ""}`}>
      <span className="workflow-group-label">
        <strong>{node.label}</strong> <span className="muted">{node.detail}</span>
      </span>
    </div>
  );
});

/** Nothing to see: it makes room on the right for the fix lanes, so fitting the view keeps their labels in. */
const LaneRoom = memo(function LaneRoom() {
  return null;
});

const NODE_TYPES = { step: StepView, group: GroupView, room: LaneRoom };

type FixData = { lane: number; label: string; title: string };

/** Space between the column and the first fix lane, and between lanes. */
const LANE_GAP = 28;
const LANE_STEP = 24;
const CORNER = 8;
/** About the width of a fix label ("fix 0/2"). */
const LABEL_ROOM = 64;

/**
 * A fix loop (UX-17): it leaves its step on the right, runs up its own lane beside the column, and comes back into the
 * step that gets the failures. Each loop has its own lane, and its label sits in that lane halfway along it, so two
 * loops' labels never overlap each other or a step.
 */
const FixEdge = memo(function FixEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
}: EdgeProps<Edge<FixData>>) {
  const lane = Math.max(sourceX, targetX) + LANE_GAP + (data?.lane ?? 0) * LANE_STEP;
  const r = Math.min(CORNER, Math.abs(sourceY - targetY) / 2);
  const up = targetY < sourceY ? -1 : 1;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `H ${lane - r}`,
    `Q ${lane} ${sourceY} ${lane} ${sourceY + up * r}`,
    `V ${targetY - up * r}`,
    `Q ${lane} ${targetY} ${lane - r} ${targetY}`,
    `H ${targetX}`,
  ].join(" ");
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} />
      {data && (
        <EdgeLabelRenderer>
          <span
            className="workflow-fix-label"
            title={data.title}
            style={{ transform: `translate(${lane + 6}px, ${(sourceY + targetY) / 2}px) translateY(-50%)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const EDGE_TYPES = { fix: FixEdge };

const FIT_PADDING = 0.12;
/** Room left of the column for the zoom controls, so they never cover a step (UX-17). */
const CONTROLS_ROOM = 56;

/**
 * The workflow canvas (M6-04): the steps as React Flow nodes, read-only as a graph. Clicking a step selects it for
 * the form beside it; the form and the step list are how it's edited, by mouse or keyboard.
 */
export function WorkflowCanvas({
  nodes,
  edges,
  selected,
  onSelect,
  states,
  fixes,
}: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** A run on the canvas (UX-14): each step's state, by node id. */
  states?: Record<string, NodeState>;
  /** A run's fix rounds used, by fix edge id. */
  fixes?: Record<string, number>;
}) {
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null);
  const structure = nodes.map((n) => n.id).join("|");

  // A step added or removed may land off screen: fit the view again when the structure changes.
  useEffect(() => {
    if (structure) void flow.current?.fitView({ padding: FIT_PADDING, maxZoom: 1, duration: 200 });
  }, [structure]);

  const flowNodes = useMemo<FlowNode[]>(() => {
    const steps: FlowNode[] = nodes.map((n) => ({
      id: n.id,
      type: n.kind === "group" ? "group" : "step",
      position: { x: n.x, y: n.y },
      width: n.width,
      height: n.height,
      // A node's size is known: with it, React Flow keeps the handles it measured when a run's update rebuilds the
      // nodes. Without it, it drops them, and the edges vanish until the node's size changes, which it doesn't.
      measured: { width: n.width, height: n.height },
      data: { node: n, selected: n.id === selected, ...(states?.[n.id] ? { state: states[n.id] } : {}) },
      ...(n.kind === "group" ? { zIndex: -1 } : {}),
    }));
    const first = nodes[0];
    if (!first) return steps;
    const room = (id: string, x: number): FlowNode => ({
      id,
      type: "room",
      position: { x, y: first.y },
      width: 1,
      height: 1,
      measured: { width: 1, height: 1 },
      selectable: false,
      data: { node: first, selected: false },
    });
    const left = Math.min(...nodes.map((n) => n.x));
    const loops = edges.filter((e) => e.kind === "fix").length;
    const right = Math.max(...nodes.filter((n) => n.kind !== "group").map((n) => n.x + n.width));
    return [
      ...steps,
      room("~controls", left - CONTROLS_ROOM),
      // The last fix lane, plus room for its label.
      ...(loops ? [room("~lanes", right + LANE_GAP + (loops - 1) * LANE_STEP + LABEL_ROOM)] : []),
    ];
  }, [nodes, edges, selected, states]);

  const flowEdges = useMemo<Edge[]>(() => {
    const names = new Map(nodes.map((n) => [n.id, n.label]));
    let lane = 0;
    return edges.map((e): Edge => {
      if (e.kind !== "fix") {
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "smoothstep",
          className: "graph-edge",
          markerEnd: { type: MarkerType.ArrowClosed },
        };
      }
      const max = e.maxRounds ?? "?";
      const used = fixes?.[e.id];
      const back = names.get(e.target) ?? t("workflows.canvas.earlierStep");
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: "fix-out",
        targetHandle: "fix-in",
        type: "fix",
        data: {
          lane: lane++,
          label:
            used !== undefined ? t("workflows.canvas.fixUsed", { used, max }) : t("workflows.graph.fixMax", { max }),
          title:
            used !== undefined
              ? t("workflows.canvas.fixUsedTitle", { used, max, back })
              : t("workflows.canvas.fixMaxTitle", { max, back }),
        },
        className: `graph-edge fix${used ? " used" : ""}`,
        markerEnd: { type: MarkerType.ArrowClosed },
      };
    });
  }, [nodes, edges, fixes]);

  return (
    <div className="session-graph workflow-canvas">
      <ReactFlow<FlowNode>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onInit={(instance) => {
          flow.current = instance;
        }}
        onNodeClick={(_, n) => n.type !== "room" && onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: FIT_PADDING, maxZoom: 1 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <DotGrid />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!nodes.length && <p className="graph-empty muted">{t("workflows.canvas.empty")}</p>}
    </div>
  );
}
