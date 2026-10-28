import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import { type AgentItem, applyEvent, type Item } from "./transcript.ts";

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
