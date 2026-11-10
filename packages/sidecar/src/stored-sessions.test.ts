import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSdkModule } from "./sdk-loader.ts";
import { DEFAULT_RETENTION_DAYS, historyEvents, replayEvents, retention, toSessionInfo } from "./stored-sessions.ts";

const msg = (
  type: SessionMessage["type"],
  uuid: string,
  content: unknown,
  parent: string | null = null,
): SessionMessage => ({
  type,
  uuid,
  session_id: "s",
  message: { role: type, content },
  parent_tool_use_id: parent,
  parent_agent_id: null,
});

describe("historyEvents", () => {
  it("replays a conversation as the events a live session emits", () => {
    const events = historyEvents([
      msg("user", "u1", "Fix the bug"),
      msg("assistant", "a1", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Looking." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ]),
      msg("user", "u2", [{ type: "tool_result", tool_use_id: "t1", content: "contents" }]),
      msg("assistant", "a2", [{ type: "text", text: "Done." }]),
    ]);
    assert.deepEqual(events, [
      { type: "user.message", messageId: "u1", text: "Fix the bug" },
      { type: "text.delta", text: "Looking." },
      { type: "tool.started", toolUseId: "t1", name: "Read", input: { file_path: "a.ts" }, parentToolUseId: null },
      { type: "tool.completed", toolUseId: "t1", isError: false, output: "contents", parentToolUseId: null },
      { type: "text.delta", text: "Done." },
    ]);
  });

  it("skips text the user didn't type, like command output and reminders", () => {
    const events = historyEvents([
      msg("user", "u1", "<local-command-stdout>ok</local-command-stdout>\n<system-reminder>x</system-reminder>"),
      msg("user", "u2", [
        { type: "text", text: "<local-command-stdout>ok</local-command-stdout>" },
        { type: "text", text: "real prompt" },
      ]),
    ]);
    assert.deepEqual(events, [{ type: "user.message", messageId: "u2", text: "real prompt" }]);
  });

  it("replays a slash command as the person typed it, not as the CLI's tags (M1-37)", () => {
    const compact =
      "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>";
    const review = [
      {
        type: "text",
        text: "<command-name>/review</command-name><command-message>review</command-message><command-args>src/cart.js</command-args>",
      },
    ];
    assert.deepEqual(
      historyEvents([
        msg("user", "u1", compact),
        msg("user", "u2", review),
        msg("user", "u3", "<command-name>/clear</command-name>"),
      ]),
      [
        { type: "user.message", messageId: "u1", text: "/compact" },
        { type: "user.message", messageId: "u2", text: "/review src/cart.js" },
        { type: "user.message", messageId: "u3", text: "/clear" },
      ],
    );
  });

  it("counts pasted images on user messages", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    assert.deepEqual(historyEvents([msg("user", "u1", [image, { type: "text", text: "what is this?" }])]), [
      { type: "user.message", messageId: "u1", text: "what is this?", imageCount: 1 },
    ]);
  });

  it("ignores messages without readable content", () => {
    const odd = { ...msg("assistant", "a1", null), message: "not an object" };
    assert.deepEqual(historyEvents([odd, msg("system", "s1", "compacted")]), []);
  });
});

/** A stored message with the CLI's `timestamp`, `sec` seconds into the session. */
const at = (m: SessionMessage, sec: number): SessionMessage =>
  ({ ...m, timestamp: new Date(Date.UTC(2026, 10, 1, 9, 0, sec)).toISOString() }) as SessionMessage;
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const spawn = (id: string, description: string) => ({
  type: "tool_use",
  id,
  name: "Agent",
  input: { description, prompt: `Do ${description}`, subagent_type: "general-purpose" },
});
const result = (id: string, text: string, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content: [{ type: "text", text }],
  ...(isError ? { is_error: true } : {}),
});

describe("replayEvents (M4-08)", () => {
  // Main → outer (spawned by the main agent) → inner (spawned by outer), plus a side agent with no spawn call.
  const main = [
    at(msg("user", "u1", "Check the date"), 0),
    at(msg("assistant", "a1", [spawn("sp-outer", "Outer")]), 1),
    at(msg("user", "u2", [result("sp-outer", "hand-back")]), 9),
    at(msg("assistant", "a2", [{ type: "text", text: "Done." }]), 10),
  ];
  const outer = [
    at(msg("user", "o1", "Do Outer", "sp-outer"), 2),
    at(msg("assistant", "o2", [spawn("sp-inner", "Inner")], "sp-outer"), 3),
    at(msg("user", "o3", [result("sp-inner", "inner hand-back")], "sp-outer"), 7),
    at(msg("assistant", "o4", [{ type: "text", text: "Outer report" }], "sp-outer"), 8),
  ];
  const inner = [
    at(msg("user", "i1", "Do Inner", "sp-inner"), 4),
    at(
      msg(
        "assistant",
        "i2",
        [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "date" } }],
        "sp-inner",
      ),
      5,
    ),
    at(msg("user", "i3", [result("bash-1", "Sun Nov 1")], "sp-inner"), 6),
    at(msg("assistant", "i4", [{ type: "text", text: "Inner report" }], "sp-inner"), 6),
  ];
  const side = [
    at(msg("user", "x1", "Suggest a prompt"), 11),
    at(msg("assistant", "x2", [{ type: "text", text: "…" }]), 11),
  ];

  it("puts each subagent transcript under its spawn call, parents first, and leaves out side agents", () => {
    // Children listed before parents: the order of listSubagents is not the tree's.
    const { events } = replayEvents(
      main,
      new Map([
        ["agent-inner", inner],
        ["side", side],
        ["agent-outer", outer],
      ]),
    );
    const brief = events.map((e) =>
      e.type === "tool.started" || e.type === "tool.completed"
        ? `${e.type} ${e.toolUseId} in ${e.parentToolUseId}`
        : e.type === "agent.text"
          ? `agent.text ${e.parentToolUseId}: ${e.text}`
          : e.type === "agent.completed"
            ? `agent.completed ${e.toolUseId} ${e.taskId} ${e.status}: ${e.summary}`
            : e.type,
    );
    assert.deepEqual(brief, [
      "user.message",
      "tool.started sp-outer in null",
      "tool.completed sp-outer in null",
      "text.delta",
      "tool.started sp-inner in sp-outer",
      "tool.completed sp-inner in sp-outer",
      "agent.text sp-outer: Outer report",
      "agent.completed sp-outer agent-outer completed: Outer report",
      "tool.started bash-1 in sp-inner",
      "tool.completed bash-1 in sp-inner",
      "agent.text sp-inner: Inner report",
      "agent.completed sp-inner agent-inner completed: Inner report",
    ]);
  });

  it("says which model each subagent ran, from its messages (UX-18)", () => {
    const withModel = (m: SessionMessage, model: string): SessionMessage => ({
      ...m,
      message: { ...(m.message as object), model },
    });
    const ran = outer.map((m) => (m.type === "assistant" ? withModel(m, "claude-haiku-5-5") : m));
    const { events } = replayEvents(main, new Map([["agent-outer", ran]]));
    const models = events.flatMap((e) =>
      (e.type === "tool.started" || e.type === "agent.text") && e.parentToolUseId === "sp-outer" ? [e.model] : [],
    );
    assert.deepEqual(models, ["claude-haiku-5-5", "claude-haiku-5-5"]);
    // The main agent's own messages carry none: its model comes with `session.started`.
    assert.ok(
      historyEvents(main.map((m) => withModel(m, "claude-opus-5-5"))).every(
        (e) => e.type !== "tool.started" || e.model === undefined,
      ),
    );
  });

  it("gives every event its message's time, and ends a subagent when its spawn call returned", () => {
    const { events, times } = replayEvents(
      main,
      new Map([
        ["agent-outer", outer],
        ["agent-inner", inner],
      ]),
    );
    assert.equal(times.length, events.length);
    const when = (pred: (e: (typeof events)[number]) => boolean) => times[events.findIndex(pred)];
    assert.equal(
      when((e) => e.type === "tool.started" && e.toolUseId === "sp-outer"),
      T0 + 1000,
    );
    assert.equal(
      when((e) => e.type === "agent.completed" && e.toolUseId === "sp-outer"),
      T0 + 9000,
    );
    assert.equal(
      when((e) => e.type === "agent.completed" && e.toolUseId === "sp-inner"),
      T0 + 7000,
    );
    assert.equal(
      when((e) => e.type === "tool.completed" && e.toolUseId === "bash-1"),
      T0 + 6000,
    );
  });

  it("marks a subagent stopped when it never handed back or was interrupted, and failed on an error result", () => {
    const cut = main.slice(0, 2);
    const { events } = replayEvents(cut, new Map([["agent-outer", outer.slice(0, 2)]]));
    assert.deepEqual(
      events.filter((e) => e.type === "agent.completed").map((e) => e.type === "agent.completed" && e.status),
      ["stopped"],
    );
    const failed = [main[0], main[1], at(msg("user", "u2", [result("sp-outer", "boom", true)]), 9)] as SessionMessage[];
    const { events: e2 } = replayEvents(failed, new Map([["agent-outer", outer.slice(0, 1)]]));
    const status = (list: typeof events) => list.find((e) => e.type === "agent.completed")?.status;
    assert.equal(status(e2), "failed");
    const interrupted = [
      main[0],
      main[1],
      at(msg("user", "u2", [result("sp-outer", "[Request interrupted by user for tool use]", true)]), 9),
    ] as SessionMessage[];
    assert.equal(status(replayEvents(interrupted, new Map([["agent-outer", outer.slice(0, 1)]])).events), "stopped");
  });

  it("has null times when the SDK returns none", () => {
    const { times } = replayEvents([msg("user", "u1", "hi")], new Map());
    assert.deepEqual(times, [null]);
  });
});

describe("toSessionInfo", () => {
  it("prefers the custom title, then the summary, then the first prompt", () => {
    const base = { sessionId: "id", lastModified: 1, summary: "" };
    assert.equal(toSessionInfo({ ...base, customTitle: "Mine", summary: "Sum" }).title, "Mine");
    assert.equal(toSessionInfo({ ...base, summary: "Sum", firstPrompt: "First" }).title, "Sum");
    assert.equal(toSessionInfo({ ...base, firstPrompt: "First" }).title, "First");
    assert.equal(toSessionInfo(base).title, "Untitled session");
  });

  it("only passes on display fields", () => {
    const info = toSessionInfo({
      sessionId: "id",
      lastModified: 2,
      summary: "S",
      cwd: "/somewhere",
      fileSize: 10,
      tag: "wip",
      gitBranch: "main",
    });
    assert.deepEqual(info, { sessionId: "id", title: "S", lastModified: 2, gitBranch: "main", tag: "wip" });
  });
});

describe("retention", () => {
  const fake = (resolveSettings: () => Promise<unknown>) => ({ resolveSettings }) as unknown as AgentSdkModule;

  it("returns only cleanupPeriodDays and where it was set", async () => {
    const sdk = fake(async () => ({
      effective: { cleanupPeriodDays: 90, env: { SECRET: "x" } },
      provenance: { cleanupPeriodDays: { source: "userSettings", path: "/home/me/.claude/settings.json" } },
    }));
    assert.deepEqual(await retention(sdk, "/repo"), { days: 90, source: "userSettings" });
  });

  it("falls back to the documented default", async () => {
    const unset = fake(async () => ({ effective: {}, provenance: {} }));
    assert.deepEqual(await retention(unset, "/repo"), { days: DEFAULT_RETENTION_DAYS, source: "default" });
    const broken = fake(async () => {
      throw new Error("alpha API changed");
    });
    assert.deepEqual(await retention(broken, "/repo"), { days: DEFAULT_RETENTION_DAYS, source: "default" });
  });
});
