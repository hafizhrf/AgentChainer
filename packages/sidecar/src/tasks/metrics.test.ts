import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { GateRun, Task, TaskRun } from "@agentchainer/protocol";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import { computeMetrics, loadAllTasks } from "./metrics.ts";
import { newRun } from "./orchestrator.ts";
import { summarizeRun } from "./run-history.ts";
import { newTask } from "./service.ts";
import { saveTask } from "./store.ts";

after(() => removeFixtureCopies());

const root = copyFixture("sample-app");
const base = newTask(root, "base");

const gate = (round: number, exitCode: number): GateRun => ({
  kind: "test",
  command: "npm test",
  package: ".",
  exitCode,
  timedOut: false,
  durationMs: 10,
  tail: "",
  round,
  at: "2026-11-03T00:00:00.000Z",
});

function run(minutes: number, over: Partial<TaskRun> = {}): TaskRun {
  const start = new Date("2026-11-03T01:00:00.000Z");
  return {
    ...newRun({ id: "tier-s", version: 1 }, { permissionMode: "default", base: null, untrackedAtStart: [] }, start),
    endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
    costUsd: 0.1,
    ...over,
  };
}

function task(id: string, over: Partial<Task>): Task {
  return {
    ...base,
    id,
    request: id,
    createdAt: "2026-11-03T00:00:00.000Z",
    triage: { ...(base.triage ?? ({} as NonNullable<Task["triage"]>)), chosen: "S" } as Task["triage"],
    ...over,
  };
}

const ID = (n: number) => `t-20261103-00000${n}`;

describe("local metrics (M7-01)", () => {
  // 1: done at once. 2: failed, ran again, then done. 3: accepted with risk. 4: PR merged with gates not green.
  // 5: no gates ran. 6: drafted, never ran.
  const tasks: Task[] = [
    task(ID(1), { state: "done", costUsd: 0.2, run: run(2, { gates: [gate(0, 0)] }) }),
    task(ID(2), {
      state: "done",
      costUsd: 0.6,
      runs: [summarizeRun(run(10, { gates: [gate(0, 1), gate(1, 1)], fixRounds: 1 }), "failed")],
      run: run(4, { gates: [gate(0, 0)] }),
    }),
    task(ID(3), { state: "accepted", costUsd: 0.3, run: run(6, { gates: [gate(0, 1)] }) }),
    task(ID(4), {
      state: "done",
      costUsd: 0.4,
      run: run(8, {
        gates: [gate(0, 0)],
        workflow: {
          id: "tier-s",
          version: 2,
          source: "project",
          file: ".agentchainer/workflows/s.yaml",
          hash: "abc123",
        },
      }),
      pr: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        branch: "agentchainer/x",
        base: "main",
        draft: false,
        createdAt: "2026-11-03T00:00:00.000Z",
        fixes: [{ check: "ci", at: "2026-11-03T00:00:00.000Z", state: "done" }],
        merged: { method: "squash", at: "2026-11-03T00:00:00.000Z", accepted: "the flaky test" },
      } as unknown as Task["pr"],
    }),
    task(ID(5), { state: "unverified", costUsd: 0.1, run: run(1) }),
    task(ID(6), { state: "draft", costUsd: 0.05, run: null }),
  ];

  it("counts tasks that ran, with failures' costs in the cost per success", () => {
    const m = computeMetrics(tasks);
    assert.equal(m.tasks, 5, "a task that never ran isn't counted");
    assert.equal(m.runs, 6);
    // Successes: 1, 2 (done) and 4 (done); 4's PR merged with gates not green doesn't undo Done.
    assert.equal(m.costUsd.successes, 3);
    assert.equal(Number(m.costUsd.total.toFixed(2)), 1.6);
    assert.equal(Number(m.costUsd.perTask?.toFixed(2)), 0.32);
    assert.equal(Number(m.costUsd.perSuccess?.toFixed(4)), 0.5333);
  });

  it("judges gate passes by each run's last round, and leaves runs without gates out", () => {
    const m = computeMetrics(tasks);
    // Judged runs: 1 pass; 2's first run fail, second pass; 3 fail; 4 pass. 5 has no gates.
    assert.deepEqual([m.gatePass.judged, m.gatePass.unjudged], [5, 1]);
    assert.equal(m.gatePass.rate, 3 / 5);
  });

  it("counts retries and the tasks that needed a person", () => {
    const m = computeMetrics(tasks);
    assert.deepEqual(m.retries, { extraRuns: 1, fixRounds: 1, ciFixes: 1 });
    // 3 accepted with risk; 4 merged with gates not green and had a Fix CI round.
    assert.deepEqual([m.humanFix.tasks, m.humanFix.rate], [2, 2 / 5]);
    assert.deepEqual(
      m.taskList.filter((t) => t.neededPerson).map((t) => t.id),
      [ID(3), ID(4)],
    );
  });

  it("gives run time percentiles and breaks down by tier and by workflow", () => {
    const m = computeMetrics(tasks);
    // Run minutes: 2, 10, 4, 6, 8, 1 → sorted 1, 2, 4, 6, 8, 10.
    assert.deepEqual(m.durationMs, { p50: 4 * 60_000, p90: 10 * 60_000, count: 6 });
    assert.deepEqual(m.byTier, [{ tier: "S", tasks: 5, successes: 3, costUsd: m.costUsd.total }]);
    const project = m.byWorkflow.find((w) => w.key === "tier-s@abc123");
    assert.deepEqual(
      [project?.label, project?.runs, project?.gatePassRate],
      [".agentchainer/workflows/s.yaml (abc123)", 1, 1],
    );
    assert.equal(m.byWorkflow.find((w) => w.key === "tier-s")?.runs, 5);
  });

  it("narrows by date and tier, and returns empty rates for nothing", () => {
    assert.equal(computeMetrics(tasks, { since: "2026-11-04T00:00:00.000Z" }).tasks, 0);
    const none = computeMetrics(tasks, { tier: "L" });
    assert.deepEqual([none.tasks, none.gatePass.rate, none.costUsd.perSuccess, none.durationMs], [0, null, null, null]);
  });

  it("reads the workspace's top-level tasks from disk", () => {
    const ws = copyFixture("sample-app");
    const parent = { ...newTask(ws, "XL"), state: "done" as const, run: run(3) };
    saveTask(ws, parent);
    saveTask(ws, { ...newTask(ws, "child"), parent: { id: parent.id, index: 0 }, run: run(1) });
    assert.deepEqual(
      loadAllTasks(ws).map((t) => t.id),
      [parent.id],
      "sub-tasks count inside their XL task",
    );
  });
});
