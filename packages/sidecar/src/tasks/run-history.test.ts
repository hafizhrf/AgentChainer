import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { GateRun, Task, TaskRun } from "@agentchainer/protocol";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import { newRun } from "./orchestrator.ts";
import { allRuns, lastRoundPassed, summarizeRun, withPastRun } from "./run-history.ts";
import { newTask } from "./service.ts";
import { loadTask, saveTask } from "./store.ts";

after(() => removeFixtureCopies());

const gate = (kind: GateRun["kind"], round: number, exitCode: number | null, timedOut = false): GateRun => ({
  kind,
  command: kind,
  package: ".",
  exitCode,
  timedOut,
  durationMs: 10,
  tail: "",
  round,
  at: "2026-11-03T00:00:00.000Z",
});

function run(over: Partial<TaskRun> = {}): TaskRun {
  return {
    ...newRun(
      { id: "tier-s", version: 1 },
      { permissionMode: "default", model: "haiku", base: null, untrackedAtStart: [] },
      new Date("2026-11-03T01:00:00.000Z"),
    ),
    endedAt: "2026-11-03T01:05:00.000Z",
    costUsd: 0.12,
    ...over,
  };
}

describe("run history (M7)", () => {
  it("judges a run by its last gate round, and says when no gate ran", () => {
    assert.equal(lastRoundPassed({ gates: [] }), null);
    assert.equal(lastRoundPassed({ gates: [gate("test", 0, 1), gate("test", 1, 0), gate("lint", 1, 0)] }), true);
    assert.equal(lastRoundPassed({ gates: [gate("test", 0, 0), gate("lint", 0, 0, true)] }), false, "a timeout fails");
    assert.equal(lastRoundPassed({ gates: [gate("test", 0, null)] }), false, "a gate that didn't start fails");
  });

  it("keeps what metrics need from a run", () => {
    const r = run({ fixRounds: 1, gates: [gate("test", 0, 1), gate("test", 1, 0)] });
    assert.deepEqual(summarizeRun(r, "done"), {
      workflow: { id: "tier-s", version: 1 },
      model: "haiku",
      state: "done",
      costUsd: 0.12,
      gateRounds: 2,
      gatesPassed: true,
      fixRounds: 1,
      startedAt: "2026-11-03T01:00:00.000Z",
      endedAt: "2026-11-03T01:05:00.000Z",
    });
  });

  it("keeps the replaced run when a task runs again, and survives saving", () => {
    const root = copyFixture("sample-app");
    const task: Task = {
      ...newTask(root, "Fix the total"),
      state: "failed",
      run: run({ gates: [gate("test", 0, 1)] }),
    };
    assert.deepEqual(withPastRun({ ...task, run: null }), {}, "a task that never ran has no history");
    const again: Task = { ...task, ...withPastRun(task), state: "done", run: run({ costUsd: 0.2 }) };
    assert.deepEqual(
      again.runs?.map((r) => [r.state, r.gatesPassed, r.costUsd]),
      [["failed", false, 0.12]],
    );
    saveTask(root, again);
    const back = loadTask(root, task.id);
    assert.deepEqual(
      allRuns(back).map((r) => [r.state, r.costUsd]),
      [
        ["failed", 0.12],
        ["done", 0.2],
      ],
    );
    // A third run keeps both earlier ones.
    assert.equal(withPastRun(back).runs?.length, 2);
  });

  it("names each ended run's own evidence report, and keeps whether a schedule started it (M8-05)", () => {
    const root = copyFixture("sample-app");
    const first: Task = { ...newTask(root, "Bump deps"), state: "done", run: run() };
    const second: Task = {
      ...first,
      ...withPastRun(first),
      run: run({
        ...newRun(
          { id: "tier-s", version: 1 },
          { permissionMode: "acceptEdits", base: null, untrackedAtStart: [], scheduled: true },
          new Date("2026-11-04T02:00:00.000Z"),
        ),
        endedAt: undefined,
      }),
    };
    assert.equal(second.run?.trigger, "schedule");
    assert.deepEqual(
      allRuns(second).map((r) => [r.evidence, r.trigger]),
      [
        ["evidence-1.md", undefined],
        [undefined, "schedule"],
      ],
      "a run still going has no report yet",
    );
  });

  it("counts a task from before run history as its one run", () => {
    const root = copyFixture("sample-app");
    const old: Task = { ...newTask(root, "Old"), state: "done", run: run() };
    assert.equal(old.runs, undefined);
    assert.equal(allRuns(old).length, 1);
    assert.equal(allRuns({ ...old, run: null }).length, 0);
  });
});
