import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import { type AgentItem, applyEvent, groupItems, type Item, type ToolItem } from "./transcript.ts";

const run = (events: AgentEvent[]) => events.reduce<Item[]>(applyEvent, []);

describe("transcript reducer", () => {
  it("nests a subagent's tool calls and text inside its card", () => {
    const items = run([
      { type: "text.delta", text: "Launching two agents." },
      {
        type: "tool.started",
        toolUseId: "A",
        name: "Agent",
        input: { description: "List files", subagent_type: "general-purpose" },
        parentToolUseId: null,
      },
      { type: "agent.started", toolUseId: "A", taskId: "t1", description: "List files", agentType: "general-purpose" },
      { type: "tool.started", toolUseId: "A1", name: "Bash", input: { command: "ls" }, parentToolUseId: "A" },
      { type: "agent.text", parentToolUseId: "A", text: "Found 0 files." },
      { type: "tool.completed", toolUseId: "A1", isError: false, output: "", parentToolUseId: "A" },
      { type: "tool.completed", toolUseId: "A", isError: false, output: "hand-back", parentToolUseId: null },
      {
        type: "agent.completed",
        toolUseId: "A",
        taskId: "t1",
        status: "completed",
        summary: "Listed files",
        totalTokens: 1200,
        durationMs: 3400,
      },
      { type: "turn.completed", subtype: "success", isError: false, totalCostUsd: 0.01, durationMs: 5000, numTurns: 2 },
    ]);

    assert.deepEqual(
      items.map((i) => i.kind),
      ["assistant", "agent"],
      "no stray top-level tool cards",
    );
    const agent = items[1] as AgentItem;
    assert.equal(agent.status, "done");
    assert.equal(agent.summary, "Listed files");
    assert.equal(agent.tokens, 1200);
    assert.deepEqual(
      agent.children.map((c) => c.kind),
      ["tool", "text"],
    );
    assert.equal(agent.children[0]?.kind === "tool" && agent.children[0].status, "done");
  });

  it("keeps main-agent tools top level and starts a new text block after a tool", () => {
    const items = run([
      { type: "text.delta", text: "a" },
      { type: "tool.started", toolUseId: "T", name: "Read", input: { file_path: "x" }, parentToolUseId: null },
      {
        type: "tool.completed",
        toolUseId: "T",
        isError: true,
        output: "Blocked by AgentChainer guard: …",
        parentToolUseId: null,
      },
      { type: "text.delta", text: "b" },
    ]);
    assert.deepEqual(
      items.map((i) => i.kind),
      ["assistant", "tool", "assistant"],
    );
    assert.equal(items[1]?.kind === "tool" && items[1].status, "error");
  });

  it("tells stopped subagents from failed ones", () => {
    const items = run([
      { type: "agent.started", toolUseId: "B", taskId: "t2", description: "Slow job" },
      { type: "agent.started", toolUseId: "C", taskId: "t3", description: "Broken job" },
      { type: "agent.completed", toolUseId: "B", taskId: "t2", status: "stopped", summary: "Interrupted" },
      { type: "agent.completed", toolUseId: "C", taskId: "t3", status: "failed", summary: "Crashed" },
    ]);
    assert.deepEqual(
      items.map((i) => i.kind === "agent" && i.status),
      ["stopped", "error"],
    );
  });
});

describe("transcript: the agent tree (M4-01)", () => {
  const spawn = (id: string, parent: string | null): AgentEvent => ({
    type: "tool.started",
    toolUseId: id,
    name: "Agent",
    input: { description: `Agent ${id}`, prompt: `Do ${id}` },
    parentToolUseId: parent,
  });

  it("nests a subagent's own subagent inside its card, with its tool calls", () => {
    const items = run([
      spawn("A", null),
      { type: "agent.started", toolUseId: "A", taskId: "tA", description: "Outer", depth: 1 },
      spawn("B", "A"),
      { type: "agent.started", toolUseId: "B", taskId: "tB", description: "Inner", depth: 2, parentTaskId: "tA" },
      { type: "tool.started", toolUseId: "b1", name: "Bash", input: {}, parentToolUseId: "B" },
      { type: "tool.completed", toolUseId: "b1", isError: false, output: "ok", parentToolUseId: "B" },
      { type: "agent.completed", toolUseId: "B", taskId: "tB", status: "completed", summary: "inner done" },
      { type: "tool.completed", toolUseId: "B", isError: false, output: "hand-back", parentToolUseId: "A" },
    ]);
    assert.equal(items.length, 1);
    const outer = items[0] as AgentItem;
    const inner = outer.children[0] as AgentItem;
    assert.equal(inner.kind, "agent");
    assert.equal(inner.taskId, "tB");
    assert.equal(inner.prompt, "Do B");
    assert.equal(inner.status, "done");
    assert.deepEqual(
      inner.children.map((c) => c.kind === "tool" && [c.name, c.status]),
      [["Bash", "done"]],
    );
  });

  it("puts an agent with no spawn call under its parent task", () => {
    const items = run([
      { type: "agent.started", toolUseId: "A", taskId: "tA", description: "Outer" },
      { type: "agent.started", toolUseId: "B", taskId: "tB", description: "Inner", parentTaskId: "tA" },
    ]);
    assert.equal(items.length, 1);
    assert.equal((items[0] as AgentItem).children[0]?.kind, "agent");
  });

  it("tracks progress while running, task state by task id, and keeps the final totals", () => {
    const progress = (tokens: number): AgentEvent => ({
      type: "agent.progress",
      toolUseId: "A",
      taskId: "tA",
      totalTokens: tokens,
      toolUses: 1,
      durationMs: 900,
      lastTool: "Bash",
    });
    const live = run([
      { type: "agent.started", toolUseId: "A", taskId: "tA", description: "Job" },
      progress(500),
      { type: "agent.updated", taskId: "tA", status: "paused", pausedMs: 30 },
    ])[0] as AgentItem;
    assert.deepEqual([live.status, live.tokens, live.lastTool, live.pausedMs], ["paused", 500, "Bash", 30]);

    const ended = run([
      { type: "agent.started", toolUseId: "A", taskId: "tA", description: "Job" },
      { type: "agent.updated", taskId: "tA", status: "killed", endTime: 5_000 },
      { type: "agent.completed", toolUseId: "A", taskId: "tA", status: "stopped", summary: "", totalTokens: 800 },
      progress(600),
      { type: "agent.updated", taskId: "unknown-shell", status: "completed" },
    ])[0] as AgentItem;
    assert.deepEqual([ended.status, ended.tokens, ended.endedAt], ["stopped", 800, 5_000]);
  });

  it("leaves an untouched transcript's array as it was", () => {
    const items = run([{ type: "text.delta", text: "Hi" }]);
    assert.equal(applyEvent(items, { type: "agent.updated", taskId: "none", status: "running" }), items);
  });
});

describe("transcript: thinking and tool timing", () => {
  it("collapses thinking into its own block before the reply", () => {
    const items = run([
      { type: "thinking.delta", text: "Let me " },
      { type: "thinking.delta", text: "check." },
      { type: "text.delta", text: "Done." },
    ]);
    assert.deepEqual(
      items.map((i) => [i.kind, "text" in i ? i.text : "", "open" in i ? i.open : null]),
      [
        ["thinking", "Let me check.", false],
        ["assistant", "Done.", true],
      ],
    );
  });

  it("times live tool calls and leaves replayed ones untimed", () => {
    const started = { type: "tool.started", toolUseId: "t", name: "Bash", input: {}, parentToolUseId: null } as const;
    const done = { type: "tool.completed", toolUseId: "t", isError: false, output: "", parentToolUseId: null } as const;
    const live = applyEvent(applyEvent([], started, 1000), done, 3500);
    assert.equal(live[0]?.kind === "tool" && live[0].durationMs, 2500);
    const replayed = applyEvent(applyEvent([], started), done);
    assert.equal(replayed[0]?.kind === "tool" && replayed[0].durationMs, undefined);
  });
});

describe("transcript: timestamps and tool groups (UX-04)", () => {
  it("stamps live messages with their arrival time, and replayed ones not at all", () => {
    const live = applyEvent([], { type: "text.delta", text: "Hi" }, 1_000);
    assert.equal(live[0]?.kind === "assistant" && live[0].at, 1_000);
    const replayed = applyEvent([], { type: "user.message", text: "Hello", messageId: "m1" });
    assert.equal(replayed[0]?.kind === "user" && replayed[0].at, undefined);
  });

  const tool = (id: string, status: ToolItem["status"] = "done"): ToolItem => ({
    kind: "tool",
    id,
    name: "Read",
    input: {},
    status,
  });
  const text = (id: number): Item => ({ kind: "assistant", id, text: "…", open: false });
  const thought = (id: number, open = false): Item => ({ kind: "thinking", id, text: "…", open });

  it("groups two or more tool calls in a row, with the thinking between them", () => {
    const rows = groupItems([text(1), tool("a"), thought(2), tool("b"), tool("c"), text(3)]);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ["assistant", "tools", "assistant"],
    );
    const group = rows[1];
    assert.deepEqual(group?.kind === "tools" && group.members.map((m) => m.id), ["a", 2, "b", "c"]);
  });

  it("leaves a single call alone, and keeps trailing or streaming thinking outside the group", () => {
    assert.deepEqual(
      groupItems([text(1), tool("a"), text(2)]).map((r) => r.kind),
      ["assistant", "tool", "assistant"],
    );
    assert.deepEqual(
      groupItems([tool("a"), tool("b"), thought(3), text(4)]).map((r) => r.kind),
      ["tools", "thinking", "assistant"],
    );
    assert.deepEqual(
      groupItems([tool("a"), thought(5, true)]).map((r) => r.kind),
      ["tool", "thinking"],
    );
  });
});
