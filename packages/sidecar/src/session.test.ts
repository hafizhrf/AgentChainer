import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import type { AgentSdkModule } from "./sdk-loader.ts";
import { Session } from "./session.ts";

/**
 * A stand-in SDK: `query()` answers every user message with a scripted `result`, as the CLI does at the end of a turn.
 * Costs are running totals, like the SDK's.
 */
function fakeSdk(results: Record<string, unknown>[]) {
  let options: Record<string, unknown> = {};
  const sdk = {
    query: ({ prompt, options: o }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      options = o;
      const messages = (async function* () {
        let i = 0;
        for await (const _ of prompt) {
          const r = results[i++];
          if (!r) return;
          yield { type: "result", duration_ms: 5, num_turns: 1, is_error: false, ...r };
        }
      })();
      return Object.assign(messages, { close: () => undefined, interrupt: async () => undefined });
    },
  } as unknown as AgentSdkModule;
  return { sdk, options: () => options };
}

const callbacks = (events: AgentEvent[] = []) => ({
  emit: (e: AgentEvent) => events.push(e),
  askPermission: () => undefined,
  onEnd: () => undefined,
});

describe("Session.turn", () => {
  it("resolves each turn with its own cost, text and structured output", async () => {
    const { sdk } = fakeSdk([
      { subtype: "success", result: "first", total_cost_usd: 0.1 },
      { subtype: "success", result: "{}", structured_output: { verdict: "approve" }, total_cost_usd: 0.25 },
    ]);
    const events: AgentEvent[] = [];
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude" }, callbacks(events));
    const one = await s.turn("go");
    assert.deepEqual([one.subtype, one.text, one.costUsd], ["success", "first", 0.1]);
    const two = await s.turn("again");
    assert.deepEqual(two.structured, { verdict: "approve" });
    assert.equal(Math.round(two.costUsd * 100), 15);
    assert.equal(events.filter((e) => e.type === "turn.completed").length, 2, "the UI still gets every event");
    s.close();
  });

  it("reports a stopped turn without text", async () => {
    const { sdk } = fakeSdk([{ subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 1 }]);
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude" }, callbacks());
    const r = await s.turn("go");
    assert.deepEqual([r.subtype, r.isError, r.text], ["error_max_budget_usd", true, ""]);
    s.close();
  });

  it("rejects a turn the session ends before", async () => {
    const { sdk } = fakeSdk([]);
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude" }, callbacks());
    await assert.rejects(s.turn("go"), /ended before its turn finished/);
  });

  it("isolates a read-only step: read tools, no user settings, a role prompt, the read-only hook", async () => {
    const { sdk, options } = fakeSdk([]);
    const s = new Session(
      sdk,
      { cwd: "/w", claudePath: "claude", readOnly: true, appendSystemPrompt: "You plan.", maxTurns: 7 },
      callbacks(),
    );
    const o = options();
    assert.deepEqual(o.tools, ["Read", "Grep", "Glob"]);
    assert.deepEqual(o.settingSources, []);
    assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: "You plan." });
    assert.equal(o.maxTurns, 7);
    const hook = (o.hooks as { PreToolUse: { hooks: ((i: unknown) => Promise<unknown>)[] }[] }).PreToolUse[0]?.hooks[0];
    const decide = async (tool_name: string, tool_input: unknown) =>
      (
        (await hook?.({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: "/w" })) as {
          hookSpecificOutput?: { permissionDecision: string };
        }
      )?.hookSpecificOutput?.permissionDecision ?? "allow";
    assert.equal(await decide("Read", { file_path: "/w/src/a.ts" }), "allow");
    assert.equal(await decide("Read", { file_path: "/etc/passwd" }), "deny");
    assert.equal(await decide("Write", { file_path: "/w/a.ts" }), "deny");
    assert.equal(await decide("Bash", { command: "ls" }), "deny");
    s.close();
  });

  it("leaves a normal session as it was", async () => {
    const { sdk, options } = fakeSdk([]);
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude" }, callbacks());
    assert.deepEqual(options().settingSources, ["user", "project", "local"]);
    assert.equal(options().tools, undefined);
    assert.equal(options().systemPrompt, undefined);
    s.close();
  });
});
