import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changesOf, commandOf, finalText, itemCompleted, itemStarted, usageOf } from "./codex-events.ts";

// Frames shaped like the ones spike S8 recorded from `codex app-server` 0.157.0 (paths shortened by hand).
const statusItem = {
  type: "commandExecution",
  id: "exec-1",
  command: `"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command 'git status --short'`,
  commandActions: [{ type: "unknown", command: "git status --short" }],
  status: "completed",
  exitCode: 0,
  aggregatedOutput: "?? hello.txt\n",
};
const pushItem = {
  type: "commandExecution",
  id: "exec-2",
  command: `"powershell.exe" -Command 'git push --force origin main'`,
  commandActions: [{ type: "unknown", command: "git push --force origin main" }],
  status: "declined",
  exitCode: null,
  aggregatedOutput: "",
};
const addItem = {
  type: "fileChange",
  id: "exec-3",
  changes: [{ path: "C:\\w\\hello.txt", kind: { type: "add" }, diff: "hi\n" }],
  status: "completed",
};

describe("Codex app-server items as the app's events (M9-04)", () => {
  it("reads the command without the shell Windows wraps it in", () => {
    assert.equal(commandOf(statusItem), "git status --short");
    // Without commandActions, the wrapper is taken off the command itself.
    assert.equal(commandOf({ command: pushItem.command }), "git push --force origin main");
    assert.equal(commandOf({ command: "ls -la" }), "ls -la");
  });

  it("names commands Bash and new files Write, so the approval rules, the guard and the evidence know them", () => {
    assert.deepEqual(itemStarted(statusItem), [
      {
        type: "tool.started",
        toolUseId: "exec-1",
        name: "Bash",
        input: { command: "git status --short" },
        parentToolUseId: null,
      },
    ]);
    assert.deepEqual(itemStarted(addItem), [
      {
        type: "tool.started",
        toolUseId: "exec-3",
        name: "Write",
        input: { file_path: "C:\\w\\hello.txt" },
        parentToolUseId: null,
      },
    ]);
    assert.deepEqual(itemStarted({ type: "reasoning", id: "r" }), []);
  });

  it("gives each changed file its own call, an edit for anything but a new file", () => {
    const two = {
      type: "fileChange",
      id: "exec-4",
      changes: [
        { path: "a.ts", kind: { type: "update", move_path: null } },
        { path: "b.ts", kind: { type: "delete" } },
      ],
      status: "completed",
    };
    assert.deepEqual(changesOf(two), [
      { path: "a.ts", kind: "update" },
      { path: "b.ts", kind: "delete" },
    ]);
    assert.deepEqual(
      itemStarted(two).map((e) => (e.type === "tool.started" ? [e.toolUseId, e.name] : [])),
      [
        ["exec-4:0", "Edit"],
        ["exec-4:1", "Edit"],
      ],
    );
  });

  it("ends a declined or failing command as an error, and a passing one with its output", () => {
    assert.deepEqual(itemCompleted(statusItem), [
      { type: "tool.completed", toolUseId: "exec-1", isError: false, output: "?? hello.txt\n", parentToolUseId: null },
    ]);
    assert.deepEqual(itemCompleted(pushItem), [
      { type: "tool.completed", toolUseId: "exec-2", isError: true, output: "Declined.", parentToolUseId: null },
    ]);
    const failed = { ...statusItem, exitCode: 2, aggregatedOutput: "" };
    const [ended] = itemCompleted(failed);
    assert.equal(ended?.type === "tool.completed" && ended.isError, true);
  });

  it("takes the turn's answer from its last agent message, and the tokens from the usage notice", () => {
    assert.equal(
      finalText([
        { type: "agentMessage", text: "Working on it." },
        { type: "reasoning" },
        { type: "agentMessage", text: "Created hello.txt." },
      ]),
      "Created hello.txt.",
    );
    const usage = usageOf({
      tokenUsage: {
        total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 9, reasoningOutputTokens: 2, totalTokens: 111 },
        last: { inputTokens: 40, cachedInputTokens: 30, outputTokens: 4, reasoningOutputTokens: 0, totalTokens: 44 },
      },
    });
    assert.deepEqual(usage?.last, {
      inputTokens: 40,
      cachedInputTokens: 30,
      outputTokens: 4,
      reasoningOutputTokens: 0,
    });
    assert.equal(usageOf({}), null);
  });
});
