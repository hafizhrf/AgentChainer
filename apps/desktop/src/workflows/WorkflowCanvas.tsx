import "@xyflow/react/dist/base.css";
import {
  Background,
  Controls,
  type Edge,
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
import type { NodeState, NodeStatus } from "./flowStatus.ts";
import type { WorkflowEdge, WorkflowNode } from "./workflowGraph.ts";

type NodeData = { node: WorkflowNode; selected: boolean; state?: NodeState };
type FlowNode = Node<NodeData>;

const KIND_TEXT: Record<WorkflowNode["kind"], string> = {
  agent: "Agent step",
  gates: "Gates",
  group: "Parallel",
  member: "Parallel member",
  split: "Split",
  subtasks: "Sub-tasks",
  integration: "Integration",
};

const STATUS_TEXT: Record<NodeStatus, string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  skipped: "Not run",
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
    <span className={`workflow-status ${state.status}`}>
      <Icon size={12} className={state.status === "running" ? "spin" : undefined} aria-hidden />
      {STATUS_TEXT[state.status]}
      {state.turns > 1 ? ` · ${state.turns} turns` : ""}
      {state.costUsd > 0 ? ` · $${state.costUsd.toFixed(3)}` : ""}
    </span>
  );
}

const StepView = memo(function StepView({ data }: NodeProps<FlowNode>) {
  const { node, selected, state } = data;
  return (
    <div
      className={`graph-node workflow-step ${node.kind}${selected ? " selected" : ""}${state ? ` status-${state.status}` : ""}`}
      title={`${KIND_TEXT[node.kind]}: ${node.label}${state ? ` (${STATUS_TEXT[state.status]})` : ""}`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle id="fix-in" type="target" position={Position.Left} isConnectable={false} />
      {state ? <StatusMark state={state} /> : <span className="workflow-step-kind">{KIND_TEXT[node.kind]}</span>}
      <strong className="truncate">{node.label}</strong>
      <span className="muted truncate">{node.detail}</span>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
      <Handle id="fix-out" type="source" position={Position.Left} isConnectable={false} />
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

const NODE_TYPES = { step: StepView, group: GroupView };

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
    if (structure) void flow.current?.fitView({ padding: 0.2, maxZoom: 1, duration: 200 });
  }, [structure]);

  const flowNodes = useMemo<FlowNode[]>(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: n.kind === "group" ? "group" : "step",
        position: { x: n.x, y: n.y },
        width: n.width,
        height: n.height,
        data: { node: n, selected: n.id === selected, ...(states?.[n.id] ? { state: states[n.id] } : {}) },
        ...(n.kind === "group" ? { zIndex: -1 } : {}),
      })),
    [nodes, selected, states],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) =>
        e.kind === "fix"
          ? {
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: "fix-out",
              targetHandle: "fix-in",
              type: "smoothstep",
              label: fixes && fixes[e.id] !== undefined ? `fix round ${fixes[e.id]} of ${e.maxRounds ?? "?"}` : e.label,
              className: `graph-edge fix${fixes?.[e.id] ? " used" : ""}`,
              markerEnd: { type: MarkerType.ArrowClosed },
            }
          : {
              id: e.id,
              source: e.source,
              target: e.target,
              type: "smoothstep",
              className: "graph-edge",
              markerEnd: { type: MarkerType.ArrowClosed },
            },
      ),
    [edges, fixes],
  );

  return (
    <div className="session-graph workflow-canvas">
      <ReactFlow<FlowNode>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={NODE_TYPES}
        onInit={(instance) => {
          flow.current = instance;
        }}
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!nodes.length && <p className="graph-empty muted">Nothing to draw: the YAML isn't a workflow yet.</p>}
    </div>
  );
}
