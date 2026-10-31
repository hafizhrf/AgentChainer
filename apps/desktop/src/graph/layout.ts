import dagre from "@dagrejs/dagre";
import type { AgentGraph, GraphNode } from "./agentGraph.ts";

/** Node boxes in px; the custom nodes are drawn to these sizes so edges meet them. */
export const NODE_SIZE: Record<GraphNode["kind"], { width: number; height: number }> = {
  main: { width: 200, height: 52 },
  agent: { width: 240, height: 76 },
  tool: { width: 200, height: 40 },
};

export type Position = { x: number; y: number };

/** Top-down positions (top-left corners) for every node, from dagre (MIT, design §17). */
export function layoutGraph(graph: AgentGraph): Map<string, Position> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 24, ranksep: 56, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { ...NODE_SIZE[n.kind] });
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const out = new Map<string, Position>();
  for (const n of graph.nodes) {
    const p = g.node(n.id);
    const { width, height } = NODE_SIZE[n.kind];
    // dagre gives centres; React Flow places nodes by their top-left corner.
    out.set(n.id, { x: p.x - width / 2, y: p.y - height / 2 });
  }
  return out;
}
