import { EDIT_TOOLS } from "../files.ts";
import type { AgentChild, AgentItem, Item, ToolItem } from "../transcript.ts";

/**
 * The session graph's model (M4-02, docs/design/observability.md §4), derived from the transcript's agent tree: the main
 * agent as the root, one node per subagent under its parent, and only the key tool calls. Pure, so it's tested without
 * a WebView; the layout and React Flow come after.
 */

/** A tool call running at least this long gets a node of its own (design §17). */
export const LONG_TOOL_MS = 10_000;
/** Above this many nodes, finished subtrees fold into their root (design §17). */
export const MAX_NODES = 200;

export const MAIN_ID = "main";

export type MainNode = { kind: "main"; id: typeof MAIN_ID; running: boolean; foldedTools: number };
/** `foldedTools` are this agent's tool calls without a node; `foldedAgents` its subagents folded to keep under the cap. */
export type AgentNode = {
  kind: "agent";
  id: string;
  parent: string;
  agent: AgentItem;
  foldedTools: number;
  foldedAgents: number;
  /** One of its tool calls waits for an approval. */
  waiting: boolean;
};
export type ToolNode = { kind: "tool"; id: string; parent: string; tool: ToolItem; waiting: boolean };
export type GraphNode = MainNode | AgentNode | ToolNode;
/** A spawn, or a key tool call, from `source` to `target`. `done` once the target has ended. */
export type GraphEdge = { id: string; source: string; target: string; done: boolean };
export type AgentGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type GraphOptions = {
  /** The session has a turn running. */
  running: boolean;
  /** Epoch ms, to tell long-running calls; omitted for history. */
  now?: number;
  /** Tool call ids waiting for an approval. */
  waiting?: ReadonlySet<string>;
  /** Agent ids (or `main`) whose every tool call is shown. */
  expanded?: ReadonlySet<string>;
};

/** A tool call worth a node: an edit, a failure, a wait for approval, or a long call. */
export function isKeyTool(tool: ToolItem, o: GraphOptions): boolean {
  if (EDIT_TOOLS.has(tool.name) || tool.status === "error" || o.waiting?.has(tool.id)) return true;
  if (tool.durationMs !== undefined) return tool.durationMs >= LONG_TOOL_MS;
  return tool.status === "running" && tool.startedAt !== undefined && o.now !== undefined
    ? o.now - tool.startedAt >= LONG_TOOL_MS
    : false;
}

export function agentGraph(items: readonly Item[], o: GraphOptions): AgentGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  /** Adds the tools and subagents of `parent`; returns how many tool calls were folded. */
  const addChildren = (parent: string, children: readonly (Item | AgentChild)[]): number => {
    let folded = 0;
    for (const c of children) {
      if (c.kind === "agent") {
        addAgent(parent, c);
      } else if (c.kind === "tool") {
        if (o.expanded?.has(parent) || isKeyTool(c, o)) {
          nodes.push({ kind: "tool", id: c.id, parent, tool: c, waiting: o.waiting?.has(c.id) ?? false });
          edges.push({ id: `${parent}->${c.id}`, source: parent, target: c.id, done: c.status !== "running" });
        } else {
          folded++;
        }
      }
    }
    return folded;
  };

  const addAgent = (parent: string, agent: AgentItem) => {
    const node: AgentNode = {
      kind: "agent",
      id: agent.id,
      parent,
      agent,
      foldedTools: 0,
      foldedAgents: 0,
      waiting: agent.children.some((c) => c.kind === "tool" && (o.waiting?.has(c.id) ?? false)),
    };
    nodes.push(node);
    edges.push({ id: `${parent}->${agent.id}`, source: parent, target: agent.id, done: !isLive(agent) });
    node.foldedTools = addChildren(agent.id, agent.children);
  };

  const main: MainNode = { kind: "main", id: MAIN_ID, running: o.running, foldedTools: 0 };
  nodes.push(main);
  main.foldedTools = addChildren(MAIN_ID, items);
  return nodes.length > MAX_NODES ? fold({ nodes, edges }) : { nodes, edges };
}

const isLive = (a: AgentItem) => a.status === "running" || a.status === "paused";

/**
 * Keeps a big graph under `MAX_NODES`: first the tool nodes of finished agents go, then finished subtrees fold into
 * their root, outermost first, until it fits. Live work always stays visible.
 */
function fold(graph: AgentGraph): AgentGraph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const removed = new Set<string>();
  const count = () => graph.nodes.length - removed.size;

  for (const n of graph.nodes) {
    if (count() <= MAX_NODES) break;
    const parent = n.kind === "tool" ? byId.get(n.parent) : undefined;
    if (n.kind === "tool" && parent?.kind === "agent" && !isLive(parent.agent)) {
      removed.add(n.id);
      parent.foldedTools++;
    }
  }

  const children = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (n.kind === "main") continue;
    children.set(n.parent, [...(children.get(n.parent) ?? []), n]);
  }
  const descendants = (id: string): GraphNode[] =>
    (children.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id)]).filter((c) => !removed.has(c.id));

  for (const n of graph.nodes) {
    if (count() <= MAX_NODES) break;
    if (n.kind !== "agent" || removed.has(n.id) || isLive(n.agent)) continue;
    const below = descendants(n.id);
    if (below.some((d) => d.kind === "agent" && isLive(d.agent))) continue;
    for (const d of below) {
      removed.add(d.id);
      if (d.kind === "agent") n.foldedAgents++;
      else n.foldedTools++;
    }
  }

  return {
    nodes: graph.nodes.filter((n) => !removed.has(n.id)),
    edges: graph.edges.filter((e) => !removed.has(e.target)),
  };
}

/** The structure only: ids and parents. The layout is recomputed when this changes, not on every status update. */
export function structureKey(graph: AgentGraph): string {
  return graph.nodes.map((n) => (n.kind === "main" ? n.id : `${n.parent}>${n.id}`)).join("|");
}

/** Arrow keys over the tree: up to the parent, down to the first child, left and right among siblings. */
export function moveFocus(graph: AgentGraph, from: string | null, key: string): string | undefined {
  const nodes = graph.nodes;
  if (!key.startsWith("Arrow")) return undefined;
  const current = nodes.find((n) => n.id === from);
  if (!current) return nodes.find((n) => n.kind === "agent")?.id ?? MAIN_ID;
  const parentOf = (n: GraphNode) => (n.kind === "main" ? null : n.parent);
  const siblings = nodes.filter((n) => parentOf(n) === parentOf(current));
  const i = siblings.indexOf(current);
  switch (key) {
    case "ArrowUp":
      return parentOf(current) ?? current.id;
    case "ArrowDown":
      return nodes.find((n) => parentOf(n) === current.id)?.id ?? current.id;
    case "ArrowLeft":
      return siblings[Math.max(0, i - 1)]?.id ?? current.id;
    case "ArrowRight":
      return siblings[Math.min(siblings.length - 1, i + 1)]?.id ?? current.id;
    default:
      return undefined;
  }
}
