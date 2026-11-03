import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import type { AgentSdkModule } from "./sdk-loader.ts";
import { ASK_FIRST, Session } from "./session.ts";

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
      return Object.assign(messages, {
        close: () => undefined,
        interrupt: async () => undefined,
        stopTask: async (id: string) => void stopped.push(id),
      });
    },
  } as unknown as AgentSdkModule;
  const stopped: string[] = [];
  return { sdk, options: () => options, stopped };
}

/**
 * A stand-in SDK that answers each user message with a scripted list of raw messages: a turn, and whatever the CLI
 * sends after it, like a turn of its own once background work ends (spike, CLI 2.1.314).
 */
function scriptedSdk(script: Record<string, unknown>[][]) {
  let options: Record<string, unknown> = {};
  const stopped: string[] = [];
  const sdk = {
    query: ({ prompt, options: o }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      options = o;
      const messages = (async function* () {
        let i = 0;
        for await (const _ of prompt) {
          const turn = script[i++];
          if (!turn) return;
          yield* turn;
        }
      })();
      return Object.assign(messages, {
        close: () => undefined,
        interrupt: async () => undefined,
        stopTask: async (id: string) => void stopped.push(id),
      });
    },
  } as unknown as AgentSdkModule;
  return { sdk, options: () => options, stopped };
}

const init = { type: "system", subtype: "init", session_id: "s", model: "m", cwd: "/w", permissionMode: "default" };
const result = (text: string, cost: number) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  total_cost_usd: cost,
  duration_ms: 5,
  num_turns: 1,
});
const tasks = (...ids: string[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({ task_id: id, task_type: "local_agent", description: id })),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("background work (M4-07)", () => {
  it("tells a turn the CLI starts on its own from the user's next turn", async () => {
    const { sdk } = scriptedSdk([
      [init, tasks("bg1"), result("launched", 0.1), tasks(), init, result("it finished", 0.2)],
      [init, result("second", 0.3)],
    ]);
    const events: AgentEvent[] = [];
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude", background: true }, callbacks(events));
    assert.equal((await s.turn("go")).text, "launched");
    await settle();
    assert.equal(events.filter((e) => e.type === "turn.started").length, 1, "only the CLI's own turn is announced");
    const second = await s.turn("again");
    assert.deepEqual([second.text, Math.round(second.costUsd * 100)], ["second", 10]);
    assert.equal(events.filter((e) => e.type === "turn.started").length, 1);
    s.close();
  });

  it("stops a background task while idle, and only a live one", async () => {
    const { sdk, stopped } = scriptedSdk([[init, tasks("bg1"), result("launched", 0.1)]]);
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude", background: true }, callbacks());
    await s.turn("go");
    await settle();
    assert.equal(await s.stopAgent("bg1"), true);
    assert.equal(await s.stopAgent("gone"), false);
    assert.deepEqual(stopped, ["bg1"]);
    s.close();
  });

  it("lets only interactive sessions run background work, with a Stop per task", () => {
    const on = scriptedSdk([]);
    new Session(on.sdk, { cwd: "/w", claudePath: "claude", background: true }, callbacks()).close();
    assert.deepEqual(on.options().env, { AGENTCHAINER_ALLOW_BACKGROUND: "1" });
    assert.equal(on.options().perTaskStopAffordance, true);
    const off = scriptedSdk([]);
    new Session(off.sdk, { cwd: "/w", claudePath: "claude" }, callbacks()).close();
    assert.equal(off.options().env, undefined);
    assert.equal(off.options().perTaskStopAffordance, undefined);
  });
});

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

  it("stops one subagent only while a turn runs (M4-05)", async () => {
    const { sdk, stopped } = fakeSdk([{ subtype: "success", result: "done", total_cost_usd: 0.1 }]);
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude" }, callbacks());
    assert.equal(await s.stopAgent("t1"), false, "idle: nothing to stop");
    const turn = s.turn("go");
    assert.equal(await s.stopAgent("t2"), true);
    await turn;
    assert.deepEqual(stopped, ["t2"]);
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

describe("Session.close", () => {
  it("resolves only once the CLI process has exited, and again after that", async () => {
    const spawned: { child?: { exitCode: number | null } } = {};
    // Spawns a stand-in CLI through the session's own spawner; it exits a moment after its stdin closes, like the CLI.
    const sdk = {
      query: ({ options }: { options: Record<string, unknown> }) => {
        const spawnCli = options.spawnClaudeCodeProcess as (o: Record<string, unknown>) => { exitCode: number | null };
        spawned.child = spawnCli({
          command: process.execPath,
          args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 300))"],
          env: process.env,
        });
        const proc = spawned.child as unknown as { stdin: { end(): void } };
        const messages = (async function* () {})();
        return Object.assign(messages, { close: () => proc.stdin.end(), interrupt: async () => undefined });
      },
    } as unknown as AgentSdkModule;
    const s = new Session(sdk, { cwd: process.cwd(), claudePath: "claude" }, callbacks());
    await s.close();
    assert.notEqual(spawned.child?.exitCode, null, "the process exited before close() resolved");
    await s.close();
  });

  it("resolves at once when no process was started", async () => {
    const { sdk } = fakeSdk([]);
    await new Session(sdk, { cwd: "/w", claudePath: "claude" }, callbacks()).close();
  });
});

describe("an interactive session (UX-12)", () => {
  /** One turn: init, then a result; the query also answers the command and context questions. */
  function chatSdk() {
    let options: Record<string, unknown> = {};
    const sdk = {
      query: ({ prompt, options: o }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
        options = o;
        const messages = (async function* () {
          for await (const _ of prompt) {
            yield {
              type: "system",
              subtype: "init",
              session_id: "s",
              model: "m",
              cwd: "/w",
              permissionMode: "default",
            };
            yield {
              type: "result",
              subtype: "success",
              duration_ms: 5,
              num_turns: 1,
              is_error: false,
              total_cost_usd: 0,
            };
            return;
          }
        })();
        return Object.assign(messages, {
          close: () => undefined,
          interrupt: async () => undefined,
          supportedCommands: async () => [
            { name: "compact", description: "Summarize the conversation", argumentHint: "<instructions>", aliases: [] },
          ],
          supportedModels: async () => [
            { value: "default", displayName: "Default (recommended)", description: "Opus · everyday" },
            { value: "haiku", displayName: "Haiku", description: "Fastest", supportedEffortLevels: ["low", "high"] },
          ],
          getContextUsage: async () => ({
            percentage: 23,
            totalTokens: 46_000,
            maxTokens: 200_000,
            categories: [
              { name: "System prompt", tokens: 3000, kind: "used" },
              { name: "Deferred tools", tokens: 9000, kind: "deferred" },
              { name: "Free space", tokens: 154_000, kind: "free" },
            ],
          }),
        });
      },
    } as unknown as AgentSdkModule;
    return { sdk, options: () => options };
  }

  it("sends its commands once, the context use after each turn, and asks the agent to ask first", async () => {
    const { sdk, options } = chatSdk();
    const events: AgentEvent[] = [];
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude", interactive: true }, callbacks(events));
    assert.deepEqual(options().systemPrompt, { type: "preset", preset: "claude_code", append: ASK_FIRST });
    await s.turn("hi");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(
      events.filter((e) => ["commands.changed", "models.changed", "context.usage"].includes(e.type)),
      [
        {
          type: "commands.changed",
          commands: [{ name: "compact", description: "Summarize the conversation", argumentHint: "<instructions>" }],
        },
        {
          type: "models.changed",
          models: [
            { value: "default", displayName: "Default (recommended)", description: "Opus · everyday" },
            { value: "haiku", displayName: "Haiku", description: "Fastest", efforts: ["low", "high"] },
          ],
        },
        {
          type: "context.usage",
          percentage: 23,
          totalTokens: 46_000,
          maxTokens: 200_000,
          categories: [
            { name: "System prompt", tokens: 3000, kind: "used" },
            { name: "Free space", tokens: 154_000, kind: "free" },
          ],
        },
      ],
    );
    s.close();
  });

  it("switches itself to plan mode without asking; other tools still ask", async () => {
    const { sdk, options } = chatSdk();
    const asked: string[] = [];
    const s = new Session(
      sdk,
      { cwd: "/w", claudePath: "claude", interactive: true },
      { ...callbacks(), askPermission: (r) => void asked.push(r.toolName) },
    );
    const canUseTool = options().canUseTool as (
      name: string,
      input: unknown,
      ctx: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const ctx = (id: string) => ({
      requestId: id,
      toolUseID: id,
      signal: new AbortController().signal,
      suggestions: [],
    });
    assert.deepEqual(await canUseTool("EnterPlanMode", {}, ctx("1")), {
      behavior: "allow",
      updatedInput: {},
      updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
    });
    void canUseTool("Bash", { command: "ls" }, ctx("2"));
    assert.deepEqual(asked, ["Bash"]);
    s.close();
  });

  it("leaves a task step's prompt and plan-mode approvals alone", async () => {
    const { sdk, options } = chatSdk();
    const asked: string[] = [];
    const s = new Session(
      sdk,
      { cwd: "/w", claudePath: "claude", appendSystemPrompt: "You implement." },
      { ...callbacks(), askPermission: (r) => void asked.push(r.toolName) },
    );
    assert.deepEqual(options().systemPrompt, { type: "preset", preset: "claude_code", append: "You implement." });
    const canUseTool = options().canUseTool as (n: string, i: unknown, c: Record<string, unknown>) => Promise<unknown>;
    void canUseTool("EnterPlanMode", {}, { requestId: "1", toolUseID: "1", signal: new AbortController().signal });
    assert.deepEqual(asked, ["EnterPlanMode"]);
    s.close();
  });
});

describe("Session.inject (UX-13)", () => {
  /** Like the CLI: a message sent while a turn runs joins that turn, which ends with one result. */
  function mergingSdk() {
    const seen: unknown[] = [];
    const sdk = {
      query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const messages = (async function* () {
          let first = true;
          for await (const m of prompt) {
            seen.push(m);
            if (!first) continue;
            first = false;
            await new Promise((r) => setTimeout(r, 20));
            yield {
              type: "result",
              subtype: "success",
              result: "done",
              duration_ms: 1,
              num_turns: 1,
              is_error: false,
              total_cost_usd: 0.02,
            };
          }
        })();
        return Object.assign(messages, { close: () => undefined, interrupt: async () => undefined });
      },
    } as unknown as AgentSdkModule;
    return { sdk, seen };
  }

  it("adds the person's message to the running turn without counting a turn, and shows it", async () => {
    const { sdk, seen } = mergingSdk();
    const events: AgentEvent[] = [];
    const s = new Session(sdk, { cwd: "/w", claudePath: "claude" }, callbacks(events));
    assert.equal(s.inject("too early"), false, "nothing runs yet");
    const turn = s.turn("implement it");
    assert.equal(s.inject("also keep the API"), true);
    const r = await turn;
    assert.deepEqual([r.text, r.costUsd], ["done", 0.02]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 2, "the message went to the CLI");
    const shown = events.find((e) => e.type === "user.message");
    assert.equal(shown?.type === "user.message" && shown.text, "also keep the API");
    assert.equal(s.inject("after the turn"), false);
    s.close();
  });
});
