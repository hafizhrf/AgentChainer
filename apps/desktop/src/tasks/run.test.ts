import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GateRun, Task } from "@agentchainer/protocol";
import { duration, fromHistory, gateRounds, runBlocker, runsOfEntry, stateLabel, withStepEvent } from "./run.ts";

const gate = (round: number, exitCode = 0): GateRun => ({
  kind: "test",
  command: "npm test",
  package: ".",
  exitCode,
  timedOut: false,
  durationMs: 5,
  tail: "",
  round,
  at: "2026-10-30T00:00:00.000Z",
});

function task(over: Partial<Task> = {}): Task {
  return {
    id: "2026-10-30-0000abcd",
    request: "x",
    state: "ready",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    contract: {
      task: "x",
      objective: "y",
      acceptanceCriteria: [],
      constraints: [],
      outOfScope: [],
      risks: [],
      affectedAreas: [],
      openQuestions: [],
      approvedAt: "2026-10-30T00:00:00.000Z",
    },
    triage: {
      signals: [],
      floor: "S",
      model: null,
      proposed: "S",
      chosen: "S",
      budgetUsd: 1,
      at: "2026-10-30T00:00:00.000Z",
    },
    availableGates: ["test"],
    costUsd: 0,
    run: null,
    ...over,
  };
}

describe("task runs on the page", () => {
  it("says when a task can't run", () => {
    assert.equal(runBlocker(task()), null);
    assert.equal(runBlocker(task({ state: "failed" })), null, "a finished run can run again");
    assert.match(runBlocker(task({ state: "running" })) ?? "", /running/);
    assert.match(runBlocker(task({ state: "interrupted" })) ?? "", /Resume/);
    assert.match(runBlocker(task({ state: "draft" })) ?? "", /Approve/);
    const base = task().triage;
    assert.ok(base);
    assert.match(runBlocker(task({ triage: { ...base, chosen: "L" } })) ?? "", /L tasks run in a later update/);
  });

  it("labels states", () => {
    assert.deepEqual(stateLabel("unverified"), { label: "Not verified", tone: "warn" });
    assert.equal(stateLabel("cancelled").label, "Stopped");
  });

  it("builds a step's transcript from live events and from history", () => {
    let items = withStepEvent({}, "s1", { type: "text.delta", text: "Hel" });
    items = withStepEvent(items, "s1", { type: "text.delta", text: "lo" });
    assert.equal(items.s1?.[0]?.kind, "assistant");
    const history = fromHistory([
      { type: "user.message", messageId: "m", text: "Implement this" },
      { type: "text.delta", text: "Done." },
    ]);
    assert.deepEqual(
      history.map((i) => i.kind),
      ["user", "assistant"],
    );
  });

  it("groups gate runs by round and finds an entry's round", () => {
    const runs = [gate(0, 1), gate(1, 0)];
    assert.equal(gateRounds(runs).length, 2);
    const t = task({
      run: {
        workflow: { id: "tier-s", version: 1 },
        permissionMode: "acceptEdits",
        base: null,
        untrackedAtStart: [],
        startedAt: "2026-10-30T00:00:00.000Z",
        position: 1,
        fixRounds: 1,
        steps: [
          { id: "gates", step: "gates", label: "Gates", kind: "gates", status: "failed", startedAt: "", costUsd: 0 },
          {
            id: "gates-2",
            step: "gates",
            label: "Gates, round 2",
            kind: "gates",
            status: "done",
            startedAt: "",
            costUsd: 0,
          },
        ],
        gates: runs,
        notRun: [],
        costUsd: 0,
      },
    });
    const second = t.run?.steps[1];
    assert.ok(second);
    assert.deepEqual(
      runsOfEntry(t, second).map((g) => g.exitCode),
      [0],
    );
  });

  it("formats durations", () => {
    assert.equal(duration("2026-10-30T00:00:00Z", "2026-10-30T00:00:08Z"), "8 s");
    assert.equal(duration("2026-10-30T00:00:00Z", "2026-10-30T00:03:04Z"), "3 min 4 s");
  });
});
