import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newTab, tabEvent } from "./tabs.ts";
import { nestedTabs, teamSpend, teamTool, usdShort } from "./team.ts";

describe("Team chats (M8-03)", () => {
  it("names the Team tools by what they do, with the worker and its access", () => {
    assert.deepEqual(teamTool("mcp__agentchainer__assign", { name: "scan", prompt: "count files" }), {
      label: "Assign worker",
      detail: "scan: count files",
      access: "read",
    });
    assert.deepEqual(
      teamTool("mcp__agentchainer__handoff", { name: "fix", prompt: "x".repeat(100), access: "write" }),
      {
        label: "Hand off to worker",
        detail: `fix: ${"x".repeat(70)}…`,
        access: "write",
      },
    );
    assert.deepEqual(teamTool("mcp__agentchainer__send_message", { worker: "w1", text: "also tests" }), {
      label: "Message worker",
      detail: "w1: also tests",
    });
    assert.deepEqual(teamTool("mcp__agentchainer__read_inbox", {}), { label: "Read worker reports", detail: "" });
    assert.equal(teamTool("Bash", { command: "ls" }), null);
    assert.equal(teamTool("mcp__other__assign", {}), null);
  });

  it("lists each supervisor followed by its workers; an orphaned worker stands alone", () => {
    const tab = (id: string, parentId?: string) =>
      newTab(id, "/w", { title: id, mode: "default", ...(parentId ? { parentId } : {}) });
    const order = nestedTabs([tab("a"), tab("w1", "b"), tab("b"), tab("w2", "a"), tab("w3", "gone")]).map(
      ({ tab: t, child }) => `${child ? "  " : ""}${t.sessionId}`,
    );
    assert.deepEqual(order, ["a", "  w2", "b", "  w1", "w3"]);
  });

  it("keeps the team's spend from its events, and marks turns the sidecar starts as running", () => {
    let t = newTab("s", "/w", { title: "t", mode: "default", teamCapUsd: 2 });
    assert.deepEqual(t.team, { capUsd: 2, spentUsd: 0, stopped: false });
    assert.equal(teamSpend(t.team ?? { capUsd: 0, spentUsd: 0, stopped: false }), "Team · $0.00 of $2.00");
    t = tabEvent(t, { type: "team.budget", spentUsd: 0.42, capUsd: 2, stopped: false });
    assert.equal(teamSpend(t.team ?? { capUsd: 0, spentUsd: 0, stopped: false }), "Team · $0.42 of $2.00");
    t = tabEvent(t, { type: "worker.message", workerId: "w1", name: "scan", text: "12 files", isError: false });
    assert.equal(t.running, true);
    assert.deepEqual(
      t.items.map((i) => (i.kind === "worker" ? `${i.name}: ${i.text}` : i.kind)),
      ["scan: 12 files"],
    );
    assert.equal(
      teamSpend({ capUsd: 10_000_000, spentUsd: 1234.5, stopped: false }),
      "Team · $1,234.50 of $10,000,000.00",
    );
    t = tabEvent(t, { type: "team.budget", spentUsd: 2.1, capUsd: 2, stopped: true });
    assert.equal(teamSpend(t.team ?? { capUsd: 0, spentUsd: 0, stopped: false }), "Team stopped at its $2.00 cap");

    let w = newTab("w1", "/w", { title: "scan", mode: "default", parentId: "s", access: "read" });
    assert.deepEqual([w.parentId, w.access, w.team], ["s", "read", undefined]);
    w = tabEvent(w, { type: "user.message", messageId: "m1", text: "count files" });
    assert.equal(w.running, true);
    assert.equal(w.items.at(-1)?.kind, "user");
  });

  it("shortens money where the composer has little room", () => {
    assert.deepEqual([0, 0.023, 2, 2.5, 1500, 1000, 10_000_000, 2_500_000].map(usdShort), [
      "$0",
      "$0.02",
      "$2",
      "$2.50",
      "$1.5K",
      "$1K",
      "$10M",
      "$2.5M",
    ]);
  });
});
