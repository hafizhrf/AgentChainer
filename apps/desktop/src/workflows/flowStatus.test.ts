import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StepRun, Task, TaskRun } from "@agentchainer/protocol";
import { fixesUsed, flowStates, subtaskGraph } from "./flowStatus.ts";
import { workflowGraph } from "./workflowGraph.ts";

const workflow = {
  id: "tier-m",
  steps: [
    { id: "plan", label: "Plan", role: "architect", access: "read" },
    { id: "implement", label: "Implement", role: "implementer", access: "write" },
    { id: "gates", label: "Gates", gates: ["test"], fix: { step: "implement", maxRounds: 2 } },
    { id: "review", label: "Review", role: "independent-reviewer", access: "read" },
  ],
};

const entry = (id: string, step: string, kind: StepRun["kind"], status: StepRun["status"], costUsd = 0): StepRun => ({
  id,
  step,
  label: id,
  kind,
  status,
  startedAt: "2026-11-03T00:00:00.000Z",
  costUsd,
});

const run = (steps: StepRun[], ended = false) =>
  ({ steps, ...(ended ? { endedAt: "2026-11-03T00:01:00.000Z" } : {}) }) as unknown as TaskRun;

describe("a run on its workflow's canvas (UX-14)", () => {
  const { nodes, edges } = workflowGraph(workflow);
  const byLabel = (states: ReturnType<typeof flowStates>, label: string) =>
    states[nodes.find((n) => n.label === label)?.id ?? ""];

  it("gives each step its latest entry's state, its turns and cost, and leaves the baseline out", () => {
    const states = flowStates(
      nodes,
      run([
        entry("baseline", "gates", "baseline", "failed"),
        entry("plan", "plan", "agent", "done", 0.1),
        entry("implement", "implement", "agent", "done", 0.2),
        entry("gates", "gates", "gates", "failed"),
        entry("implement-fix-1", "implement", "fix", "running", 0.05),
      ]),
    );
    assert.deepEqual(byLabel(states, "Plan"), { status: "done", costUsd: 0.1, entryId: "plan", turns: 1 });
    assert.deepEqual(byLabel(states, "Implement"), {
      status: "running",
      costUsd: 0.25,
      entryId: "implement-fix-1",
      turns: 2,
    });
    assert.equal(byLabel(states, "Gates")?.status, "failed", "the gates step, not the baseline before the task");
    assert.equal(byLabel(states, "Review")?.status, "pending");
  });

  it("marks steps a finished run never reached as not run, and counts fix rounds on the fix edge", () => {
    const finished = run(
      [
        entry("plan", "plan", "agent", "done"),
        entry("implement", "implement", "agent", "failed"),
        entry("implement-fix-1", "implement", "fix", "failed"),
      ],
      true,
    );
    assert.equal(byLabel(flowStates(nodes, finished), "Review")?.status, "skipped");
    const fix = edges.find((e) => e.kind === "fix");
    assert.deepEqual([fix?.maxRounds, fix && fixesUsed(edges, finished)[fix.id]], [2, 1]);
  });

  it("draws nothing as a run before there is one", () => {
    assert.ok(Object.values(flowStates(nodes, null)).every((s) => s.status === "pending"));
  });
});

describe("an XL task's sub-tasks as a graph (UX-14)", () => {
  it("puts each sub-task a row below what it waits for", () => {
    const sub = (id: string, dependsOn: string[] = []) =>
      ({ id, request: id, state: "ready", costUsd: 0, dependsOn, triage: { chosen: "S" } }) as unknown as Task;
    const g = subtaskGraph([sub("a"), sub("b"), sub("c", ["a", "b"]), sub("d", ["c"])]);
    assert.deepEqual(
      g.nodes.map((n) => [n.id, n.y]),
      [
        ["a", 0],
        ["b", 0],
        ["c", 112],
        ["d", 224],
      ],
    );
    assert.deepEqual(
      g.edges.map((e) => e.id),
      ["a->c", "b->c", "c->d"],
    );
  });
});
