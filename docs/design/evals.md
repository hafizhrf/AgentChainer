# Design: evals and analytics (M7)

- **Status:** Draft, waiting for the owner
- **Date:** 2026-11-02
- **Covers:** M7-01, M7-02, M7-03 and the exit criterion M7-E1. M7-04 (OpenTelemetry) is deferred (§7).
- **Source:** PRD [F8](../PRD.md#f6f9-p2)
- **Builds on:** M3's runs and evidence, M5's pull requests, M6's project workflows ([deploy-and-canvas.md
  §9](deploy-and-canvas.md#9-the-workflow-canvas-m6-04-owner-decision-3)).

## 1. The problem

A task records what it cost, which gates passed and how many fix rounds it took, but nothing adds those up. Nobody
can tell whether a workflow, model or skill change makes tasks pass more often or cost less:
- a user can't see how their tasks go over time, or whether their project's own workflow helps;
- a maintainer changing `catalog/workflows/` or a first-party skill has no number to compare before merging.

## 2. User flow

- **A user:** Workspace settings → **Metrics**. Totals for a time range (7 days, 30 days, all), filtered by tier,
  each with the list of tasks behind it, so a number can be checked against the tasks.
- **A maintainer:** changes a workflow or skill, runs `node packages/sidecar/scripts/benchmark.ts` with the old and
  the new variant on the fixture suite (their own `claude` login, a few dollars at most), and commits the report. CI
  checks that the report covers the changed files; the PR body carries its summary.

## 3. Run history (the prerequisite)

- "Run again" replaces `task.run` (`packages/sidecar/src/tasks/service.ts:507`), so earlier runs, and with them
  the retries, are lost. Only `task.costUsd` keeps adding up.
- A new `task.runs[]` keeps a **summary** of every finished run: the workflow reference (id, version, source and
  hash), model, the state it ended in, cost, the number of gate rounds and fix rounds, and its start and end times.
  The full latest run stays in `task.run`, as now.
- A task from before this change has no `runs`; it counts as one run, read from `task.run`.

## 4. Metrics (M7-01)

Computed in the sidecar from `.agentchainer/tasks/` (`packages/sidecar/src/tasks/store.ts`). `listTasks`
(`store.ts:116`) returns summaries and skips sub-tasks (`store.ts:125`), so metrics load full tasks with their own
reader; an XL task counts once, with its sub-tasks' costs inside it.

| Metric | Definition |
|---|---|
| **Gate pass rate** | Finished runs whose last gate round passed every gate that ran. Runs with no gate don't count either way; their number is shown next to it. |
| **Cost per task** | `task.costUsd` (drafting, triage and every run), averaged over tasks in the range. |
| **Cost per successful task** | The total cost of all tasks divided by the successful ones: Done, or a merged PR that wasn't merged with `accepted`. Failures' costs count, which is the point. |
| **Duration** | Run time from start to end, p50 and p90 (`apps/desktop/src/stats.ts:2`). |
| **Retries** | Runs per task beyond the first, automatic fix rounds (`run.fixRounds`), and Fix CI rounds (`pr.fixes[]`, `packages/protocol/src/index.ts:684`), shown separately. |
| **Human-fix rate** | Tasks that needed a person to finish: accepted with risk (`run.acceptance`, `index.ts:624`), merged with gates not green (`pr.merged.accepted`, `index.ts:707`), or with a Fix CI round. |

- **Not measured:** edits a person made by hand after Done. There's no reliable signal without reading the user's
  later commits; the view says so instead of guessing.
- **Breakdowns:** by tier, and by workflow (the app's, or the project's with its hash), so a project workflow's
  effect shows.
- A new IPC method, `metrics.summary { cwd, from?, tier? }`, returns the numbers and the task ids behind each.
  Nothing leaves the computer (X-04).

## 5. The eval harness (M7-02)

- **A suite:** `packages/sidecar/test/evals/suite.json`, in the shape of the triage benchmark
  (`packages/sidecar/test/triage-benchmark.json`, scored by `scripts/benchmark-triage.ts:106`). Each case has:
  - a fixture, a request, the approved contract and the tier;
  - **acceptance checks**: the fixture's own tests, plus hidden checks the agent never sees, copied into the
    workspace only after the run, then run like a gate.
- **The runner:** `packages/sidecar/scripts/benchmark.ts`.
  - It is factored out of `scripts/live-task.ts` into a library that returns a result instead of printing.
    `live-task.ts` already copies a fixture (`live-task.ts:44`), drives a task over JSON-RPC and answers approvals
    (`live-task.ts:63`).
  - It runs every case for each **variant**:
    - a workflow file, or the app's;
    - a model;
    - a skill version from `catalog/skills/`.
  - As built (step 3): a variant is `name[:model=…,workflows=<dir>,workflows-ref=<git rev>]`. The first-party prompts
    a task runs are the tier workflows and the role prompts in `agents/`; the skills in `skills/` feed the setup
    generators, not task runs, so the task benchmark doesn't vary them. `workflows-ref=origin/main` is the usual
    baseline for a workflow change. The contract is written in the case and triaged, not drafted, so every variant
    starts from the same one.
  - `-n` repeats each case, because a single run is noisy. `--max-usd` caps the whole run and stops it cleanly.
    Haiku is the default unless the variant names a model.
  - Variants run on the same commit of the app, one after another, each on a fresh fixture copy.
- **The report:** `packages/sidecar/test/evals/report.json` and `report.md`.
  - Per variant and case: passes out of N, cost, duration, retries.
  - The delta against the baseline variant, with a simple interval; with a small N the report says the difference
    may be noise rather than claiming it.
  - The sha256 of each workflow and first-party skill a variant ran (§6).
  - **Evidence (M3-E2):** every run that ended is checked against its own evidence report. The report's gate runs must
    be the recorded ones, and the last round's gate commands, run again by hand before the hidden checks are copied
    in, must give the recorded exit codes. The section appears only in reports whose runs were checked, so older
    reports still render as committed.

## 6. The regression check (M7-03, owner decision 1)

- The benchmark runs **locally**, with the maintainer's own `claude` login, like `live-task.ts`. No API key secret
  and no model spend in CI.
- `packages/sidecar/scripts/check-eval-report.ts` runs in CI without model calls. It fails a PR that changes a file
  in `catalog/workflows/` or a first-party skill without a committed report that covers the new file's hash.
- The PR body carries the report's summary table. That is the evidence for **M7-E1**: "a change to a workflow
  template reports its success and cost delta on the benchmark before merge".
- A change that isn't meant to change behavior (a comment, a typo) still needs a report. Re-running the benchmark is
  cheap (§5); the check doesn't try to tell harmless changes apart.
- **As built (step 4):** the check covers the tier workflows and the role prompts in `agents/`, the files a task run
  reads (§5). It compares their sha256, with LF line ends, against the report's `inputs`, so it needs no git diff and
  also runs on pushes to `main`. A missing report, one without runs, or a `report.md` that isn't what `report.json`
  renders to also fails. It runs in the Checks job; `report.json` is left out of Biome because the benchmark writes
  it.

## 7. OpenTelemetry (M7-04, owner decision 2)

Deferred, marked "later" in the checklist:
- the app sends no telemetry (X-04, `docs/PRIVACY.md`), and an export would need an opt-in and a privacy change;
- Claude Code's OTel settings need verifying first **(verify)**.

Reopen it when a user asks for it.

## 8. UI

- **Metrics view** in Workspace settings: number tiles for the six metrics, a table by tier and by workflow, and a
  list of the tasks behind a selected number, each opening the task.
- One accent color, no dual axes; light and dark; keyboard reachable (X-12).

## 9. Security and privacy

- Metrics read local task records only and send nothing.
- The benchmark uses the maintainer's own login and spends their money, capped by `--max-usd`; nothing in CI calls a
  model.
- Hidden acceptance checks are copied in only after the agent's run, so the agent can't read them.
- PRIVACY gets one line: metrics stay on your computer.

## 10. Testing

- The metric formulas on synthetic task records, including old tasks without `runs`, XL tasks, and runs with no
  gates.
- The suite's and report's schemas.
- `check-eval-report.ts` with a changed hash, an unchanged one, and a missing report.
- One live benchmark on sample-app (haiku, a few cents) as the M7-E1 demonstration.

## 11. Delivery (one PR per step)

1. Run history: `task.runs[]`.
2. Metrics and the Metrics view.
3. The eval runner (a library from `live-task.ts`), the suite and the report.
4. The CI report check and a first committed report → **M7-E1**.

## 12. Alternatives considered

- **Benchmark in CI with an API key secret:** rejected by owner decision 1. It keeps secrets and spend out of CI.
- **OpenTelemetry now:** deferred by owner decision 2.
- **Metrics from Claude's session JSONL:** rejected by ADR-0004; the app's own task records carry what's needed.
- **Human fixes from git history:** later, if at all. Telling a person's fix from unrelated work is noisy.

## 13. Decisions and what's still open

**Owner decisions (2026-11-02):**
1. The benchmark runs locally and its report is committed; CI only checks that the report is current.
2. OpenTelemetry (M7-04) is deferred.

**Still open:**
- The suite's size and mix. Proposed: 6–8 cases, S and M tasks on sample-app, plus one for each other stack with
  tests (go-service, python-uv-fastapi).
- The default N and budget. Proposed: N=3, $3 per variant.

**As built (step 3):** 7 cases: five on sample-app (four S, one M) and two S on go-service. python-uv-fastapi is
left out for now: its gates need `uv`. Defaults are N=3 and a cap of $3 per variant for the whole benchmark.
