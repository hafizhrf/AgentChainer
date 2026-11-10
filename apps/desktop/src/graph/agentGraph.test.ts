import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import { type AgentItem, applyEvent, type Item, type ToolItem } from "../transcript.ts";
import {
  agentGraph,
  isKeyTool,
  LONG_TOOL_MS,
  MAIN_ID,
  MAX_NODES,
  moveFocus,
  structureKey,
  TOOL_ROWS,
  toolsId,
} from "./agentGraph.ts";
import { layoutGraph, NODE_SIZE, nodeSize } from "./layout.ts";

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
    assert.equal(inner?.kind === "agent" && inner.tools, 1);
    // Each subagent knows the model its messages came from (UX-18).
    assert.equal(outer?.kind === "agent" && outer.agent.model, "claude-haiku-5-5");
    assert.ok(!g.nodes.some((n) => n.kind === "tools"), "a quick Bash call alone shows no card");
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

  it("tells the calls that matter: edits, failures, waits and long calls", () => {
    const o = { running: true, now: 50_000, waiting: new Set(["w"]) };
    assert.equal(isKeyTool(tool("e", "Edit"), o), true);
    assert.equal(isKeyTool(tool("f", "Bash", { status: "error" }), o), true);
    assert.equal(isKeyTool(tool("w", "Bash", { status: "running" }), o), true);
    assert.equal(isKeyTool(tool("l", "Bash", { status: "running", startedAt: 50_000 - LONG_TOOL_MS }), o), true);
    assert.equal(isKeyTool(tool("d", "Grep", { durationMs: LONG_TOOL_MS + 1 }), o), true);
    assert.equal(isKeyTool(tool("q", "Read", { durationMs: 20 }), o), false);
  });

  it("puts an agent's tool calls on one card, shown when one matters or when opened (UX-18)", () => {
    const o = { running: true, waiting: new Set(["w"]) };
    const items: Item[] = [
      tool("r1", "Read"),
      tool("r2", "Read"),
      agent(
        "A",
        [tool("a1", "Read"), tool("a2", "Edit"), tool("a3", "Read"), tool("w", "Bash", { status: "running" })],
        "running",
      ),
    ];
    const g = agentGraph(items, o);
    const main = g.nodes.find((n) => n.kind === "main");
    assert.equal(main?.kind === "main" && main.tools, 2);
    assert.ok(!g.nodes.some((n) => n.id === toolsId(MAIN_ID)), "two reads: no card until it's opened");
    const card = g.nodes.find((n) => n.id === toolsId("A"));
    assert.ok(card?.kind === "tools");
    assert.deepEqual(card.counts, [
      { name: "Read", n: 2 },
      { name: "Edit", n: 1 },
      { name: "Bash", n: 1 },
    ]);
    assert.deepEqual([card.open, card.waiting, card.running, card.rows.length], [false, 1, 1, 0]);
    const a = g.nodes.find((n) => n.id === "A");
    assert.equal(a?.kind === "agent" && a.waiting, true);
    assert.ok(g.edges.some((e) => e.source === "A" && e.target === toolsId("A") && !e.done));

    const opened = agentGraph(items, { ...o, expanded: new Set([MAIN_ID]) });
    const mainCard = opened.nodes.find((n) => n.id === toolsId(MAIN_ID));
    assert.deepEqual(mainCard?.kind === "tools" && mainCard.rows.map((r) => r.id), ["r1", "r2"]);
    assert.ok(nodeSize(mainCard ?? card).height > nodeSize(card).height - 1);
  });

  it("lists the latest calls of an open card, then +N more, and keeps its width (UX-18)", () => {
    const many = Array.from({ length: 30 }, (_, i) => tool(`t${i}`, i % 2 ? "Read" : "Grep"));
    const g = agentGraph([agent("A", many)], { running: false, expanded: new Set(["A"]) });
    const card = g.nodes.find((n) => n.id === toolsId("A"));
    assert.ok(card?.kind === "tools");
    assert.equal(card.rows.length, TOOL_ROWS);
    assert.equal(card.rows.at(-1)?.id, "t29", "the latest last");
    assert.equal(card.more, 30 - TOOL_ROWS);
    assert.equal(g.nodes.length, 3, "main, the agent and one card, not 30 nodes");
    const pos = layoutGraph(g);
    assert.equal(pos.get("A")?.y !== undefined, true);
    assert.equal(nodeSize(card).width, NODE_SIZE.agent.width);
  });

  it("shows the main agent's calls of the turn at hand only (UX-18)", () => {
    const items: Item[] = [
      { kind: "user", id: 1, text: "first" },
      tool("old", "Edit"),
      { kind: "user", id: 2, text: "second" },
      tool("new", "Read"),
    ];
    const g = agentGraph(items, { running: false });
    const main = g.nodes.find((n) => n.kind === "main");
    assert.equal(main?.kind === "main" && main.tools, 1);
    assert.ok(!g.nodes.some((n) => n.kind === "tools"), "the earlier turn's edit isn't on the card");
  });

  it("changes the structure key when a card opens, so the layout makes room", () => {
    const items: Item[] = [agent("A", [tool("e", "Edit"), tool("r", "Read")])];
    const closed = agentGraph(items, { running: false });
    const open = agentGraph(items, { running: false, expanded: new Set(["A"]) });
    assert.notEqual(structureKey(closed), structureKey(open));
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
