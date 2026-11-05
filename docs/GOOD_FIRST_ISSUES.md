# Good first issues

Small, self-contained changes for a first contribution: two per area of the [checklist](CHECKLIST.md). Each touches
one to three files, needs no model calls, no cloud logins and no Mac, and was checked against the code on 2026-11-06.
Line numbers drift; search for the names if they've moved.

These are drafts. Each becomes a GitHub issue with the labels shown; until then, say in a PR which one you took.
Read [CONTRIBUTING](../CONTRIBUTING.md) first, and run `pnpm lint && pnpm typecheck && pnpm test` before you push.
UI text goes in both catalogs, `locales/en/` and `locales/id/` (ask in the PR if you don't speak Indonesian).

## M1 · Sessions and chat

### [M1] Unit-test the transcript helpers `closeAssistant`, `setMessageId` and `findAgent`
Labels: `good first issue`, `enhancement`
- **Context:** three pure helpers in `apps/desktop/src/transcript.ts` (`closeAssistant` around line 86, `setMessageId`
  around 306, `findAgent` around 332) are used by `App.tsx`, `SessionView.tsx` and `tasks/run.ts`, but
  `transcript.test.ts` doesn't test them.
- **Done when** `transcript.test.ts` covers: closing an open assistant or thinking item, and leaving the list as it is
  otherwise; `setMessageId` changing only the matching user item; `findAgent` finding a nested agent, and returning
  `undefined` when none matches.

### [M1] Test the approval rules for `.git/`, `.env.local` and `NotebookEdit`
Labels: `good first issue`, `enhancement`
- **Context:** `describeRequest` in `packages/protocol/src/approval.ts` (around lines 139–151) rates a write inside
  `.git/` and an `.env.local`-style file as high risk, and reads `notebook_path` for `NotebookEdit`.
  `approval.test.ts` covers `.env`, CI workflows, writes outside the workspace and a plain file, but not these.
- **Done when** the test asserts `/repo/.git/config` is high risk ("Inside git's own folder"), `/repo/.env.local` is
  high risk, and a `NotebookEdit` with `notebook_path` is an edit of that path.

## M2 · Workspace readiness and setup

### [M2] Show translated status words after applying a setup and in History
Labels: `good first issue`, `enhancement`
- **Context:** `apps/desktop/src/setup/PlanView.tsx` (around line 386) shows `{r.status}` and
  `apps/desktop/src/setup/History.tsx` (around line 60) shows `{a.status}`, so raw values such as `applied`,
  `rolled-back` or `conflict` reach the screen, untranslated.
- **Done when** both use a status → catalog key map, with the words in `locales/en/setup.json` and
  `locales/id/setup.json`, and `pnpm test` passes.

### [M2] Unit-test the TOML helpers in `detect/manifests.ts`
Labels: `good first issue`, `enhancement`
- **Context:** `tomlSections`, `tomlString` and `tomlKeys` in `packages/sidecar/src/detect/manifests.ts` are small
  regex parsers for `pyproject.toml` and `Cargo.toml`. No test imports them.
- **Done when** tests cover `[[array.tables]]`, a header followed by a `# comment`, a section that appears twice,
  single and double quotes, CRLF line endings, and an empty input.

## M3 · Tasks

### [M3] `changedBetween` misses deleted files
Labels: `good first issue`, `bug`
- **Context:** `changedBetween` in `packages/sidecar/src/bootstrap/workspace-guard.ts` (around line 90) compares
  `(before.get(f) ?? "clean") !== (after.get(f) ?? "clean")`. A deleted file's hash is `null` (see `snapshot`), and
  `null ?? "clean"` is `"clean"`, so a clean file that a gate deletes, or a deleted file it restores, isn't reported.
  This feeds the files a gate changed (`tasks/gates.ts`).
- **Done when** it tells "not in the map" from "`null`" (e.g. with `has()`), and a test covers both directions.

### [M3] Unit-test `parseReview`
Labels: `good first issue`, `enhancement`
- **Context:** `parseReview` in `packages/sidecar/src/tasks/orchestrator.ts` (around line 120) reads a review step's
  verdict, from structured output first and then from JSON inside the text. The runner and the PR review use it; no
  test does.
- **Done when** tests cover a valid structured review, JSON inside prose, broken JSON, text without braces, and JSON
  that doesn't match the schema (the last three give `null`).

## M4 · The agent graph

### [M4] "+1 agents": pluralize a folded subtree's count
Labels: `good first issue`, `bug`
- **Context:** `graph.sessionGraph.moreAgents` in `locales/en/graph.json` is `"+{{n}} agents"`, so one folded agent
  reads "+1 agents". It's used in `apps/desktop/src/graph/SessionGraph.tsx` (around line 247).
- **Done when** it passes `count` with `_one` and `_other` keys in English (Indonesian needs only `_other`), as
  [CONTRIBUTING](../CONTRIBUTING.md#text-in-the-ui) shows.

### [M4] Test keyboard focus at the edges of the graph
Labels: `good first issue`, `enhancement`
- **Context:** `moveFocus` in `apps/desktop/src/graph/agentGraph.ts` (around lines 150–170) stops at the ends of a row
  of siblings, stays on a leaf for ArrowDown, and stays on the main agent for ArrowUp. `agentGraph.test.ts` covers only
  the middle cases.
- **Done when** each edge has an assert, plus one for an unknown starting id.

## M5 · Git and pull requests

### [M5] Show the merge method's name in the "Merged by you" line
Labels: `good first issue`, `bug`
- **Context:** `apps/desktop/src/tasks/MergeGates.tsx` (around line 68) passes `method: pr.merged.method`, so the line
  reads "(squash)". The same file already has `METHOD_LABEL`.
- **Done when** the line shows the method's label, e.g. "Squash and merge".

### [M5] Unit-test `mergeMethods`
Labels: `good first issue`, `enhancement`
- **Context:** `mergeMethods` in `packages/sidecar/src/github.ts` (around lines 172–192) reads which merge methods a
  repository allows. It's only reached through the task service's tests.
- **Done when** `github.test.ts`, with its `fakeGh` helper, covers: the viewer's default not allowed (falls back to
  the first allowed); none allowed; an empty `viewerDefaultMergeMethod`; and `gh` exiting non-zero (throws).

## M6 · Deploys and the workflow canvas

### [M6] Test a smoke check whose request throws
Labels: `good first issue`, `enhancement`
- **Context:** `runSmoke` in `packages/sidecar/src/deploy/smoke.ts` has a `catch` for a failed request ("GET …
  failed: …") that no test reaches; `deploy.test.ts` covers a non-2xx answer and a smoke script.
- **Done when** a test passes a `fetchImpl` that rejects, and asserts `ok: false`, `how: "http"` and the detail.

### [M6] Test the Docker image setting
Labels: `good first issue`, `enhancement`
- **Context:** `deploy/adapters.ts` (around lines 290–300) saves the image with `setDockerImage` and reads it with
  `dockerImage`. The tests call the first, never the second.
- **Done when** tests cover: set, then read back; setting `null` clears it; an invalid image in `docker.json` reads as
  `null`; no file reads as `null`.

## M7 · Metrics and evals

### [M7] Show translated task states on the Metrics page
Labels: `good first issue`, `bug`
- **Context:** `apps/desktop/src/setup/Metrics.tsx` (around line 272) shows `{task.state}`, so it reads "unverified"
  or "accepted". `stateLabel()` in `apps/desktop/src/tasks/run.ts` already gives each state its label.
- **Done when** the list uses `stateLabel(task.state).label`.

### [M7] Unit-test `percentile`
Labels: `good first issue`, `enhancement`
- **Context:** `percentile` in `packages/sidecar/src/tasks/metrics.ts` (around line 48) is only reached through
  `metrics.test.ts`'s totals.
- **Done when** asserts cover an empty list (0), one sample, p = 0, p = 1, and p50 and p90 of ten samples.

## M8 · Team chats, profiles, schedules and lessons

### [M8] `usdShort(999_999)` shows "$1000K"
Labels: `good first issue`, `bug`
- **Context:** `usdShort` in `apps/desktop/src/team.ts` (around line 64) rounds with `toFixed(1)` after picking the
  unit, so 999,999 becomes "$1000K" instead of "$1M", and 999.999 becomes "$1000.00" instead of "$1K".
- **Done when** a value that rounds up to the next unit moves to that unit, and `team.test.ts` has those cases.

### [M8] Unit-test `lessonPrompt` and `claudeMdPath`
Labels: `good first issue`, `enhancement`
- **Context:** in `packages/sidecar/src/tasks/lessons.ts`, `lessonPrompt` builds the prompt for the lessons call and
  `claudeMdPath` picks the CLAUDE.md to add to. `lessons.test.ts` imports neither.
- **Done when** tests cover the `(none)` placeholders, CLAUDE.md cut to 12,000 characters, multi-line signals
  indented, and `.claude/CLAUDE.md` chosen only when the root has no `CLAUDE.md` (in a temp folder).

## UX · Polish

### [UX] Translate the file status badge in the diff view
Labels: `good first issue`, `enhancement`
- **Context:** `apps/desktop/src/DiffView.tsx` (around line 149) shows `{diff.status}` ("untracked", "conflicted") as
  is. `apps/desktop/src/ui/TreeRow.tsx` has a `STATUS_NAME` map to `shell.treeRow.*` keys, not exported.
- **Done when** the map is exported and the badge uses it.

### [UX] The Flow tab says "The app's tier-s."
Labels: `good first issue`, `enhancement`
- **Context:** `sourceNote` in `apps/desktop/src/tasks/FlowPanel.tsx` puts the workflow's id (`tier-s`) into the
  `tasks.flow.source*` messages, so a task's Flow tab reads "The app's tier-s. Click a step to see it in the thread."
- **Done when** it reads as a sentence, e.g. "The app's tier S workflow.", in English and Indonesian, and a project's
  own workflow still shows its id.

## X · Across the app

### [X] Fix the old `approval.ts` path in ARCHITECTURE
Labels: `good first issue`, `documentation`
- **Context:** `docs/ARCHITECTURE.md` (around line 292) points to `apps/desktop/src/approval.ts`. The file moved to
  `packages/protocol/src/approval.ts`.
- **Done when** the link points to the file as it is today. While there, check §5.2's event table against
  `AgentEventSchema` in `packages/protocol/src/index.ts` and note any differences in the issue.

### [X] Unit-test the money and percent formatters
Labels: `good first issue`, `enhancement`
- **Context:** `usd`, `approxUsd` and `percent` in `apps/desktop/src/i18n/format.ts` have no tests; `index.test.ts`
  covers the other formatters. `apps/desktop/src/team.ts` also has its own `usd`.
- **Done when** tests cover the digits argument, rounding, and 0; optionally, note whether the two `usd` should be one.
