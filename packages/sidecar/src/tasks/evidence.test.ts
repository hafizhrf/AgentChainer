import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GateRun, Task } from "@agentchainer/protocol";
import { buildEvidence, purposes, renderEvidence, sectionLines } from "./evidence.ts";

const gate = (kind: GateRun["kind"], exitCode: number, round: number): GateRun => ({
  kind,
  command: `npm run ${kind}`,
  package: ".",
  exitCode,
  timedOut: false,
  durationMs: 1200,
  tail: exitCode ? `${kind} broke` : "ok",
  round,
  at: "2026-10-30T00:00:00.000Z",
});

const SUMMARY = `Done.

## Changes
- src/cart.js: total() multiplies price by quantity
- \`test/cart.test.js\`: covers quantities above 1

## Notes
- Items without a quantity now give NaN.
`;

function task(over: Partial<NonNullable<Task["run"]>> = {}): Task {
  return {
    id: "2026-10-30-0000abcd",
    request: "Fix total()",
    state: "done",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    contract: {
      task: "Fix total()",
      objective: "Totals count quantity.",
      acceptanceCriteria: [
        { id: "c1", text: "total multiplies", check: "gate:test" },
        { id: "c2", text: "lint is clean", check: "gate:lint" },
        { id: "c3", text: "doc comment matches", check: "review" },
        { id: "c4", text: "the page looks right", check: "manual" },
      ],
      constraints: [],
      outOfScope: [],
      risks: ["Callers may double-count"],
      affectedAreas: ["src/cart.js"],
      openQuestions: [],
      approvedAt: "2026-10-30T00:00:00.000Z",
    },
    triage: {
      signals: [],
      floor: "S",
      model: null,
      proposed: "S",
      chosen: "M",
      override: { reason: "touches tests" },
      budgetUsd: 3,
      at: "2026-10-30T00:00:00.000Z",
    },
    availableGates: ["test"],
    costUsd: 0.2,
    run: {
      workflow: { id: "tier-m", version: 1 },
      permissionMode: "default",
      base: "abc",
      untrackedAtStart: [],
      startedAt: "2026-10-30T00:00:00.000Z",
      endedAt: "2026-10-30T00:01:00.000Z",
      position: 3,
      fixRounds: 1,
      steps: [
        {
          id: "implement",
          step: "implement",
          label: "Implement",
          kind: "agent",
          status: "done",
          startedAt: "2026-10-30T00:00:00.000Z",
          endedAt: "2026-10-30T00:00:30.000Z",
          costUsd: 0.15,
        },
      ],
      baseline: [gate("test", 1, 0)],
      gates: [gate("test", 1, 0), gate("test", 0, 1)],
      notRun: ["lint", "format"],
      approvals: [
        {
          stepId: "implement",
          label: "Implement",
          tool: "Edit",
          target: "src/cart.js",
          risk: "low",
          reasons: [],
          allowed: true,
          always: false,
          at: "2026-10-30T00:00:01.000Z",
        },
        {
          stepId: "implement",
          label: "Implement",
          tool: "Bash",
          target: "git push",
          risk: "high",
          reasons: ["Pushes"],
          allowed: false,
          always: false,
          at: "2026-10-30T00:00:02.000Z",
        },
      ],
      guardBlocks: [],
      costUsd: 0.18,
      outcome: "Every gate passed after the last change.",
      ...over,
    },
  };
}

const evidence = (t = task(), summary: string | null = SUMMARY) =>
  buildEvidence({
    task: t,
    files: [
      { path: "src/cart.js", status: "modified", added: 1, removed: 1 },
      { path: "test/cart.test.js", status: "modified", added: 8, removed: 0 },
      { path: "src/extra.js", status: "new", added: 3, removed: 0 },
    ],
    summary,
    review: {
      verdict: "approve",
      findings: [{ severity: "note", text: "Fine." }],
      criteria: [{ id: "c3", met: "yes", why: "The comment matches." }],
    },
    secrets: { ran: false, why: "gitleaks isn't installed" },
    now: new Date("2026-10-30T02:00:00.000Z"),
  });

describe("evidence", () => {
  it("reads the implementer's summary sections", () => {
    assert.deepEqual(sectionLines(SUMMARY, "Notes"), ["Items without a quantity now give NaN."]);
    assert.deepEqual(
      [...purposes(SUMMARY).entries()],
      [
        ["src/cart.js", "total() multiplies price by quantity"],
        ["test/cart.test.js", "covers quantities above 1"],
      ],
    );
  });

  it("gives each changed file its purpose, or says it has none", () => {
    const e = evidence();
    assert.deepEqual(
      e.files.map((f) => [f.path, f.purpose]),
      [
        ["src/cart.js", "total() multiplies price by quantity"],
        ["test/cart.test.js", "covers quantities above 1"],
        ["src/extra.js", null],
      ],
    );
    assert.match(renderEvidence(e), /\| `src\/extra\.js` \| new \| 3 \| 0 \| no explanation \|/);
  });

  it("keeps the gate runs exactly as recorded, and marks what failed before the task", () => {
    const t = task();
    const e = evidence(t);
    assert.deepEqual(e.gates.runs, t.run?.gates, "M3-E2: the report's gates are the recorded runs");
    assert.deepEqual(e.gates.baseline, t.run?.baseline);
    assert.deepEqual(e.gates.preexisting, ["test"]);
    assert.deepEqual(e.gates.fixedByTask, ["test"], "failing before, passing now");
    const md = renderEvidence(e);
    assert.match(md, /\| before the task \| test \| `npm run test` \| \. \| exit 1 \|/);
    assert.match(md, /\| round 2 \| test \| `npm run test` \| \. \| exit 0 \|/);
    assert.match(md, /Not run, no command detected: lint, format\. They don't count as passed\./);
    assert.match(md, /\n\nFailing before the task and passing now: test\./, "its own paragraph, not a table row");
    assert.match(md, /\*\*test log, before the task\*\* \(`npm run test`\):\n\n```\ntest broke\n```/);
    assert.doesNotMatch(md, /<details>/, "the app renders the report without raw HTML");
  });

  it("says why there's no review, and when a failed criterion's gate failed before the task too", () => {
    const red = task({ baseline: [gate("test", 1, 0)], gates: [gate("test", 1, 0)] });
    const build = (t: Task) =>
      buildEvidence({
        task: t,
        files: [],
        summary: null,
        review: null,
        secrets: { ran: false, why: "gitleaks isn't installed" },
        now: new Date("2026-10-30T02:00:00.000Z"),
      });
    const e = build(red);
    assert.equal(e.noReview, "The independent review didn't run: the run ended before it.");
    const byId = Object.fromEntries(e.criteria.map((c) => [c.id, c]));
    assert.match(byId.c1?.detail ?? "", /test failed in round 1 \(exit 1\)\. It already failed before the task/);
    assert.equal(byId.c3?.detail, "The independent review didn't run: the run ended before it.");
    const triage = red.triage;
    assert.ok(triage);
    assert.equal(build({ ...red, triage: { ...triage, chosen: "S" } }).noReview, "Tier S has no independent review.");
  });

  it("sums up an XL task's sub-tasks, points at their reports, and names a merge that failed", () => {
    const t = task();
    const xl: Task = {
      ...t,
      triage: t.triage ? { ...t.triage, chosen: "XL" } : null,
      run: t.run
        ? {
            ...t.run,
            steps: [
              ...t.run.steps,
              {
                id: "merge-2",
                step: "merge-2",
                label: "Merge sub-task 2",
                kind: "merge",
                status: "failed",
                note: "Conflicts in src/cart.js.",
                startedAt: "",
                costUsd: 0,
              },
            ],
          }
        : null,
    };
    const e = buildEvidence({
      task: xl,
      files: [],
      summary: null,
      review: null,
      secrets: { ran: false, why: "gitleaks isn't installed" },
      subtasks: [
        {
          number: 1,
          title: "Fix total()",
          tier: "S",
          state: "done",
          costUsd: 0.02,
          outcome: "Every gate passed after the last change.",
          report: ".agentchainer/tasks/2026-10-30-0000000a/evidence.md",
        },
      ],
      now: new Date("2026-10-30T02:00:00.000Z"),
    });
    assert.equal(e.noReview, "XL tasks are reviewed per sub-task: see their reports.");
    const md = renderEvidence(e);
    assert.match(
      md,
      /## Sub-tasks[\s\S]*\| 1 \| Fix total\(\) \| S \| Done: Every gate passed after the last change\. \| ≈\$0\.0200 \| `\.agentchainer\/tasks\/2026-10-30-0000000a\/evidence\.md` \|/,
    );
    assert.match(md, /- Merge sub-task 2: Conflicts in src\/cart\.js\./);
  });

  it("fences a log that contains backticks so it can't break out", () => {
    const t = task({ baseline: [{ ...gate("test", 1, 0), tail: "expected ```x``` got y" }], gates: [] });
    assert.match(renderEvidence(evidence(t)), /\n````\nexpected ```x``` got y\n````/);
  });

  it("checks each criterion by its kind, and never calls an unrun gate proved", () => {
    const byId = Object.fromEntries(evidence().criteria.map((c) => [c.id, c]));
    assert.equal(byId.c1?.status, "proved");
    assert.equal(byId.c2?.status, "not-run");
    assert.match(byId.c2?.detail ?? "", /lint has no command/);
    assert.deepEqual([byId.c3?.status, byId.c3?.detail], ["met", "Reviewer: The comment matches."]);
    assert.deepEqual([byId.c4?.status, byId.c4?.detail], ["manual", "Manual: not checked by AgentChainer."]);
    assert.doesNotMatch(renderEvidence(evidence()), /c2[^\n]*proved/);
  });

  it("lists approvals riskiest first, and says what isn't listed", () => {
    const e = evidence();
    assert.deepEqual(
      e.security.approvals.map((a) => a.risk),
      ["high", "low"],
    );
    const md = renderEvidence(e);
    assert.match(md, /- high risk · Bash `git push` \(Implement\): denied/);
    assert.match(md, /aren't listed/);
    assert.match(md, /Secrets scan: not run \(gitleaks isn't installed\)\./);
    assert.match(md, /The guard blocked nothing\./);
  });

  it("records the tier override, the accepted risk and the implementer's notes as Claude's", () => {
    const md = renderEvidence(
      evidence(task({ acceptance: { reason: "lint is set up next sprint", at: "2026-10-30T03:00:00.000Z" } })),
    );
    assert.match(md, /\*\*Tier:\*\* M \(proposed S; changed because: touches tests\)/);
    assert.match(md, /\*\*Risk accepted\*\* by the user at 2026-10-30T03:00:00\.000Z: lint is set up next sprint/);
    assert.match(md, /- Claude says: Items without a quantity now give NaN\./);
    assert.match(md, /- From the contract: Callers may double-count/);
    assert.match(md, /- Check by hand: the page looks right/);
  });
});
