import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Schedule, Task } from "@agentchainer/protocol";
import { lastRunText, nextTimes, scheduledRunEnded, whenText } from "./schedules.ts";

const now = new Date(2026, 10, 3, 22, 0);
const schedule = (lastRun?: Schedule["lastRun"]): Schedule => ({
  id: "abc",
  cwd: "/w",
  taskId: "2026-11-03-0000aaaa",
  title: "Bump deps",
  cadence: { kind: "daily", at: "02:00" },
  enabled: true,
  createdAt: now.toISOString(),
  nextAt: now.toISOString(),
  ...(lastRun ? { lastRun } : {}),
});

describe("scheduled flows in the UI (M8-05)", () => {
  it("says when, near now", () => {
    assert.equal(whenText(new Date(2026, 10, 3, 23, 5), now), "today 23:05");
    assert.equal(whenText(new Date(2026, 10, 4, 2, 0), now), "tomorrow 02:00");
    assert.equal(whenText(new Date(2026, 10, 2, 2, 0), now), "yesterday 02:00");
    assert.equal(whenText(new Date(2026, 10, 6, 2, 0), now), "Fri 02:00");
  });

  it("previews a cadence's next three times", () => {
    assert.deepEqual(
      nextTimes({ kind: "daily", at: "02:00" }, 3, now).map((t) => whenText(t, now)),
      ["tomorrow 02:00", "Thu 02:00", "Fri 02:00"],
    );
  });

  it("says how the last run went", () => {
    const at = new Date(2026, 10, 3, 2, 0).toISOString();
    assert.equal(lastRunText(schedule(), now), "Hasn't run yet");
    assert.equal(lastRunText(schedule({ at, state: "started", late: true }), now), "Ran today 02:00, late");
    assert.equal(
      lastRunText(schedule({ at, state: "skipped", late: false }), now),
      "Skipped today 02:00: the task was still running",
    );
    assert.equal(
      lastRunText(schedule({ at, state: "failed-to-start", late: false, reason: "Approve it first." }), now),
      "Couldn't run today 02:00: Approve it first.",
    );
  });

  it("tells a scheduled run's end once, and nothing for a run a person started", () => {
    const task = (state: Task["state"], trigger?: "schedule") =>
      ({
        id: "t",
        request: "Bump deps",
        state,
        run: { costUsd: 0.04, outcome: "All gates passed.", ...(trigger ? { trigger } : {}) },
      }) as unknown as Task;
    assert.deepEqual(scheduledRunEnded("running", task("done", "schedule")), {
      title: "Scheduled run done",
      body: "Bump deps: All gates passed. (≈$0.04)",
    });
    assert.equal(scheduledRunEnded("done", task("done", "schedule")), null, "already told");
    assert.equal(scheduledRunEnded("running", task("running", "schedule")), null);
    assert.equal(scheduledRunEnded("running", task("done")), null, "a person's run");
  });
});
