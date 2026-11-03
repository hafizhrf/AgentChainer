import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  effortFromArg,
  latestTodos,
  mention,
  modeFromArg,
  modelFromArg,
  nextMode,
  parseAppCommand,
  sentMessages,
  slashMenu,
} from "./commands.ts";
import { answeredInput, questionsOf } from "./questions.ts";
import { newTab, tabEvent } from "./tabs.ts";
import { applyEvent, type Item } from "./transcript.ts";

const session = [
  { name: "compact", description: "Summarize the conversation", argumentHint: "<instructions>" },
  { name: "usage", description: "Show usage", argumentHint: "", aliases: ["stats"] },
  { name: "model", description: "The CLI's model picker", argumentHint: "" },
];

describe("the slash menu (UX-12)", () => {
  it("lists the app's commands first, then the session's, without the session's copy of an app command", () => {
    const all = slashMenu(session, "");
    assert.deepEqual(
      all.map((c) => [c.name, c.app]),
      [
        ["clear", true],
        ["model", true],
        ["mode", true],
        ["effort", true],
        ["cost", true],
        ["fork", true],
        ["help", true],
        ["compact", false],
        ["usage", false],
      ],
    );
  });

  it("matches names and aliases, once per command", () => {
    assert.deepEqual(
      slashMenu(session, "comp").map((c) => c.name),
      ["compact"],
    );
    assert.deepEqual(
      slashMenu(session, "stats").map((c) => c.name),
      ["usage"],
    );
  });

  it("runs only the app's commands in the app, with their argument", () => {
    assert.deepEqual(parseAppCommand("/model  sonnet "), { name: "model", arg: "sonnet" });
    assert.deepEqual(parseAppCommand("/clear"), { name: "clear", arg: "" });
    assert.equal(parseAppCommand("/compact keep the plan"), null);
    assert.equal(parseAppCommand("please /clear this"), null);
  });

  it("reads modes, models and efforts by name", () => {
    assert.equal(modeFromArg("plan"), "plan");
    assert.equal(modeFromArg("Plan first"), "plan");
    assert.equal(modeFromArg("standard"), "acceptEdits");
    assert.equal(modeFromArg("autonomous"), "auto");
    assert.equal(modeFromArg("yolo"), null);
    assert.equal(modelFromArg("Sonnet"), "sonnet");
    assert.equal(modelFromArg("default"), "");
    assert.equal(modelFromArg("gpt"), null);
    assert.equal(effortFromArg("high"), "high");
    assert.equal(effortFromArg("default"), null);
    assert.equal(effortFromArg("max-ish"), undefined);
  });
});

describe("Shift+Tab and history (UX-12)", () => {
  it("cycles Safe → Standard → Plan first, and Autonomous only with a budget cap", () => {
    assert.equal(nextMode("default", false), "acceptEdits");
    assert.equal(nextMode("acceptEdits", false), "plan");
    assert.equal(nextMode("plan", false), "default");
    assert.equal(nextMode("plan", true), "auto");
    assert.equal(nextMode("auto", true), "default");
    assert.equal(nextMode("auto", false), "default");
  });

  it("lists the sent messages oldest first, without repeats in a row", () => {
    const items: Item[] = [
      { kind: "user", id: 1, text: "one" },
      { kind: "assistant", id: 2, text: "ok", open: false },
      { kind: "user", id: 3, text: "two" },
      { kind: "user", id: 4, text: "two" },
    ];
    assert.deepEqual(sentMessages(items), ["one", "two"]);
  });
});

describe("todos, questions and compaction (UX-12)", () => {
  it("reads the latest TodoWrite", () => {
    const todo = (id: string, todos: unknown): Item => ({
      kind: "tool",
      id,
      name: "TodoWrite",
      input: { todos },
      status: "done",
    });
    assert.equal(latestTodos([]), null);
    assert.deepEqual(
      latestTodos([
        todo("a", [{ content: "old", status: "pending" }]),
        todo("b", [
          { content: "Read", status: "completed" },
          { content: "Fix", status: "in_progress", activeForm: "Fixing" },
          { content: 3, status: "pending" },
        ]),
      ]),
      [
        { content: "Read", status: "completed" },
        { content: "Fix", status: "in_progress", activeForm: "Fixing" },
      ],
    );
  });

  it("answers every question by its text, joining several picks, and waits for all of them", () => {
    const input = {
      questions: [
        { question: "Which rounding?", header: "Rounding", options: [{ label: "Half up" }, { label: "Banker's" }] },
        { question: "Which files?", multiSelect: true, options: [{ label: "cart" }, { label: "tax" }] },
      ],
    };
    const qs = questionsOf(input);
    assert.deepEqual(
      qs.map((q) => [q.question, q.multiSelect, q.options.length]),
      [
        ["Which rounding?", false, 2],
        ["Which files?", true, 2],
      ],
    );
    assert.equal(answeredInput(input, qs, { 0: { picked: ["Half up"], other: "" } }), null);
    assert.deepEqual(
      answeredInput(input, qs, {
        0: { picked: [], other: " half even " },
        1: { picked: ["cart", "tax"], other: "" },
      }),
      { ...input, answers: { "Which rounding?": "half even", "Which files?": "cart, tax" } },
    );
  });

  it("marks a compaction in the transcript", () => {
    const items = applyEvent([], {
      type: "context.compacted",
      trigger: "manual",
      preTokens: 150_400,
      postTokens: 9_800,
    });
    assert.equal(items[0]?.kind, "divider");
    assert.equal(
      items[0]?.kind === "divider" && items[0].text,
      "Earlier messages summarized by /compact (150k → 10k tokens)",
    );
  });
});

describe("a tab's commands, context and plan switch (UX-12)", () => {
  const started = (permissionMode: string, slashCommands?: string[]) =>
    ({
      type: "session.started",
      sessionId: "s",
      model: "m",
      cwd: "/w",
      claudeCodeVersion: "2",
      permissionMode,
      ...(slashCommands ? { slashCommands } : {}),
    }) as const;

  it("keeps the described commands over the init's names", () => {
    let t = newTab("s", "/w", { title: "t", mode: "default" });
    t = tabEvent(t, started("default", ["compact"]));
    assert.deepEqual(t.slashCommands, [{ name: "compact", description: "", argumentHint: "" }]);
    t = tabEvent(t, { type: "commands.changed", commands: [session[0] as (typeof session)[0]] });
    t = tabEvent(t, started("default", ["compact", "other"]));
    assert.deepEqual(t.slashCommands, [session[0]]);
  });

  it("records the context use", () => {
    const t = tabEvent(newTab("s", "/w", { title: "t", mode: "default" }), {
      type: "context.usage",
      percentage: 81,
      totalTokens: 162_000,
      maxTokens: 200_000,
    });
    assert.deepEqual(t.context, { percentage: 81, totalTokens: 162_000, maxTokens: 200_000 });
  });

  it("switches to plan mode when Claude enters it, and forgets the switch once a turn starts outside plan", () => {
    let t = newTab("s", "/w", { title: "t", mode: "acceptEdits" });
    const enter = {
      type: "tool.started",
      toolUseId: "p",
      name: "EnterPlanMode",
      input: {},
      parentToolUseId: null,
    } as const;
    t = tabEvent(t, enter);
    assert.deepEqual([t.mode, t.planSwitch], ["plan", { previous: "acceptEdits" }]);
    assert.deepEqual(tabEvent(t, started("plan")).planSwitch, { previous: "acceptEdits" });
    assert.equal(tabEvent(t, started("default")).planSwitch, null);
    const sub = tabEvent(newTab("s", "/w", { title: "t", mode: "default" }), { ...enter, parentToolUseId: "agent" });
    assert.deepEqual([sub.mode, sub.planSwitch], ["default", null], "a subagent's plan mode isn't the session's");
  });
});

describe("attachments as mentions (UX-12)", () => {
  it("names a file in the workspace by its relative path, and others by their full path", () => {
    assert.equal(mention("C:\\work\\app", "C:\\work\\app\\src\\a.ts"), "@src/a.ts");
    assert.equal(mention("/work/app/", "/work/app/docs/My Notes.md"), '@"docs/My Notes.md"');
    assert.equal(mention("/work/app", "/work/application/x.png"), "@/work/application/x.png");
  });
});
