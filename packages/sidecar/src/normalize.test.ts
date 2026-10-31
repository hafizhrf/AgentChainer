import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalize } from "./normalize.ts";

/** Real stream recorded in spike S4: one prompt that launches two parallel subagents (haiku, CLI 2.1.293). */
function replay(name: string): AgentEvent[] {
  const lines = readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);
  return lines.flatMap((line) => normalize(JSON.parse(line) as SDKMessage));
}

describe("normalize: subagents-parallel fixture", () => {
  const events = replay("subagents-parallel.jsonl");
  const of = <T extends AgentEvent["type"]>(type: T) =>
    events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

  it("reports two subagents, each started and completed by the Agent tool call that spawned it", () => {
    const started = of("agent.started");
    const completed = of("agent.completed");
    assert.equal(started.length, 2);
    assert.deepEqual(new Set(completed.map((e) => e.toolUseId)), new Set(started.map((e) => e.toolUseId)));
    for (const e of completed) assert.equal(e.status, "completed");

    const agentCalls = of("tool.started").filter((e) => e.name === "Agent");
    assert.deepEqual(new Set(agentCalls.map((e) => e.toolUseId)), new Set(started.map((e) => e.toolUseId)));
    for (const call of agentCalls) assert.equal(call.parentToolUseId, null, "Agent calls come from the main agent");
  });

  it("attaches each subagent's tool calls and text to its own agent", () => {
    const agents = new Set(of("agent.started").map((e) => e.toolUseId));
    const nested = of("tool.started").filter((e) => e.parentToolUseId !== null);
    assert.ok(nested.length >= 2);
    for (const e of nested) {
      assert.ok(e.parentToolUseId !== null && agents.has(e.parentToolUseId), `tool ${e.name} belongs to a known agent`);
    }
    assert.deepEqual(new Set(nested.map((e) => e.parentToolUseId)), agents, "both agents did work");

    const nestedResults = of("tool.completed").filter((e) => e.parentToolUseId !== null);
    assert.equal(nestedResults.length, nested.length, "every subagent tool call completes inside its agent");
    for (const t of of("agent.text")) assert.ok(agents.has(t.parentToolUseId));
  });

  it("reports progress and state changes by task, with the prompt and run id (M4-01)", () => {
    const started = of("agent.started");
    for (const e of started) {
      assert.ok(e.prompt, "the prompt the subagent got");
      assert.ok(e.runId);
      assert.equal(e.parentTaskId, undefined, "spawned by the main agent");
    }
    const tasks = new Set(started.map((e) => e.taskId));
    const progress = of("agent.progress");
    assert.ok(progress.length >= 2);
    for (const e of progress) {
      assert.ok(tasks.has(e.taskId));
      assert.ok(e.totalTokens > 0);
      assert.equal(e.lastTool, "Bash");
    }
    const updated = of("agent.updated");
    assert.deepEqual(new Set(updated.map((e) => e.taskId)), tasks);
    for (const e of updated) {
      assert.equal(e.status, "completed");
      assert.ok(e.endTime && e.endTime > 0);
    }
  });

  it("streams main-agent text and ends with one successful turn", () => {
    assert.ok(of("text.delta").length > 0);
    const turns = of("turn.completed");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.subtype, "success");
  });
});

describe("normalize: subagents-nested fixture (CLI 2.1.314)", () => {
  const events = replay("subagents-nested.jsonl");
  const started = events.filter((e) => e.type === "agent.started");

  it("names the parent task of a subagent spawned by a subagent (M4-01)", () => {
    assert.equal(started.length, 2);
    const [outer, inner] = started;
    assert.equal(outer?.depth, 1);
    assert.equal(outer?.parentTaskId, undefined);
    assert.equal(inner?.depth, 2);
    assert.equal(inner?.parentTaskId, outer?.taskId);
  });

  it("attributes the inner Agent call to the outer subagent and the Bash call to the inner one", () => {
    const [outer, inner] = started;
    const calls = events.filter((e) => e.type === "tool.started");
    const spawn = calls.find((e) => e.toolUseId === inner?.toolUseId);
    assert.equal(spawn?.parentToolUseId, outer?.toolUseId);
    const bash = calls.find((e) => e.name === "Bash");
    assert.equal(bash?.parentToolUseId, inner?.toolUseId);
  });
});

describe("normalize: streamed thinking, slash commands and usage", () => {
  const msg = (m: unknown) => normalize(m as SDKMessage);

  it("streams the main agent's thinking but not a subagent's", () => {
    const delta = (parent: string | null) => ({
      type: "stream_event",
      parent_tool_use_id: parent,
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    assert.deepEqual(msg(delta(null)), [{ type: "thinking.delta", text: "hmm" }]);
    assert.deepEqual(msg(delta("A")), []);
  });

  it("sums token usage over models into turn.completed", () => {
    const [done] = msg({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.02,
      duration_ms: 900,
      num_turns: 1,
      modelUsage: {
        haiku: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 },
        sonnet: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
      },
    });
    assert.deepEqual(done?.type === "turn.completed" && done.usage, {
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 103,
      cacheCreationTokens: 24,
    });
  });
});

describe("normalize: turn-basics fixture", () => {
  // Recorded with `spike-host --scenario fixtures` (haiku, CLI 2.1.293): a turn with summarized thinking, a Write
  // call and a reply, then a session stopped by a $0.0001 budget cap.
  const events = replay("turn-basics.jsonl");
  const types = new Set(events.map((e) => e.type));

  it("covers a whole main-agent turn", () => {
    for (const t of ["session.started", "thinking.delta", "text.delta", "tool.started", "tool.completed"] as const) {
      assert.ok(types.has(t), `missing ${t}`);
    }
    const write = events.find((e) => e.type === "tool.started" && e.name === "Write");
    assert.ok(write, "the Write call");
    const done = events.filter((e) => e.type === "turn.completed");
    assert.deepEqual(
      done.map((e) => e.type === "turn.completed" && [e.subtype, e.isError]),
      [
        ["success", false],
        ["error_max_budget_usd", true],
      ],
    );
  });

  it("with subagents-parallel, covers every event the normalizer emits", () => {
    // user.message only comes from session.history, and error from the session runtime, not from SDK messages.
    const all = new Set([...types, ...replay("subagents-parallel.jsonl").map((e) => e.type)]);
    const emitted = [
      "session.started",
      "text.delta",
      "thinking.delta",
      "tool.started",
      "tool.completed",
      "agent.started",
      "agent.progress",
      "agent.updated",
      "agent.text",
      "agent.completed",
      "turn.completed",
    ];
    assert.deepEqual(
      emitted.filter((t) => !all.has(t as AgentEvent["type"])),
      [],
    );
  });
});

describe("event snapshots for UI tests (M1-34)", () => {
  // apps/desktop replays these through a fake transport. Regenerate with UPDATE_FIXTURES=1 after re-recording.
  for (const name of ["turn-basics", "subagents-parallel", "subagents-nested"]) {
    it(`${name}.events.json is up to date`, () => {
      const file = new URL(`../test/fixtures/${name}.events.json`, import.meta.url);
      const text = `${JSON.stringify(replay(`${name}.jsonl`), null, 1)}\n`;
      if (process.env.UPDATE_FIXTURES === "1") writeFileSync(file, text);
      assert.equal(readFileSync(file, "utf8"), text);
    });
  }
});
