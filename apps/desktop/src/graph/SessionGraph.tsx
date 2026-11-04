import "@xyflow/react/dist/base.css";
import {
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  useStore,
} from "@xyflow/react";
import { Bot, Loader2, Sparkles, Wrench } from "lucide-react";
import { type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import type { Item } from "../transcript.ts";
import { agentGraph, type GraphNode, MAIN_ID, moveFocus, structureKey } from "./agentGraph.ts";
import { DotGrid } from "./DotGrid.tsx";
import { layoutGraph, NODE_SIZE } from "./layout.ts";
import { StatusIcon } from "./StatusIcon.tsx";
import { useNow } from "./useNow.ts";

type NodeData = {
  node: GraphNode;
  focused: boolean;
  selected: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
};
export type FlowNode = Node<NodeData>;

/**
 * The live agent graph of a session (M4-02): the main agent, its subagents under their parents, and the key tool
 * calls. The layout (dagre) is recomputed only when the structure changes; status updates patch node data. Click a
 * subagent, or move with the arrow keys and press Enter, to open its drawer; Esc closes it.
 */
export default function SessionGraph({
  items,
  running,
  waiting,
  selected,
  onSelect,
  onFlow,
}: {
  items: Item[];
  running: boolean;
  /** Tool call ids waiting for an approval. */
  waiting: ReadonlySet<string>;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
  /** The React Flow instance once it's ready: the M4-E2 bench drives the viewport through it. */
  onFlow?: (flow: ReactFlowInstance<FlowNode>) => void;
}) {
  // Every 2 s, so a tool call that turns long gets its node (design §4).
  const now = useNow(running, 2000);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [far, setFar] = useState(false);
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null);

  const graph = useMemo(
    () => agentGraph(items, { running, now, waiting, expanded }),
    [items, running, now, waiting, expanded],
  );
  const key = structureKey(graph);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout follows the structure only (`key`).
  const positions = useMemo(() => layoutGraph(graph), [key]);

  // A new node may land off screen: fit the view again when the structure changes.
  useEffect(() => {
    if (key) void flow.current?.fitView({ padding: 0.15, maxZoom: 1, duration: 200 });
  }, [key]);

  const nodes = useMemo<FlowNode[]>(() => {
    const toggle = (id: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      });
    return graph.nodes.map((n) => ({
      id: n.id,
      type: n.kind,
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      ...NODE_SIZE[n.kind],
      data: {
        node: n,
        focused: focused === n.id,
        selected: selected === n.id,
        expanded: expanded.has(n.id),
        onToggle: toggle,
      },
    }));
  }, [graph, positions, focused, selected, expanded]);

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        animated: !e.done,
        className: e.done ? "graph-edge" : "graph-edge live",
      })),
    [graph.edges],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = moveFocus(graph, focused ?? selected, e.key);
    if (next !== undefined) {
      e.preventDefault();
      setFocused(next);
    } else if (e.key === "Enter" && focused && focused !== MAIN_ID) {
      onSelect(focused);
    } else if (e.key === "Escape" && selected) {
      e.preventDefault();
      onSelect(null);
    }
  };

  const hasAgents = graph.nodes.some((n) => n.kind === "agent");
  return (
    <div
      className="session-graph"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the graph is navigable with the arrow keys (X-12).
      tabIndex={0}
      role="application"
      aria-label="Agent graph. Arrow keys move between agents, Enter opens one, Esc closes it."
      onKeyDown={onKeyDown}
    >
      <ReactFlow<FlowNode>
        className={far ? "far" : undefined}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onInit={(instance) => {
          flow.current = instance;
          onFlow?.(instance);
        }}
        onNodeClick={(_, n) => {
          setFocused(n.id);
          if (n.data.node.kind === "agent") onSelect(n.id);
        }}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <DotGrid />
        <ZoomedOut below={FAR_ZOOM} onChange={setFar} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!hasAgents && <p className="graph-empty muted">No subagents in this session yet.</p>}
    </div>
  );
}

/** Below this zoom a node's text is too small to read, so nodes are drawn as plain boxes (M4-E2). */
const FAR_ZOOM = 0.4;

/** Tells whether the graph is zoomed out below `below`; it has to sit inside React Flow to read the zoom. */
function ZoomedOut({ below, onChange }: { below: number; onChange: (far: boolean) => void }) {
  const far = useStore((s) => s.transform[2] < below);
  useEffect(() => onChange(far), [far, onChange]);
  return null;
}

const Handles = () => (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} />
    <Handle type="source" position={Position.Bottom} isConnectable={false} />
  </>
);

function FoldButton({
  id,
  count,
  expanded,
  onToggle,
}: {
  id: string;
  count: number;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  if (count === 0 && !expanded) return null;
  return (
    <button
      type="button"
      className="link graph-fold nodrag"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(id);
      }}
    >
      {expanded ? "Fold tools" : `${count} tool${count === 1 ? "" : "s"}`}
    </button>
  );
}

const cls = (base: string, d: NodeData, status: string) =>
  `graph-node ${base} ${status}${d.selected ? " selected" : ""}${d.focused ? " focused" : ""}`;

const MainNodeView = memo(function MainNodeView({ data }: NodeProps<FlowNode>) {
  const n = data.node;
  if (n.kind !== "main") return null;
  return (
    <div className={cls("main", data, n.running ? "running" : "done")}>
      <Handles />
      <div className="graph-node-title">
        <Sparkles size={14} aria-hidden />
        <strong>Main agent</strong>
        {n.running && <Loader2 size={13} className="spin" aria-label="Running" />}
      </div>
      <FoldButton id={n.id} count={n.foldedTools} expanded={data.expanded} onToggle={data.onToggle} />
    </div>
  );
});

const AgentNodeView = memo(function AgentNodeView({ data }: NodeProps<FlowNode>) {
  const n = data.node;
  if (n.kind !== "agent") return null;
  const a = n.agent;
  const live = a.status === "running" || a.status === "paused";
  const meta = [
    a.agentType,
    live && a.lastTool ? `using ${a.lastTool}` : null,
    a.tokens !== undefined ? `${(a.tokens / 1000).toFixed(1)}k tokens` : null,
  ].filter(Boolean);
  return (
    <div className={cls("agent", data, n.waiting && live ? "waiting" : a.status)} title={a.description}>
      <Handles />
      <div className="graph-node-title">
        <Bot size={14} aria-hidden />
        <strong>{a.description}</strong>
        <StatusIcon status={a.status} />
      </div>
      <div className="graph-node-meta">{n.waiting && live ? "Waiting for approval" : meta.join(" · ")}</div>
      <div className="graph-node-meta">
        <FoldButton id={n.id} count={n.foldedTools} expanded={data.expanded} onToggle={data.onToggle} />
        {n.foldedAgents > 0 && <span>+{n.foldedAgents} agents</span>}
      </div>
    </div>
  );
});

const ToolNodeView = memo(function ToolNodeView({ data }: NodeProps<FlowNode>) {
  const n = data.node;
  if (n.kind !== "tool") return null;
  const t = n.tool;
  return (
    <div className={cls("tool", data, n.waiting ? "waiting" : t.status)}>
      <Handles />
      <div className="graph-node-title">
        <Wrench size={13} aria-hidden />
        <span>{t.name}</span>
        {n.waiting ? <span className="graph-node-meta">approval</span> : <StatusIcon status={t.status} />}
      </div>
    </div>
  );
});

const NODE_TYPES = { main: MainNodeView, agent: AgentNodeView, tool: ToolNodeView };
