import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@agentchainer/protocol";
import { normalize } from "./normalize.ts";

/** Real stream recorded in spike S4: one prompt that launches two parallel subagents (haiku, CLI 2.1.293). */
function replay(name: string): AgentEvent[] {
  const lines = readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);
  return lines.flatMap((line) => normalize(JSON.parse(line) as SDKMessage));
}

describe("normalize: subagents-parallel fixture", () => {
  const events = replay("subagents-parallel.jsonl");
  const of = <T extends AgentEvent["type"]>(type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);

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
    for (const e of nested) assert.ok(agents.has(e.parentToolUseId!), `tool ${e.name} belongs to a known agent`);
    assert.deepEqual(new Set(nested.map((e) => e.parentToolUseId)), agents, "both agents did work");

    const nestedResults = of("tool.completed").filter((e) => e.parentToolUseId !== null);
    assert.equal(nestedResults.length, nested.length, "every subagent tool call completes inside its agent");
    for (const t of of("agent.text")) assert.ok(agents.has(t.parentToolUseId));
  });

  it("streams main-agent text and ends with one successful turn", () => {
    assert.ok(of("text.delta").length > 0);
    const turns = of("turn.completed");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.subtype, "success");
  });
});
