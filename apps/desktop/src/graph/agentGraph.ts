import { EDIT_TOOLS } from "../files.ts";
import type { AgentChild, AgentItem, Item, ToolItem } from "../transcript.ts";

/**
 * The session graph's model (M4-02, docs/design/observability.md §4), derived from the transcript's agent tree: the main
 * agent as the root, one node per subagent under its parent, and each agent's tool calls as one card (UX-18). Pure, so
 * it's tested without a WebView; the layout and React Flow come after.
 */

/** A tool call running at least this long counts as a key call (design §17). */
export const LONG_TOOL_MS = 10_000;
/** Above this many nodes, finished subtrees fold into their root (design §17). */
export const MAX_NODES = 200;
/** An open tools card lists at most this many calls, the latest; the rest are "+N more" (UX-18). */
export const TOOL_ROWS = 8;

export const MAIN_ID = "main";

/** `tools` counts the calls behind its card: for the main agent, the current turn's (UX-18). */
export type MainNode = { kind: "main"; id: typeof MAIN_ID; running: boolean; tools: number };
/** `tools` is how many tool calls it made; `foldedAgents` its subagents folded to keep under the cap. */
export type AgentNode = {
  kind: "agent";
  id: string;
  parent: string;
  agent: AgentItem;
  tools: number;
  foldedAgents: number;
  /** One of its tool calls waits for an approval. */
  waiting: boolean;
};
/**
 * An agent's tool calls as one card (UX-18), instead of a node each, so a busy agent doesn't spread the graph sideways.
 * Shown when one of them matters (an edit, a failure, a wait, a long call) or when the person opens the card. `rows`
 * are what an open card lists, the latest last; `counts` are by tool name, most used first.
 */
export type ToolsNode = {
  kind: "tools";
  id: string;
  parent: string;
  open: boolean;
  counts: { name: string; n: number }[];
  rows: ToolItem[];
  /** Calls an open card leaves out. */
  more: number;
  errors: number;
  waiting: number;
  running: number;
};
export type GraphNode = MainNode | AgentNode | ToolsNode;
/** A spawn, or an agent's tools card, from `source` to `target`. `done` once the target has ended. */
export type GraphEdge = { id: string; source: string; target: string; done: boolean };
export type AgentGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type GraphOptions = {
  /** The session has a turn running. */
  running: boolean;
  /** Epoch ms, to tell long-running calls; omitted for history. */
  now?: number;
  /** Tool call ids waiting for an approval. */
  waiting?: ReadonlySet<string>;
  /** Agent ids (or `main`) whose tools card is open. */
  expanded?: ReadonlySet<string>;
};

/** A tool call worth showing without being asked: an edit, a failure, a wait for approval, or a long call. */
export function isKeyTool(tool: ToolItem, o: GraphOptions): boolean {
  if (EDIT_TOOLS.has(tool.name) || tool.status === "error" || o.waiting?.has(tool.id)) return true;
  if (tool.durationMs !== undefined) return tool.durationMs >= LONG_TOOL_MS;
  return tool.status === "running" && tool.startedAt !== undefined && o.now !== undefined
    ? o.now - tool.startedAt >= LONG_TOOL_MS
    : false;
}

/** The id of `parent`'s tools card. */
export const toolsId = (parent: string) => `${parent}::tools`;

/** The main agent's calls since the last message the person sent: its card is about the turn at hand (UX-18). */
function currentTurn(items: readonly Item[]): ToolItem[] {
  let start = 0;
  items.forEach((item, i) => {
    if (item.kind === "user") start = i + 1;
  });
  return items.slice(start).filter((i): i is ToolItem => i.kind === "tool");
}

export function agentGraph(items: readonly Item[], o: GraphOptions): AgentGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  /** `parent`'s tools card, when it has one to show. */
  const addTools = (parent: string, tools: readonly ToolItem[]) => {
    const open = o.expanded?.has(parent) ?? false;
    if (!tools.length || (!open && !tools.some((tool) => isKeyTool(tool, o)))) return;
    const byName = new Map<string, number>();
    for (const tool of tools) byName.set(tool.name, (byName.get(tool.name) ?? 0) + 1);
    const rows = open ? tools.slice(-TOOL_ROWS) : [];
    const running = tools.filter((tool) => tool.status === "running").length;
    const id = toolsId(parent);
    nodes.push({
      kind: "tools",
      id,
      parent,
      open,
      counts: [...byName].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
      rows,
      more: open ? tools.length - rows.length : 0,
      errors: tools.filter((tool) => tool.status === "error").length,
      waiting: tools.filter((tool) => o.waiting?.has(tool.id)).length,
      running,
    });
    edges.push({ id: `${parent}->${id}`, source: parent, target: id, done: running === 0 });
  };

  const addAgent = (parent: string, agent: AgentItem) => {
    const tools = agent.children.filter((c): c is ToolItem => c.kind === "tool");
    nodes.push({
      kind: "agent",
      id: agent.id,
      parent,
      agent,
      tools: tools.length,
      foldedAgents: 0,
      waiting: tools.some((c) => o.waiting?.has(c.id) ?? false),
    });
    edges.push({ id: `${parent}->${agent.id}`, source: parent, target: agent.id, done: !isLive(agent) });
    addTools(agent.id, tools);
    addAgents(agent.id, agent.children);
  };

  const addAgents = (parent: string, children: readonly (Item | AgentChild)[]) => {
    for (const c of children) if (c.kind === "agent") addAgent(parent, c);
  };

  const turn = currentTurn(items);
  nodes.push({ kind: "main", id: MAIN_ID, running: o.running, tools: turn.length });
  addTools(MAIN_ID, turn);
  addAgents(MAIN_ID, items);
  return nodes.length > MAX_NODES ? fold({ nodes, edges }) : { nodes, edges };
}

const isLive = (a: AgentItem) => a.status === "running" || a.status === "paused";

/**
 * Keeps a big graph under `MAX_NODES`: first the tools cards of finished agents go, then finished subtrees fold into
 * their root, outermost first, until it fits. Live work always stays visible.
 */
function fold(graph: AgentGraph): AgentGraph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const removed = new Set<string>();
  const count = () => graph.nodes.length - removed.size;

  for (const n of graph.nodes) {
    if (count() <= MAX_NODES) break;
    const parent = n.kind === "tools" ? byId.get(n.parent) : undefined;
    if (n.kind === "tools" && parent?.kind === "agent" && !isLive(parent.agent)) removed.add(n.id);
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
    }
  }

  return {
    nodes: graph.nodes.filter((n) => !removed.has(n.id)),
    edges: graph.edges.filter((e) => !removed.has(e.target)),
  };
}

/**
 * The structure only: ids, parents and how big each tools card is. The layout is recomputed when this changes, not on
 * every status update.
 */
export function structureKey(graph: AgentGraph): string {
  return graph.nodes
    .map((n) =>
      n.kind === "main"
        ? n.id
        : n.kind === "tools"
          ? `${n.parent}>${n.id}#${n.open ? n.rows.length : "c"}`
          : `${n.parent}>${n.id}`,
    )
    .join("|");
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
