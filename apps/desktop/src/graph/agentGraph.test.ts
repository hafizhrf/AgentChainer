import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import { type AgentItem, applyEvent, type Item, type ToolItem } from "../transcript.ts";
import { agentGraph, isKeyTool, LONG_TOOL_MS, MAIN_ID, MAX_NODES, moveFocus, structureKey } from "./agentGraph.ts";
import { layoutGraph, NODE_SIZE } from "./layout.ts";

const fixture = (name: string): Item[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../../../packages/sidecar/test/fixtures/${name}.events.json`, import.meta.url), "utf8"),
    ) as AgentEvent[]
  ).reduce<Item[]>((items, e) => applyEvent(items, e), []);

const tool = (id: string, name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id,
  name,
  input: {},
  status: "done",
  ...extra,
});

const agent = (id: string, children: AgentItem["children"], status: AgentItem["status"] = "done"): AgentItem => ({
  kind: "agent",
  id,
  description: id,
  status,
  children,
});

describe("agentGraph (M4-02)", () => {
  it("builds main → outer → inner from the nested fixture, folding the inner agent's Bash call", () => {
    const g = agentGraph(fixture("subagents-nested"), { running: false });
    const agents = g.nodes.filter((n) => n.kind === "agent");
    assert.equal(agents.length, 2);
    const [outer, inner] = agents;
    assert.equal(outer?.parent, MAIN_ID);
    assert.equal(inner?.parent, outer?.id);
    assert.equal(inner?.kind === "agent" && inner.foldedTools, 1, "the quick Bash call is a count, not a node");
    assert.deepEqual(
      g.edges.map((e) => [e.source, e.target, e.done]),
      [
        [MAIN_ID, outer?.id, true],
        [outer?.id, inner?.id, true],
      ],
    );
  });

  it("puts parallel subagents side by side under the main agent", () => {
    const g = agentGraph(fixture("subagents-parallel"), { running: false });
    const agents = g.nodes.filter((n) => n.kind === "agent");
    assert.equal(agents.length, 2);
    const pos = layoutGraph(g);
    const [a, b] = agents.map((n) => pos.get(n.id));
    assert.equal(a?.y, b?.y, "same rank");
    assert.ok(Math.abs((a?.x ?? 0) - (b?.x ?? 0)) >= NODE_SIZE.agent.width, "no overlap");
    assert.ok((pos.get(MAIN_ID)?.y ?? 0) < (a?.y ?? 0), "the main agent is above");
  });

  it("shows edits, failures, waits and long calls as nodes; the rest fold into a count", () => {
    const o = { running: true, now: 50_000, waiting: new Set(["w"]) };
    assert.equal(isKeyTool(tool("e", "Edit"), o), true);
    assert.equal(isKeyTool(tool("f", "Bash", { status: "error" }), o), true);
    assert.equal(isKeyTool(tool("w", "Bash", { status: "running" }), o), true);
    assert.equal(isKeyTool(tool("l", "Bash", { status: "running", startedAt: 50_000 - LONG_TOOL_MS }), o), true);
    assert.equal(isKeyTool(tool("d", "Grep", { durationMs: LONG_TOOL_MS + 1 }), o), true);
    assert.equal(isKeyTool(tool("q", "Read", { durationMs: 20 }), o), false);

    const items: Item[] = [
      tool("r1", "Read"),
      tool("r2", "Read"),
      agent("A", [tool("w", "Bash", { status: "running" })], "running"),
    ];
    const g = agentGraph(items, o);
    const main = g.nodes.find((n) => n.kind === "main");
    assert.equal(main?.kind === "main" && main.foldedTools, 2);
    const a = g.nodes.find((n) => n.id === "A");
    assert.equal(a?.kind === "agent" && a.waiting, true);
    assert.ok(g.nodes.some((n) => n.id === "w"));

    const expanded = agentGraph(items, { ...o, expanded: new Set([MAIN_ID]) });
    assert.deepEqual(
      expanded.nodes.filter((n) => n.kind === "tool").map((n) => n.id),
      ["r1", "r2", "w"],
    );
  });

  it("folds finished subtrees above the cap but keeps live work", () => {
    // 60 finished agents with 3 subagents each (240 agents), and one live agent.
    const items: Item[] = [];
    for (let i = 0; i < 60; i++)
      items.push(
        agent(
          `A${i}`,
          [0, 1, 2].map((j) => agent(`A${i}.${j}`, [])),
        ),
      );
    items.push(agent("live", [agent("live.child", [], "running")], "running"));
    const g = agentGraph(items, { running: true });
    assert.ok(g.nodes.length <= MAX_NODES, `${g.nodes.length} nodes`);
    assert.ok(g.nodes.some((n) => n.id === "live.child"));
    const folded = g.nodes.filter((n) => n.kind === "agent" && n.foldedAgents > 0);
    assert.ok(folded.length > 0);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) assert.ok(ids.has(e.source) && ids.has(e.target), "no dangling edges");
  });

  it("keeps the structure key when only a status changes", () => {
    const running = agentGraph([agent("A", [], "running")], { running: true });
    const done = agentGraph([agent("A", [])], { running: false });
    assert.equal(structureKey(running), structureKey(done));
    assert.notEqual(
      structureKey(running),
      structureKey(agentGraph([agent("A", [agent("B", [])])], { running: false })),
    );
  });

  it("moves the keyboard focus along the tree", () => {
    const g = agentGraph([agent("A", [agent("A1", [])]), agent("B", [])], { running: false });
    assert.equal(moveFocus(g, null, "ArrowDown"), "A", "starts at the first agent");
    assert.equal(moveFocus(g, "A", "ArrowRight"), "B");
    assert.equal(moveFocus(g, "B", "ArrowLeft"), "A");
    assert.equal(moveFocus(g, "A", "ArrowDown"), "A1");
    assert.equal(moveFocus(g, "A1", "ArrowUp"), "A");
    assert.equal(moveFocus(g, "A", "ArrowUp"), MAIN_ID);
    assert.equal(moveFocus(g, "A", "Enter"), undefined);
  });
});
