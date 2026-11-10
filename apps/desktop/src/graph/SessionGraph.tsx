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
import { t } from "../i18n/index.ts";
import { modelName } from "../modelName.ts";
import { type Item, toolSummary } from "../transcript.ts";
import { agentGraph, type GraphNode, MAIN_ID, moveFocus, structureKey } from "./agentGraph.ts";
import { DotGrid } from "./DotGrid.tsx";
import { layoutGraph, nodeSize } from "./layout.ts";
import { StatusIcon, statusLabel } from "./StatusIcon.tsx";
import { useNow } from "./useNow.ts";

type NodeData = {
  node: GraphNode;
  focused: boolean;
  selected: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  onSelect: (agentId: string) => void;
  /** The session's model, which a subagent runs unless its messages say otherwise (UX-18). */
  mainModel: string | undefined;
  cwd: string;
};
export type FlowNode = Node<NodeData>;

/**
 * The live agent graph of a session (M4-02): the main agent, its subagents under their parents, and each agent's tool
 * calls as one card (UX-18). The layout (dagre) is recomputed only when the structure changes; status updates patch
 * node data. Click a subagent, or move with the arrow keys and press Enter, to open its drawer; Esc closes it.
 */
export default function SessionGraph({
  items,
  running,
  waiting,
  selected,
  onSelect,
  onFlow,
  model,
  cwd = "",
}: {
  items: Item[];
  running: boolean;
  /** Tool call ids waiting for an approval. */
  waiting: ReadonlySet<string>;
  selected: string | null;
  onSelect: (agentId: string | null) => void;
  /** The React Flow instance once it's ready: the M4-E2 bench drives the viewport through it. */
  onFlow?: (flow: ReactFlowInstance<FlowNode>) => void;
  /** The session's model, as the CLI reports it (UX-18). */
  model?: string | undefined;
  /** The workspace, so a tool row shows paths relative to it. */
  cwd?: string;
}) {
  // Every 2 s, so a tool call that turns long shows its agent's card (design §4).
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
      ...nodeSize(n),
      data: {
        node: n,
        focused: focused === n.id,
        selected: selected === n.id,
        expanded: expanded.has(n.kind === "tools" ? n.parent : n.id),
        onToggle: toggle,
        onSelect,
        mainModel: model,
        cwd,
      },
    }));
  }, [graph, positions, focused, selected, expanded, onSelect, model, cwd]);

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
      const n = graph.nodes.find((x) => x.id === focused);
      if (n?.kind === "agent") onSelect(focused);
      else if (n?.kind === "tools")
        setExpanded((prev) => {
          const next = new Set(prev);
          if (!next.delete(n.parent)) next.add(n.parent);
          return next;
        });
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
      aria-label={t("graph.sessionGraph.label")}
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
      {!hasAgents && <p className="graph-empty muted">{t("graph.sessionGraph.empty")}</p>}
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

/** Opens or closes an agent's tools card: "12 tools" / "Fold tools". */
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
      {expanded ? t("graph.sessionGraph.foldTools") : t("graph.sessionGraph.tools", { count })}
    </button>
  );
}

/** The model an agent runs, as a chip (UX-18). */
function ModelChip({ model, inherited }: { model: string | undefined; inherited?: boolean }) {
  const name = modelName(model);
  if (!name) return null;
  return (
    <span
      className={`graph-model${inherited ? " inherited" : ""}`}
      title={
        inherited
          ? t("graph.sessionGraph.modelInherited", { model: name })
          : t("graph.sessionGraph.model", { model: name })
      }
    >
      {name}
    </span>
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
        <strong>{t("graph.sessionGraph.mainAgent")}</strong>
        <ModelChip model={data.mainModel} />
        {n.running && <Loader2 size={13} className="spin" aria-label={statusLabel("running")} />}
      </div>
      <FoldButton id={n.id} count={n.tools} expanded={data.expanded} onToggle={data.onToggle} />
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
    live && a.lastTool ? t("graph.sessionGraph.using", { tool: a.lastTool }) : null,
    a.tokens !== undefined ? t("graph.sessionGraph.tokens", { n: (a.tokens / 1000).toFixed(1) }) : null,
  ].filter(Boolean);
  return (
    <div className={cls("agent", data, n.waiting && live ? "waiting" : a.status)} title={a.description}>
      <Handles />
      <div className="graph-node-title">
        <Bot size={14} aria-hidden />
        <strong>{a.description}</strong>
        <StatusIcon status={a.status} />
      </div>
      <div className="graph-node-meta">
        <ModelChip model={a.model ?? data.mainModel} inherited={!a.model} />
        <span className="graph-node-meta-text">
          {n.waiting && live ? t("graph.sessionGraph.waiting") : meta.join(" · ")}
        </span>
      </div>
      <div className="graph-node-meta">
        <FoldButton id={n.id} count={n.tools} expanded={data.expanded} onToggle={data.onToggle} />
        {n.foldedAgents > 0 && <span>{t("graph.sessionGraph.moreAgents", { count: n.foldedAgents })}</span>}
      </div>
    </div>
  );
});

/** An agent's tool calls as one card (UX-18): counts by tool when closed; the latest calls, one a row, when open. */
const ToolsNodeView = memo(function ToolsNodeView({ data }: NodeProps<FlowNode>) {
  const n = data.node;
  if (n.kind !== "tools") return null;
  const total = n.counts.reduce((sum, c) => sum + c.n, 0);
  const status = n.waiting ? "waiting" : n.errors ? "error" : n.running ? "running" : "done";
  return (
    <div className={cls("tools", data, status)}>
      <Handles />
      <button
        type="button"
        className="graph-node-title graph-tools-head nodrag"
        aria-expanded={n.open}
        onClick={(e) => {
          e.stopPropagation();
          data.onToggle(n.parent);
        }}
      >
        <Wrench size={13} aria-hidden />
        <span>{t("graph.sessionGraph.toolCalls", { count: total })}</span>
        {n.waiting > 0 && <span className="graph-chip waiting">{t("graph.sessionGraph.approval")}</span>}
        {n.errors > 0 && (
          <span className="graph-chip error">{t("graph.sessionGraph.failed", { count: n.errors })}</span>
        )}
        {n.running > 0 && <Loader2 size={12} className="spin" aria-label={statusLabel("running")} />}
      </button>
      {n.open ? (
        <ul className="graph-tool-rows">
          {n.rows.map((tool) => (
            <li key={tool.id} className={`graph-tool-row ${tool.status}`} title={toolSummary(tool.input, data.cwd)}>
              <span className="graph-tool-name">{tool.name}</span>
              <span className="graph-tool-target">{toolSummary(tool.input, data.cwd)}</span>
              <span className="graph-tool-status">
                <StatusIcon status={tool.status} />
              </span>
            </li>
          ))}
          {n.more > 0 && (
            <li className="graph-tool-row more">
              {n.parent === MAIN_ID ? (
                <span>{t("graph.sessionGraph.moreTools", { count: n.more })}</span>
              ) : (
                <button
                  type="button"
                  className="link nodrag"
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onSelect(n.parent);
                  }}
                >
                  {t("graph.sessionGraph.moreTools", { count: n.more })}
                </button>
              )}
            </li>
          )}
        </ul>
      ) : (
        <div className="graph-tool-counts">{n.counts.map((c) => `${c.name} ×${c.n}`).join(" · ")}</div>
      )}
    </div>
  );
});

const NODE_TYPES = { main: MainNodeView, agent: AgentNodeView, tools: ToolsNodeView };
