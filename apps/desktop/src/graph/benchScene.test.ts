import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentGraph, MAX_NODES } from "./agentGraph.ts";
import { benchItems, frameStats } from "./benchScene.ts";
import { layoutGraph } from "./layout.ts";

describe("the M4-E2 bench scene", () => {
  it("has exactly as many graph nodes as the graph shows before folding, all laid out", () => {
    const g = agentGraph(benchItems(), { running: false });
    assert.equal(g.nodes.length, MAX_NODES);
    assert.equal(g.nodes.filter((n) => n.kind === "agent").length, 99);
    assert.equal(layoutGraph(g).size, MAX_NODES);
  });

  it("reads frame times from animation frame timestamps", () => {
    // 60 Hz with one dropped frame.
    const times = [0, 16.7, 33.4, 50.1, 83.5, 100.2];
    const s = frameStats(times);
    assert.deepEqual([s.frames, s.p50Ms, s.maxMs, s.slowPct], [5, 16.7, 33.4, 20]);
  });
});
