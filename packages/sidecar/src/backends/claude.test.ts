import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSdkModule } from "../sdk-loader.ts";
import type { Session } from "../session.ts";
import { claudeBackend } from "./claude.ts";
import type { StepSession } from "./types.ts";

/** A stand-in SDK whose CLI answers one turn and then stops, as if its process exited. */
function oneTurnSdk(): AgentSdkModule {
  return {
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const messages = (async function* () {
        for await (const _ of prompt) {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            total_cost_usd: 0.02,
            duration_ms: 1,
            num_turns: 1,
          };
          return;
        }
      })();
      return Object.assign(messages, { close: () => undefined, interrupt: async () => undefined });
    },
  } as unknown as AgentSdkModule;
}

describe("the Claude step backend (M9-03)", () => {
  it("opens a step session where approvals reach it, runs a turn, and unregisters it when it ends", async () => {
    const registered = new Map<string, Session>();
    let ended = 0;
    let done: () => void = () => undefined;
    const over = new Promise<void>((resolve) => {
      done = resolve;
    });
    const open = claudeBackend({
      sdk: oneTurnSdk(),
      claudePath: "claude",
      register: (s) => registered.set(s.id, s),
      unregister: (id) => registered.delete(id),
    });
    const session: StepSession = await open(
      { cwd: process.cwd(), readOnly: true, maxTurns: 3 },
      {
        emit: () => undefined,
        askPermission: () => undefined,
        onEnd: () => {
          ended++;
          done();
        },
      },
    );
    assert.ok(registered.has(session.id), "registered as soon as it opens");
    const r = await session.turn("Look around.");
    assert.deepEqual([r.subtype, r.text, r.costUsd], ["success", "done", 0.02]);
    await session.close();
    // The session ends when its CLI's stream does, a moment after the turn.
    await over;
    assert.equal(registered.size, 0, "gone from the registry once it ended");
    assert.equal(ended, 1, "the runner's own onEnd ran once");
  });
});
