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

  it("marks failed or stopped subagents as errors", () => {
    const items = run([
      { type: "agent.started", toolUseId: "B", taskId: "t2", description: "Slow job" },
      { type: "agent.completed", toolUseId: "B", taskId: "t2", status: "stopped", summary: "Interrupted" },
    ]);
    assert.equal((items[0] as AgentItem).status, "error");
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
