import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentEvent, PermissionRequest } from "@agentchainer/protocol";
import { closeWaits, newTab, permissionAnswered, permissionAsked, tabEvent } from "../tabs.ts";
import { applyEvent, type Item } from "../transcript.ts";
import { MAIN_ID } from "./agentGraph.ts";
import { clock, ticks, timeline, turns } from "./timeline.ts";

const events = (name: string): AgentEvent[] =>
  JSON.parse(
    readFileSync(new URL(`../../../../packages/sidecar/test/fixtures/${name}.events.json`, import.meta.url), "utf8"),
  ) as AgentEvent[];

/** Replays a fixture as if live, 100 ms per event, ending on the recording's own SDK end times. */
const live = (name: string): Item[] => {
  const list = events(name);
  const ends = list.flatMap((e) => (e.type === "agent.updated" && e.endTime !== undefined ? [e.endTime] : []));
  const t0 = Math.min(...ends) - list.length * 100;
  return list.reduce<Item[]>((items, e, i) => applyEvent(items, e, t0 + i * 100), []);
};

describe("timeline (M4-04)", () => {
  it("puts the parallel subagents on overlapping bars under the main agent", () => {
    const t = timeline(live("subagents-parallel"), [], {});
    assert.ok(t);
    const [main, a, b] = t.rows;
    assert.equal(main?.id, MAIN_ID);
    assert.equal(t.rows.length, 3);
    assert.deepEqual([a?.depth, b?.depth], [1, 1]);
    assert.ok(a && b && a.bar.start <= b.bar.start, "ordered by start");
    assert.ok(a && b && b.bar.start < a.bar.end, "the bars overlap: the agents ran in parallel");
    for (const r of t.rows) {
      assert.ok(r.bar.start >= t.start && r.bar.end <= t.end, `${r.label} fits the axis`);
    }
  });

  it("indents a nested subagent under its parent", () => {
    const t = timeline(live("subagents-nested"), [], {});
    assert.deepEqual(
      t?.rows.map((r) => r.depth),
      [0, 1, 2],
    );
    const [, outer, inner] = t?.rows ?? [];
    assert.ok(outer && inner && inner.bar.start >= outer.bar.start && inner.bar.end <= outer.bar.end);
  });

  it("has nothing to draw for a reopened session, whose messages carry no times", () => {
    const replayed = events("subagents-parallel").reduce<Item[]>((items, e) => applyEvent(items, e), []);
    assert.equal(timeline(replayed, [], {}), null);
  });

  it("follows the clock while an agent runs", () => {
    const items = live("subagents-parallel");
    const running = items.map((i) =>
      i.kind === "agent" ? { ...i, status: "running" as const, endedAt: undefined, durationMs: undefined } : i,
    );
    const now = 1_793_174_090_000;
    const t = timeline(running, [], { now });
    assert.equal(t?.end, now);
    assert.ok(t?.rows.every((r) => r.live && r.bar.end === now));
  });

  it("draws an approval wait on the row of the agent whose tool call asked", () => {
    const items = live("subagents-parallel");
    const agent = items.find((i) => i.kind === "agent");
    const tool = agent?.kind === "agent" ? agent.children.find((c) => c.kind === "tool") : undefined;
    assert.ok(agent && tool);
    const start = (agent.startedAt ?? 0) + 100;
    const t = timeline(items, [{ toolUseId: String(tool.id), requestId: "r1", start, end: start + 2500 }], {});
    const row = t?.rows.find((r) => r.id === agent.id);
    assert.deepEqual(row?.waits, [{ start, end: start + 2500 }]);
    assert.deepEqual(t?.rows[0]?.waits, [], "not on the main agent's row");
  });
});

describe("turns", () => {
  it("splits at each user message, so idle time between turns stays off the axis", () => {
    const items: Item[] = [
      { kind: "notice", id: 0, text: "Session started", at: 900 },
      { kind: "user", id: 1, text: "first", at: 1000 },
      { kind: "assistant", id: 2, text: "ok", open: false, at: 2000 },
      { kind: "user", id: 3, text: "second", at: 600_000 },
      { kind: "assistant", id: 4, text: "ok", open: false, at: 604_000 },
    ];
    const split = turns(items);
    assert.deepEqual(
      split.map((t) => t.map((i) => i.id)),
      [
        [0, 1, 2],
        [3, 4],
      ],
    );
    const t = timeline(split[1] ?? [], [], {});
    assert.deepEqual([t?.start, t?.end], [600_000, 604_000]);
  });
});

describe("approval waits (M4-04)", () => {
  const req = { sessionId: "s", requestId: "r1", toolName: "Bash", toolUseId: "tu1", input: {} } as PermissionRequest;

  it("start when asked and end when answered", () => {
    let tab = permissionAsked(newTab("s", "/w", { title: "t", mode: "default" }), req, 100);
    assert.equal(tab.permissions.length, 1);
    assert.deepEqual(tab.waits, [{ toolUseId: "tu1", requestId: "r1", start: 100 }]);
    tab = permissionAnswered(tab, "r1", 350);
    assert.equal(tab.permissions.length, 0);
    assert.deepEqual(tab.waits, [{ toolUseId: "tu1", requestId: "r1", start: 100, end: 350 }]);
  });

  it("end with the turn when nobody answered", () => {
    const tab = permissionAsked(newTab("s", "/w", { title: "t", mode: "default" }), req, 100);
    const done = tabEvent(
      tab,
      {
        type: "turn.completed",
        subtype: "error_during_execution",
        isError: true,
        totalCostUsd: 0,
        durationMs: 1,
        numTurns: 1,
      },
      900,
    );
    assert.equal(done.waits[0]?.end, 900);
    assert.equal(closeWaits(done.waits, 1000), done.waits, "nothing open: same list");
  });
});

describe("axis", () => {
  it("picks round steps, at most eight ticks", () => {
    assert.deepEqual(ticks(10_000), [0, 2000, 4000, 6000, 8000, 10_000]);
    assert.ok(ticks(3_600_000).length <= 8);
    assert.ok(ticks(500).length >= 1);
  });

  it("formats offsets", () => {
    assert.deepEqual([0, 2500, 45_000, 125_000, 3_725_000].map(clock), ["0 s", "2.5 s", "45 s", "2:05", "1:02:05"]);
  });
});
