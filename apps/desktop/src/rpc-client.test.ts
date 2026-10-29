import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import { createClient, SidecarError, type Transport } from "./rpc-client.ts";
import { newTab, type Tab, tabEvent } from "./tabs.ts";

/**
 * UI tests driven by recorded fixtures through a fake transport (M1-34). The events are the sidecar normalizer's
 * output for real recorded SDK streams (packages/sidecar/test/fixtures/*.events.json, kept current by a sidecar test),
 * so these runs exercise the client's validation and the transcript reducers without a live API call.
 */
const SESSION = "6f1c0b3e-8d2a-4c5b-9e7f-0a1b2c3d4e5f";

const fixture = (name: string): AgentEvent[] =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/sidecar/test/fixtures/${name}.events.json`, import.meta.url), "utf8"),
  ) as AgentEvent[];

/** A sidecar stand-in: answers requests with `replies` and, after `session.send`, streams `events` as notifications. */
function fakeSidecar(events: AgentEvent[], replies: Record<string, unknown> = {}) {
  let deliver: (raw: string) => void = () => undefined;
  const sent: { method: string; params: unknown }[] = [];
  const transport: Transport = {
    listen: async ({ frame }) => {
      deliver = frame;
    },
    send: async (raw) => {
      const req = JSON.parse(raw) as { id: number; method: string; params: unknown };
      sent.push(req);
      const reply = replies[req.method] ?? defaults[req.method];
      queueMicrotask(() => {
        deliver(
          JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            ...(reply instanceof Error ? { error: reply } : { result: reply }),
          }),
        );
        if (req.method === "session.send") {
          // Noise the client must drop: an unknown notification and a malformed event.
          deliver(JSON.stringify({ jsonrpc: "2.0", method: "agent.unknown", params: {} }));
          deliver(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "agent.event",
              params: { sessionId: SESSION, event: { type: "text.delta" } },
            }),
          );
          for (const event of events)
            deliver(JSON.stringify({ jsonrpc: "2.0", method: "agent.event", params: { sessionId: SESSION, event } }));
        }
      });
    },
  };
  return { transport, sent };
}

const defaults: Record<string, unknown> = {
  "session.start": { sessionId: SESSION },
  "session.send": { ok: true, messageId: "m1" },
};

/** Runs one turn the way App does: start, subscribe, send, then fold notifications into the tab. */
async function runTurn(events: AgentEvent[]): Promise<Tab> {
  const { transport } = fakeSidecar(events);
  const client = createClient(transport);
  const { sessionId } = await client.request("session.start", { cwd: "/workspace" });
  let tab = newTab(sessionId, "/workspace", { title: "t", mode: "default" });
  let clock = 1_000;
  // Done once every result in the replay has arrived (notifications are re-parsed copies, so count them).
  let results = events.filter((e) => e.type === "turn.completed").length;
  const done = new Promise<void>((resolve) => {
    client.subscribe((n) => {
      if (n.method !== "agent.event" || n.params.sessionId !== sessionId) return;
      clock += 100;
      tab = tabEvent(tab, n.params.event, clock);
      if (n.params.event.type === "turn.completed" && --results === 0) resolve();
    });
  });
  await client.request("session.send", { sessionId, text: "go" });
  await done;
  return tab;
}

describe("UI over a fake transport: turn-basics fixture", () => {
  it("builds the transcript of a real turn: thinking, a timed Write card with its diff, the reply, the cost", async () => {
    const events = fixture("turn-basics");
    // The fixture holds two sessions' results; replay up to the first one (the successful turn).
    const first = events.findIndex((e) => e.type === "turn.completed");
    const tab = await runTurn(events.slice(0, first + 1));
    const kinds = tab.items.map((i) => i.kind);
    assert.ok(kinds.includes("thinking"), `kinds=${kinds}`);
    const write = tab.items.find((i) => i.kind === "tool" && i.name === "Write");
    assert.ok(
      write?.kind === "tool" && write.status === "done" && (write.durationMs ?? 0) > 0,
      "a finished, timed Write",
    );
    const reply = tab.items.filter((i) => i.kind === "assistant").at(-1);
    assert.ok(
      reply?.kind === "assistant" && reply.text.includes("391"),
      `reply=${reply?.kind === "assistant" ? reply.text : ""}`,
    );
    assert.equal(tab.running, false);
    assert.equal(tab.lastSubtype, "success");
    assert.ok((tab.cost.totalUsd ?? 0) > 0 && tab.cost.lastTokens !== null);
    assert.equal(tab.model, "claude-haiku-5-5");
  });

  it("ends a budget-capped turn as an error, which keeps queued messages from going out", async () => {
    const events = fixture("turn-basics");
    const first = events.findIndex((e) => e.type === "turn.completed");
    const tab = await runTurn(events.slice(first + 1));
    assert.equal(tab.lastSubtype, "error_max_budget_usd");
  });
});

describe("UI over a fake transport: subagents-parallel fixture", () => {
  it("nests each subagent's tool calls inside its card", async () => {
    const tab = await runTurn(fixture("subagents-parallel"));
    const agents = tab.items.filter((i) => i.kind === "agent");
    assert.equal(agents.length, 2);
    for (const a of agents) {
      assert.ok(a.kind === "agent" && a.status === "done" && a.children.some((c) => c.kind === "tool"));
    }
    assert.equal(
      tab.items.filter((i) => i.kind === "tool" && i.name === "Bash").length,
      0,
      "subagent Bash calls stay inside their cards",
    );
  });
});

describe("client validation over the fake transport", () => {
  it("rejects results that break the protocol, and maps error codes", async () => {
    const bad = createClient(fakeSidecar([], { "system.ping": { ok: false } }).transport);
    await assert.rejects(bad.request("system.ping", {}), /Invalid result for system.ping/);
    const failing = createClient(
      fakeSidecar([], { "session.interrupt": Object.assign(new Error(), { code: -32001, message: "No session" }) })
        .transport,
    );
    await assert.rejects(failing.request("session.interrupt", { sessionId: SESSION }), (err: unknown) => {
      return err instanceof SidecarError && err.code === -32001;
    });
  });
});
