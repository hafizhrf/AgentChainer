import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSdkModule } from "./sdk-loader.ts";
import { DEFAULT_RETENTION_DAYS, historyEvents, retention, toSessionInfo } from "./stored-sessions.ts";

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

  it("skips text the user didn't type, like slash-command wrappers", () => {
    const events = historyEvents([
      msg("user", "u1", "<command-name>/clear</command-name>"),
      msg("user", "u2", [
        { type: "text", text: "<local-command-stdout>ok</local-command-stdout>" },
        { type: "text", text: "real prompt" },
      ]),
    ]);
    assert.deepEqual(events, [{ type: "user.message", messageId: "u2", text: "real prompt" }]);
  });

  it("ignores messages without readable content", () => {
    const odd = { ...msg("assistant", "a1", null), message: "not an object" };
    assert.deepEqual(historyEvents([odd, msg("system", "s1", "compacted")]), []);
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
