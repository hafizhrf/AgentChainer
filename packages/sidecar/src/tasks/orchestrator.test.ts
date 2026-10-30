import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GateKind, GateRun, Task } from "@agentchainer/protocol";
import shipped from "./library.json" with { type: "json" };
import { type AgentStep, LibrarySchema, type Workflow } from "./library.ts";
import { type AgentOutcome, newRun, Orchestrator, type Runner, type StepTag } from "./orchestrator.ts";

const library = LibrarySchema.parse(shipped);

function workflowOf(tier: "S" | "M"): Workflow {
  const w = library.workflows[tier];
  if (!w) throw new Error(`the shipped library has no ${tier} workflow`);
  return w;
}

function task(tier: "S" | "M", budgetUsd = 3): Task {
  const workflow = workflowOf(tier);
  return {
    id: "2026-10-30-0000abcd",
    request: "Add a counter",
    state: "running",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    contract: {
      task: "Add a counter",
      objective: "The page has a counter.",
      acceptanceCriteria: [{ id: "c1", text: "Clicking increments", check: "gate:test" }],
      constraints: [],
      outOfScope: [],
      risks: [],
      affectedAreas: ["src/counter.ts"],
      openQuestions: [],
      approvedAt: "2026-10-30T00:00:00.000Z",
    },
    triage: {
      signals: [],
      floor: "S",
      model: null,
      proposed: tier,
      chosen: tier,
      budgetUsd,
      at: "2026-10-30T00:00:00.000Z",
    },
    availableGates: ["test"],
    costUsd: 0.01,
    run: newRun(workflow, { permissionMode: "acceptEdits", base: "abc", untrackedAtStart: [] }, new Date(0)),
  };
}

const gate = (kind: GateKind, exitCode: number, round: number): GateRun => ({
  kind,
  command: `pnpm ${kind}`,
  package: ".",
  exitCode,
  timedOut: false,
  durationMs: 10,
  tail: exitCode ? `${kind} failed here` : "ok",
  round,
  at: "2026-10-30T00:00:00.000Z",
});

type Call = { kind: "start" | "followUp" | "gates"; step?: string; prompt?: string; tag?: StepTag };

/** A scripted runner: agent turns succeed unless scripted otherwise; gate rounds follow `gateResults`. */
function fakeRunner(opts: {
  gateResults?: GateRun[][];
  outcomes?: Record<string, Partial<AgentOutcome>>;
  onStart?: (step: AgentStep) => void;
}) {
  const calls: Call[] = [];
  let gateRound = 0;
  let stopped = false;
  const outcome = (step: AgentStep, kind: string): AgentOutcome => ({
    sessionId: `session-${step.id}`,
    ok: true,
    subtype: "success",
    text: step.output === "plan" ? "## Approach\nAdd src/counter.ts." : "## Changes\n- src/counter.ts: added",
    costUsd: 0.1,
    ...opts.outcomes?.[`${kind}:${step.id}`],
  });
  const runner: Runner = {
    async start(step, prompt, _budget, tag) {
      calls.push({ kind: "start", step: step.id, prompt, tag });
      opts.onStart?.(step);
      return outcome(step, "start");
    },
    async followUp(step, _sessionId, prompt, _budget, tag) {
      calls.push({ kind: "followUp", step: step.id, prompt, tag });
      return outcome(step, "followUp");
    },
    async gates(kinds, round) {
      calls.push({ kind: "gates" });
      const runs = opts.gateResults?.[gateRound++] ?? kinds.filter((k) => k === "test").map((k) => gate(k, 0, round));
      return { runs: runs.map((r) => ({ ...r, round })), notRun: kinds.filter((k) => k !== "test") };
    },
    diff: () => "diff --git a/src/counter.ts b/src/counter.ts\n+export const counter = 0;",
    stop: () => {
      stopped = true;
    },
    close: () => undefined,
  };
  return { runner, calls, wasStopped: () => stopped };
}

function orchestrate(t: Task, runner: Runner, resume = false) {
  const files = new Map<string, string>();
  const saves: Task[] = [];
  const o = new Orchestrator(t, {
    workflow: workflowOf(t.triage?.chosen === "M" ? "M" : "S"),
    runner,
    files: { read: (n) => files.get(n) ?? null, write: (n, text) => files.set(n, text) },
    save: (x) => saves.push(x),
    now: () => new Date("2026-10-30T01:00:00.000Z"),
    resume,
  });
  return { o, files, saves };
}

const timeline = (t: Task) => t.run?.steps.map((s) => `${s.id}:${s.status}`);

describe("orchestrator", () => {
  it("runs an S task: implement, then gates that pass, ends done", async () => {
    const { runner, calls } = fakeRunner({});
    const { o, saves } = orchestrate(task("S"), runner);
    const done = await o.run();
    assert.equal(done.state, "done");
    assert.deepEqual(timeline(done), ["implement:done", "gates:done"]);
    assert.match(
      calls[0]?.prompt ?? "",
      /Implement this approved task[\s\S]*c1: Clicking increments \(checked by gate:test\)/,
    );
    assert.deepEqual(calls[0]?.tag, { id: done.id, stepId: "implement", label: "Implement", role: "implementer" });
    assert.equal(Math.round((done.run?.costUsd ?? 0) * 100), 10);
    assert.equal(Math.round(done.costUsd * 100), 11, "the run's spend adds to drafting's");
    assert.deepEqual(done.run?.notRun, ["format", "lint", "typecheck", "build", "smoke"]);
    assert.ok(saves.length > 3, "every change is saved and reported");
  });

  it("sends failing gates back to the implementer, then runs every gate again", async () => {
    const { runner, calls } = fakeRunner({ gateResults: [[gate("lint", 1, 0), gate("test", 0, 0)]] });
    const { o } = orchestrate(task("S"), runner);
    const done = await o.run();
    assert.equal(done.state, "done");
    assert.deepEqual(timeline(done), ["implement:done", "gates:failed", "implement-fix-1:done", "gates-2:done"]);
    const fix = calls.find((c) => c.kind === "followUp");
    assert.match(fix?.prompt ?? "", /lint: `pnpm lint` in \. exited 1[\s\S]*lint failed here/);
    assert.equal(done.run?.fixRounds, 1);
    assert.deepEqual(
      done.run?.gates.map((g) => `${g.kind}:${g.round}:${g.exitCode}`),
      ["lint:0:1", "test:0:0", "test:1:0"],
    );
  });

  it("fails when the gates still fail after the last fix round", async () => {
    const red = [gate("test", 1, 0)];
    const { runner } = fakeRunner({ gateResults: [red, red, red] });
    const { o } = orchestrate(task("S"), runner);
    const done = await o.run();
    assert.equal(done.state, "failed");
    assert.equal(done.run?.outcome, "test still failing after 2 fix rounds.");
    assert.deepEqual(timeline(done), [
      "implement:done",
      "gates:failed",
      "implement-fix-1:done",
      "gates-2:failed",
      "implement-fix-2:done",
      "gates-3:failed",
    ]);
  });

  it("runs an M task: the plan feeds the implementer, a fresh review's must-fix gets a round, then the gates again", async () => {
    const { runner, calls } = fakeRunner({
      outcomes: {
        "start:review": {
          structured: {
            verdict: "changes-requested",
            findings: [
              { severity: "must-fix", file: "src/counter.ts", text: "Reset is missing." },
              { severity: "note", text: "Nice." },
            ],
            criteria: [{ id: "c1", met: "no", why: "no reset" }],
          },
        },
      },
    });
    const { o, files } = orchestrate(task("M"), runner);
    const done = await o.run();
    assert.equal(done.state, "done");
    assert.deepEqual(timeline(done), [
      "plan:done",
      "implement:done",
      "gates:done",
      "review:done",
      "implement-fix-1:done",
      "gates-2:done",
    ]);
    assert.match(files.get("plan.md") ?? "", /Add src\/counter\.ts/);
    const implement = calls.find((c) => c.step === "implement" && c.kind === "start");
    assert.match(implement?.prompt ?? "", /## Plan \(from the plan step\)[\s\S]*Add src\/counter\.ts/);
    const review = calls.find((c) => c.step === "review");
    assert.match(
      review?.prompt ?? "",
      /## Diff since the task started[\s\S]*export const counter[\s\S]*## Gate results[\s\S]*test `pnpm test`/,
    );
    assert.doesNotMatch(review?.prompt ?? "", /## Plan/, "the reviewer doesn't see the plan or the transcript");
    assert.match(calls.find((c) => c.kind === "followUp")?.prompt ?? "", /src\/counter\.ts: Reset is missing/);
    assert.equal(done.run?.steps.find((s) => s.id === "review")?.note, "1 must-fix finding.");
    assert.ok(JSON.parse(files.get("review.json") ?? "{}").findings);
  });

  it("stops before a step the budget can't cover", async () => {
    const { runner, calls } = fakeRunner({});
    const t = task("S", 0.04);
    const { o } = orchestrate(t, runner);
    const done = await o.run();
    assert.equal(done.state, "failed");
    assert.match(done.run?.outcome ?? "", /budget ran out before implement/);
    assert.equal(calls.length, 0);
  });

  it("ends unverified when the workspace has no gates", async () => {
    const { runner } = fakeRunner({ gateResults: [[]] });
    const { o } = orchestrate(task("S"), runner);
    const done = await o.run();
    assert.equal(done.state, "unverified");
    assert.match(done.run?.outcome ?? "", /No gate ran/);
  });

  it("fails when a step stops on its own", async () => {
    const { runner } = fakeRunner({ outcomes: { "start:implement": { ok: false, subtype: "error_max_turns" } } });
    const { o } = orchestrate(task("S"), runner);
    const done = await o.run();
    assert.equal(done.state, "failed");
    assert.equal(done.run?.outcome, "Implement stopped: it used all its turns.");
  });

  it("cancels: stops the runner and ends cancelled", async () => {
    let orchestrator: Orchestrator | undefined;
    const fake = fakeRunner({ onStart: () => orchestrator?.cancel() });
    const { o } = orchestrate(task("S"), fake.runner);
    orchestrator = o;
    const done = await o.run();
    assert.equal(done.state, "cancelled");
    assert.ok(fake.wasStopped());
    assert.deepEqual(timeline(done), ["implement:cancelled"]);
  });

  it("resumes an interrupted run: the step left running is marked, a write step continues its session", async () => {
    const t = task("S");
    if (!t.run) throw new Error("no run");
    t.run.steps = [
      {
        id: "implement",
        step: "implement",
        label: "Implement",
        kind: "agent",
        role: "implementer",
        status: "running",
        sessionId: "session-before",
        startedAt: "2026-10-30T00:00:00.000Z",
        costUsd: 0.2,
      },
    ];
    const { runner, calls } = fakeRunner({});
    const { o } = orchestrate(t, runner, true);
    const done = await o.run();
    assert.equal(done.state, "done");
    assert.deepEqual(timeline(done), ["implement:failed", "implement-2:done", "gates:done"]);
    assert.equal(calls[0]?.kind, "followUp");
    assert.match(calls[0]?.prompt ?? "", /The app stopped/);
  });
});
