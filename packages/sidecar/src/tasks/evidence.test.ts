import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type GateRun, resultText, type StepRun, setLanguage, type Task } from "@agentchainer/protocol";
import { buildEvidence, type Evidence, notScanned, purposes, renderEvidence, sectionLines } from "./evidence.ts";
import { result } from "./result.ts";

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

/** `evidence()`'s report as `evidence.md` had it before X-13 part 2b: files and pull requests keep it. */
const ENGLISH = [
  "# Task evidence: Totals count quantity.",
  "",
  "- **Request:** Fix total()",
  "- **Tier:** M (proposed S; changed because: touches tests), budget $3",
  "- **Contract approved:** 2026-10-30T00:00:00.000Z",
  "- **Workflow:** tier-m v1, the app's",
  "- **Outcome:** **Done.** Every gate passed after the last change.",
  "",
  "## Changed files",
  "",
  "| File | Change | + | − | Purpose (from the implementer) |",
  "|---|---|---|---|---|",
  "| `src/cart.js` | modified | 1 | 1 | total() multiplies price by quantity |",
  "| `test/cart.test.js` | modified | 8 | 0 | covers quantities above 1 |",
  "| `src/extra.js` | new | 3 | 0 | no explanation |",
  "",
  "## Gates",
  "",
  "Run by AgentChainer, with the commands' real exit codes.",
  "",
  "| When | Gate | Command | Package | Result | Time |",
  "|---|---|---|---|---|---|",
  "| before the task | test | `npm run test` | root | exit 1 | 1.2 s |",
  "| round 1 | test | `npm run test` | root | exit 1 | 1.2 s |",
  "| round 2 | test | `npm run test` | root | exit 0 | 1.2 s |",
  "",
  "Not run, no command detected: lint, format. They don't count as passed.",
  "",
  "Already failing before the task: test.",
  "",
  "Failing before the task and passing now: test.",
  "",
  "**test log, before the task** (`npm run test`):",
  "",
  "```",
  "test broke",
  "```",
  "",
  "**test log, round 1** (`npm run test`):",
  "",
  "```",
  "test broke",
  "```",
  "",
  "## Acceptance criteria",
  "",
  "- **c1** total multiplies: _proved by a gate._ test passed in round 2, after the last change.",
  "- **c2** lint is clean: _not checked._ lint has no command in this workspace.",
  "- **c3** doc comment matches: _met (reviewer)._ Reviewer: The comment matches.",
  "- **c4** the page looks right: _manual._ Manual: not checked by AgentChainer.",
  "",
  "## Review",
  "",
  "Verdict: **approve**.",
  "",
  "- note: Fine.",
  "",
  "## Security notes",
  "",
  "The guard blocked nothing.",
  "",
  "Approvals the agents asked for, riskiest first:",
  "- high risk · Bash `git push` (Implement): denied",
  "- low risk · Edit `src/cart.js` (Implement): allowed once",
  "Calls your settings or the permission profile allowed without asking aren't listed.",
  "",
  "Secrets scan: not run (gitleaks isn't installed).",
  "",
  "## Remaining risks and manual steps",
  "",
  "- From the contract: Callers may double-count",
  "- Claude says: Items without a quantity now give NaN.",
  "- Check by hand: the page looks right",
  "",
  "## Cost and time",
  "",
  "| Step | Agent | Time | Cost |",
  "|---|---|---|---|",
  "| Implement | – | 30 s | ≈$0.15 |",
  "",
  "Run ≈$0.18; with drafting and triage ≈$0.20. Estimates.",
  "",
  "_Generated by AgentChainer at 2026-10-30T02:00:00.000Z from the task's records._",
  "",
].join("\n");

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

  it("matches another folder's files, named with or without the folder (M8-01)", () => {
    const summary = "## Changes\n- `api:routes.js`: adds ready()\n- routes.test.js: tests it\n- README.md: mentions it";
    const e = buildEvidence({
      task: task(),
      files: [
        { path: "README.md", status: "modified", added: 1, removed: 0 },
        { path: "api:routes.js", status: "modified", added: 3, removed: 0 },
        { path: "api:routes.test.js", status: "modified", added: 2, removed: 0 },
      ],
      summary,
      review: null,
      secrets: { ran: false, why: "gitleaks isn't installed" },
      now: new Date("2026-11-03T02:00:00.000Z"),
    });
    assert.deepEqual(
      e.files.map((f) => f.purpose),
      ["mentions it", "adds ready()", "tests it"],
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
    assert.match(md, /\| before the task \| test \| `npm run test` \| root \| exit 1 \|/);
    assert.match(md, /\| round 2 \| test \| `npm run test` \| root \| exit 0 \|/);
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

  it("names each step's agent and model, and marks estimated and unknown costs (M9-07)", () => {
    const step = (id: string, over: Partial<StepRun>): StepRun => ({
      id,
      step: id,
      label: id,
      kind: "agent",
      status: "done",
      startedAt: "2026-10-30T00:00:00.000Z",
      endedAt: "2026-10-30T00:00:10.000Z",
      costUsd: 0,
      ...over,
    });
    const md = renderEvidence(
      evidence(
        task({
          steps: [
            step("plan", { agent: "claude", model: "claude-haiku-5-5", costUsd: 0.01 }),
            step("implement", {
              agent: "codex",
              model: "gpt-6-luna",
              costKind: "estimate",
              costUsd: 0.0012,
              tokens: { input: 10000, output: 500 },
            }),
            step("review", {
              agent: "agy",
              model: "gpt-oss-120b-medium",
              costKind: "unknown",
              tokens: { input: 900, output: 100 },
            }),
          ],
        }),
      ),
    );
    assert.match(md, /\| plan \| Claude · claude-haiku-5-5 \| 10 s \| ≈\$0\.0100 \|/);
    assert.match(md, /\| implement \| Codex · gpt-6-luna \| 10 s \| ≈\$0\.0012 \(10,500 tokens\) \|/);
    assert.match(md, /\| review \| Antigravity CLI · gpt-oss-120b-medium \| 10 s \| unknown \(1,000 tokens\) \|/);
    assert.match(md, /estimated from their tokens at the model's API price/);
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

  it("lists each Fix as commented round with its comments, files and outcome (CP-05)", () => {
    const feedback = [
      { at: "2026-11-11T01:00:00.000Z", comments: 1, files: ["src/cart.js"], state: "done" as const },
      {
        at: "2026-11-11T02:00:00.000Z",
        comments: 3,
        files: ["src/cart.js", "api:README.md"],
        state: "failed" as const,
      },
    ];
    const md = renderEvidence(evidence(task({ feedback })));
    assert.match(md, /## Fix as commented\n\n- Round 1: 1 comment on `src\/cart\.js`: done\./);
    assert.match(md, /- Round 2: 3 comments on `src\/cart\.js`, `api:README\.md`: failed\./);
    assert.doesNotMatch(renderEvidence(evidence()), /Fix as commented/);
  });
});

/** Every ref a report can have, which a report written before X-13 part 2b lacks. */
const withoutRefs = (e: Evidence): Evidence =>
  JSON.parse(JSON.stringify(e), (key, value) => (/^refs?$|Refs?$/.test(key) ? undefined : value));

describe("evidence in the app's language (X-13)", () => {
  it("writes evidence.md in English exactly as before", () => {
    assert.equal(renderEvidence(evidence()), ENGLISH);
  });

  it("shows the report in the app's language, while files and pull requests keep English", async () => {
    const e = buildEvidence({
      task: task(),
      files: [{ path: "src/cart.js", status: "modified", added: 1, removed: 1 }],
      summary: SUMMARY,
      review: null,
      secrets: notScanned(result("evidence.scan.notInstalled", { tool: "gitleaks" })),
      now: new Date("2026-10-30T02:00:00.000Z"),
    });
    const english = renderEvidence(e);
    await setLanguage("id");
    try {
      const shown = renderEvidence(e, resultText);
      assert.equal(renderEvidence(e), english, "the English rendering doesn't follow the app's language");
      // Only data is left as it was: table rules, the log's fence and output.
      const kept = english.split("\n").filter((l) => l.trim() && shown.split("\n").includes(l));
      assert.deepEqual(
        [...new Set(kept)],
        ["|---|---|---|---|---|", "|---|---|---|---|---|---|", "```", "test broke", "|---|---|---|---|"],
      );
      for (const heading of ["## Changed files", "## Gates", "## Review", "## Security notes", "## Cost and time"]) {
        assert.ok(!shown.includes(heading), heading);
      }
      assert.match(shown, /^# Bukti task: Totals count quantity\.$/m);
      // The run's outcome has no ref here, so it stays as written; its state is the app's word.
      assert.match(shown, /- \*\*Hasil:\*\* \*\*Selesai\.\*\* Every gate passed after the last change\./);
      assert.match(
        shown,
        /- \*\*c2\*\* lint is clean: _tidak diperiksa\._ lint tidak punya perintah di workspace ini\./,
      );
      assert.match(shown, /Tinjauan independen tidak dijalankan/);
      assert.match(shown, /Pemindaian secret: tidak dijalankan \(gitleaks belum terpasang\)\./);
      assert.match(shown, /- Kata Claude: Items without a quantity now give NaN\./, "Claude's words stay Claude's");
    } finally {
      await setLanguage("en");
    }
  });

  it("marks an XL task's approvals and notes with their sub-task, in either language", async () => {
    const t = task();
    const approval = t.run?.approvals[0];
    assert.ok(approval);
    const marked = result("evidence.subtask.labeled", { n: 2, text: approval.label });
    const note = result("evidence.subtask.labeled", { n: 2, text: "Items without a quantity now give NaN." });
    const e = buildEvidence({
      task: t,
      files: [],
      summary: null,
      review: null,
      secrets: { ran: true, scanned: 1, flagged: [] },
      records: { approvals: [{ ...approval, label: marked.text, labelRef: marked.ref }], guardBlocks: [] },
      notes: [note],
      now: new Date("2026-10-30T02:00:00.000Z"),
    });
    assert.deepEqual(e.risks.fromImplementer, ["Sub-task 2: Items without a quantity now give NaN."]);
    const md = renderEvidence(e);
    assert.match(md, /- low risk · Edit `src\/cart\.js` \(Sub-task 2: Implement\): allowed once/);
    assert.match(md, /- Claude says: Sub-task 2: Items without a quantity now give NaN\./);
    assert.match(md, /nothing found in 1 changed file\./);
    await setLanguage("id");
    try {
      const shown = renderEvidence(e, resultText);
      assert.match(shown, /- risiko rendah · Edit `src\/cart\.js` \(Sub-task 2: Implement\): diizinkan sekali/);
      assert.match(shown, /tidak ada temuan di 1 file yang berubah\./);
    } finally {
      await setLanguage("en");
    }
  });

  it("still renders a report written before its prose had refs, as it was stored", async () => {
    const e = evidence();
    const old = withoutRefs(e);
    assert.equal(old.refs, undefined);
    assert.equal(old.criteria[0]?.detailRef, undefined);
    assert.equal(renderEvidence(old), ENGLISH);
    await setLanguage("id");
    try {
      const shown = renderEvidence(old, resultText);
      assert.match(shown, /^## Kriteria penerimaan$/m);
      assert.match(shown, /- \*\*c2\*\* lint is clean: _tidak diperiksa\._ lint has no command in this workspace\./);
    } finally {
      await setLanguage("en");
    }
  });
});
