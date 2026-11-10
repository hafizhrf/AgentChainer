import dagre from "@dagrejs/dagre";
import type { AgentGraph, GraphNode } from "./agentGraph.ts";

/** Node boxes in px; the custom nodes are drawn to these sizes so edges meet them. */
export const NODE_SIZE: Record<"main" | "agent", { width: number; height: number }> = {
  main: { width: 220, height: 56 },
  agent: { width: 240, height: 80 },
};

/** A tools card (UX-18): a header and its counts when closed; a header, a row per call and "+N more" when open. */
export const TOOLS_WIDTH = 240;
const TOOLS_HEAD = 30;
const TOOLS_COUNTS = 26;
export const TOOL_ROW = 22;

/** The box a node is drawn in. */
export function nodeSize(n: GraphNode): { width: number; height: number } {
  if (n.kind !== "tools") return NODE_SIZE[n.kind];
  const body = n.open ? (n.rows.length + (n.more > 0 ? 1 : 0)) * TOOL_ROW + 8 : TOOLS_COUNTS;
  return { width: TOOLS_WIDTH, height: TOOLS_HEAD + body };
}

export type Position = { x: number; y: number };

/** Top-down positions (top-left corners) for every node, from dagre (MIT, design §17). */
export function layoutGraph(graph: AgentGraph): Map<string, Position> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 56, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { ...nodeSize(n) });
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const out = new Map<string, Position>();
  for (const n of graph.nodes) {
    const p = g.node(n.id);
    const { width, height } = nodeSize(n);
    // dagre gives centres; React Flow places nodes by their top-left corner.
    out.set(n.id, { x: p.x - width / 2, y: p.y - height / 2 });
  }
  return out;
}
