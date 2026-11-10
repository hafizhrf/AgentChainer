import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { threadInfo, turnEvents } from "./codex-history.ts";

describe("Codex threads as Previous sessions (M9-09)", () => {
  it("names a thread by its name, else its first line, and keeps its times in milliseconds", () => {
    assert.deepEqual(
      threadInfo({
        id: "01a1c5db-c11e-7120-9727-6c5f8bdc70d8",
        name: null,
        preview: "Fix the cart\nmore",
        createdAt: 10,
        updatedAt: 20,
      }),
      {
        sessionId: "01a1c5db-c11e-7120-9727-6c5f8bdc70d8",
        title: "Fix the cart",
        lastModified: 20_000,
        createdAt: 10_000,
        agent: "codex",
      },
    );
    assert.equal(threadInfo({ id: "x", name: "Cart total", preview: "p" })?.title, "Cart total");
    assert.equal(threadInfo({ name: "no id" }), null);
  });

  it("replays a turn: the person's message, the agent's text, and its commands as tools", () => {
    const events = turnEvents([
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "Run the tests" }] },
      { type: "reasoning", id: "r1" },
      { type: "agentMessage", id: "a1", text: "Running them." },
      {
        type: "commandExecution",
        id: "c1",
        command: "npm test",
        commandActions: [{ type: "unknown", command: "npm test" }],
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "ok",
      },
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      ["user.message", "text.delta", "tool.started", "tool.completed"],
    );
    assert.equal(events[0]?.type === "user.message" ? events[0].text : "", "Run the tests");
  });
});
