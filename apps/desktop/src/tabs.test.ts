import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import { folderName, newTab, type Tab, tabEvent, updateTab } from "./tabs.ts";

const done = (totalCostUsd: number): AgentEvent => ({
  type: "turn.completed",
  subtype: "success",
  isError: false,
  totalCostUsd,
  durationMs: 1000,
  numTurns: 1,
});

describe("tabs", () => {
  it("derives each turn's cost from the session's running total", () => {
    let tab = newTab("s1", "/repo", { title: "t", mode: "default" });
    tab = tabEvent({ ...tab, running: true }, done(0.02));
    assert.deepEqual(tab.cost, { totalUsd: 0.02, lastUsd: 0.02, lastMs: 1000 });
    assert.equal(tab.running, false);
    tab = tabEvent(tab, done(0.05));
    assert.equal(tab.cost.totalUsd, 0.05);
    assert.ok(Math.abs((tab.cost.lastUsd ?? 0) - 0.03) < 1e-9, "the second turn cost 0.03, not 0.05");
  });

  it("doesn't guess the first turn's cost after a resume", () => {
    const tab = tabEvent(newTab("s1", "/repo", { title: "t", mode: "default", resumed: true }), done(0.4));
    assert.deepEqual(tab.cost, { totalUsd: 0.4, lastUsd: null, lastMs: 1000 });
  });

  it("routes events to the tab with the matching session id", () => {
    const tabs: Tab[] = [
      newTab("a", "/one", { title: "A", mode: "default" }),
      newTab("b", "/two", { title: "B", mode: "default" }),
    ];
    const next = updateTab(tabs, "b", (t) => tabEvent(t, { type: "text.delta", text: "hi" }));
    assert.equal(next[0]?.items.length, 0);
    assert.equal(next[1]?.items.length, 1);
  });

  it("takes the permission mode from session.started and ignores unknown ones", () => {
    const tab = newTab("s1", "/repo", { title: "t", mode: "default" });
    const started = (permissionMode: string): AgentEvent => ({
      type: "session.started",
      sessionId: "s1",
      model: "haiku",
      cwd: "/repo",
      claudeCodeVersion: "2.1.293",
      permissionMode,
    });
    assert.equal(tabEvent(tab, started("plan")).mode, "plan");
    assert.equal(tabEvent(tab, started("bypassPermissions")).mode, "default");
  });

  it("names tabs after the workspace folder", () => {
    assert.equal(folderName("/Users/me/projects/my-app/"), "my-app");
    assert.equal(folderName("C:\\code\\api"), "api");
  });
});
