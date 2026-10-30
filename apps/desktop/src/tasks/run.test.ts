import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GateRun, Task } from "@agentchainer/protocol";
import {
  canAcceptRisk,
  duration,
  failedBefore,
  fromHistory,
  gateRounds,
  newer,
  runBlocker,
  runsOfEntry,
  stateLabel,
  withStepEvent,
} from "./run.ts";

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
    assert.equal(runBlocker(task({ state: "accepted" })), null);
    assert.match(runBlocker(task({ state: "running" })) ?? "", /running/);
    assert.match(runBlocker(task({ state: "interrupted" })) ?? "", /Resume/);
    assert.match(runBlocker(task({ state: "draft" })) ?? "", /Approve/);
    const base = task().triage;
    assert.ok(base);
    assert.equal(runBlocker(task({ triage: { ...base, chosen: "L" } })), null);
    assert.match(runBlocker(task({ triage: { ...base, chosen: "XL" } })) ?? "", /XL tasks run in a later update/);
  });

  it("labels states", () => {
    assert.deepEqual(stateLabel("unverified"), { label: "Not verified", tone: "warn" });
    assert.equal(stateLabel("cancelled").label, "Stopped");
    assert.deepEqual(stateLabel("accepted"), { label: "Accepted with risk", tone: "warn" });
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

  it("groups gate runs by round and finds an entry's round, the baseline's apart", () => {
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
          {
            id: "baseline",
            step: "baseline",
            label: "Gates before the task",
            kind: "baseline",
            status: "failed",
            startedAt: "",
            costUsd: 0,
          },
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
        baseline: [gate(0, 7)],
        gates: runs,
        notRun: [],
        approvals: [],
        guardBlocks: [],
        costUsd: 0,
      },
    });
    const [before, first, second] = t.run?.steps ?? [];
    assert.ok(before && first && second);
    assert.deepEqual(
      runsOfEntry(t, before).map((g) => g.exitCode),
      [7],
    );
    assert.deepEqual(
      runsOfEntry(t, first).map((g) => g.exitCode),
      [1],
    );
    assert.deepEqual(
      runsOfEntry(t, second).map((g) => g.exitCode),
      [0],
    );
    assert.deepEqual([...failedBefore(t)], ["test:."]);
  });

  it("offers accepting the risk only after a failed or unverified run", () => {
    const run: NonNullable<Task["run"]> = {
      workflow: { id: "tier-s", version: 1 },
      permissionMode: "default",
      base: null,
      untrackedAtStart: [],
      startedAt: "2026-10-30T00:00:00.000Z",
      position: 1,
      fixRounds: 0,
      steps: [],
      baseline: [],
      gates: [],
      notRun: [],
      approvals: [],
      guardBlocks: [],
      costUsd: 0,
    };
    assert.equal(canAcceptRisk(task({ state: "failed", run })), true);
    assert.equal(canAcceptRisk(task({ state: "unverified", run })), true);
    assert.equal(canAcceptRisk(task({ state: "done", run })), false);
    assert.equal(canAcceptRisk(task({ state: "accepted", run })), false, "already accepted");
    assert.equal(canAcceptRisk(task({ state: "failed" })), false, "no run, nothing to accept");
  });

  it("keeps the newest version: a run's notifications can overtake the reply that started it", () => {
    const at = (t: string) => task({ updatedAt: t });
    const started = at("2026-10-30T00:00:01.000Z");
    const stepRunning = at("2026-10-30T00:00:01.005Z");
    assert.equal(newer(stepRunning, started, "reply"), stepRunning, "an older reply doesn't win");
    assert.equal(newer(started, stepRunning, "notification"), stepRunning);
    const same = at("2026-10-30T00:00:01.005Z");
    assert.equal(newer(stepRunning, same, "reply"), stepRunning, "a reply needs to be strictly newer");
    assert.equal(newer(stepRunning, same, "notification"), same);
    assert.equal(newer(null, started, "reply"), started);
    assert.equal(
      newer(at("2026-10-30T00:00:09.000Z"), { ...started, id: "2026-10-30-ffffffff" }, "reply").id,
      "2026-10-30-ffffffff",
    );
  });

  it("formats durations", () => {
    assert.equal(duration("2026-10-30T00:00:00Z", "2026-10-30T00:00:08Z"), "8 s");
    assert.equal(duration("2026-10-30T00:00:00Z", "2026-10-30T00:03:04Z"), "3 min 4 s");
  });
});
