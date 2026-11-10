import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveResume } from "./live-resume.ts";

describe("resuming a session that's still running (M1-36)", () => {
  it("starts one that isn't running", () => {
    assert.deepEqual(liveResume(undefined), { kind: "start" });
  });

  it("hands a running chat back to the tab that asks, e.g. after the window reloaded", () => {
    assert.deepEqual(liveResume({}), { kind: "attach" });
  });

  it("leaves a task's step and a Team worker to whoever runs them", () => {
    const tag = { id: "2026-11-10-abc", cwd: "/w", stepId: "implement", label: "Implement", title: "Fix the cart" };
    assert.deepEqual(liveResume({ tag }), { kind: "busy", task: "Fix the cart" });
    const { title: _, ...untitled } = tag;
    assert.deepEqual(liveResume({ tag: untitled }), { kind: "busy", task: "2026-11-10-abc" });
    assert.deepEqual(liveResume({ parentId: "sup-1" }), { kind: "busy", supervisor: "sup-1" });
  });
});
