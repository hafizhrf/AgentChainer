import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeOpen, type OpenTabs, restoredActive, restoredTabs, restoredTasks, snapshot } from "./openTabs.ts";
import { newTab, type Tab } from "./tabs.ts";
import type { TaskTab } from "./tasks/taskTabs.ts";

/** A chat with one message sent. */
function chat(sessionId: string, over: Partial<Tab> = {}): Tab {
  const tab = newTab(sessionId, "/w/app", { title: `Chat ${sessionId}`, mode: "default", modelAlias: "haiku" });
  return { ...tab, items: [{ kind: "user", id: 1, text: "hi" }], ...over };
}

const task: TaskTab = {
  id: "t1",
  cwd: "/w/app",
  title: "Coupons",
  state: "running",
  busy: true,
  autoDraft: false,
  model: "sonnet",
};

describe("the open tabs, kept across a restart (CP-09)", () => {
  it("remembers chats and tasks, with what resuming needs, and whether a turn was running", () => {
    const tabs = [
      chat("a", { agent: "codex", folders: ["/w/api"], profile: "reviewer", kind: "task" }),
      chat("b", { running: true }),
      chat("c", { background: [{ taskId: "x", kind: "agent", description: "Explore" }] }),
      newTab("fresh", "/w/app", { title: "New chat", mode: "default" }),
      chat("worker", { parentId: "b", access: "read" }),
    ];
    const saved = snapshot(tabs, [task], "b");
    assert.equal(saved.active, "b");
    assert.deepEqual(
      saved.chats.map((c) => [c.sessionId, c.wasRunning]),
      [
        ["a", false],
        ["b", true],
        ["c", true],
      ],
      "nothing sent and Team workers are left out",
    );
    assert.deepEqual(saved.chats[0], {
      sessionId: "a",
      cwd: "/w/app",
      title: "Chat a",
      agent: "codex",
      folders: ["/w/api"],
      profile: "reviewer",
      modelAlias: "haiku",
      kind: "task",
      wasRunning: false,
    });
    assert.deepEqual(saved.tasks, [{ id: "t1", cwd: "/w/app", title: "Coupons", model: "sonnet" }]);
    assert.equal(snapshot([], [], null).active, undefined);
  });

  it("brings chats back ended until they're shown, cut off if their turn was running", () => {
    const saved: OpenTabs = {
      version: 1,
      chats: [
        {
          sessionId: "a",
          cwd: "/w/app",
          title: "Fix",
          modelAlias: "haiku",
          agent: "agy",
          kind: "task",
          wasRunning: true,
        },
        { sessionId: "b", cwd: "/w/app", title: "", modelAlias: "", wasRunning: false },
      ],
      tasks: [{ id: "t1", cwd: "/w/app", title: "Coupons", model: "sonnet" }],
    };
    const [a, b] = restoredTabs(saved, "acceptEdits");
    assert.ok(a && b);
    assert.equal(a.ended, true);
    assert.equal(a.restored, true);
    assert.equal(a.cutOff, true);
    assert.equal(a.agent, "agy");
    assert.equal(a.kind, "task");
    assert.equal(a.modelAlias, "haiku");
    assert.equal(a.mode, "acceptEdits");
    assert.equal(a.cost.totalUsd, null, "a resumed chat's earlier cost is unknown");
    assert.equal(b.cutOff, undefined);
    assert.notEqual(b.title, "", "an empty title gets the placeholder");
    const [t1] = restoredTasks(saved);
    assert.equal(t1?.autoDraft, false, "a reopened task never drafts on its own");
    assert.equal(t1?.model, "sonnet");
  });

  it("shows the tab that was shown if it came back, else Home", () => {
    const saved: OpenTabs = {
      version: 1,
      chats: [{ sessionId: "a", cwd: "/w", title: "A", modelAlias: "", wasRunning: false }],
      tasks: [{ id: "t1", cwd: "/w", title: "T", model: "" }],
    };
    assert.equal(restoredActive({ ...saved, active: "a" }, []), "a");
    assert.equal(restoredActive({ ...saved, active: "task:t1" }, []), "task:t1");
    assert.equal(restoredActive({ ...saved, active: "fleet" }, ["fleet"]), "fleet");
    assert.equal(restoredActive({ ...saved, active: "gone" }, ["fleet"]), null);
    assert.equal(restoredActive(saved, ["fleet"]), null);
  });

  it("keeps a tab already open over the one from last time", () => {
    const merged = mergeOpen(
      [{ id: "a", live: true }],
      [
        { id: "a", live: false },
        { id: "b", live: false },
      ],
      (x) => x.id,
    );
    assert.deepEqual(merged, [
      { id: "a", live: true },
      { id: "b", live: false },
    ]);
  });
});
