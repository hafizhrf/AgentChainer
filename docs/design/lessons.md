# Design: lessons from outcomes (M8-06)

- **Status:** Accepted by the owner, 2026-11-03
- **Covers:** M8-06: suggest CLAUDE.md additions from finished tasks' evidence, each one approved by the person
- **Source:** [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator)'s memory and self-learning
  loop (CAO, Apache-2.0), used as ideas only; no code is copied
- **Builds on:** M3-09's evidence report, M2's History and Roll back, the setup plan's CLAUDE.md checks

## 1. Decisions (owner, 2026-11-03)

1. **Only on request.** A finished task's page has a **Suggest lessons** button: nothing runs unless the person clicks.
   It's one small haiku call.
2. **Where they go.** Approved lessons go into the project's CLAUDE.md under `## Lessons`, as a History run that can be
   rolled back. They're shared with the team through git, like the rest of CLAUDE.md.
3. **What counts.** All the run's recorded signals count. Each suggestion cites the signals it comes from, and
   duplicates are dropped.

## 2. Signals (`packages/sidecar/src/tasks/lessons.ts`, no model)

| Source | From the evidence report | Example |
|---|---|---|
| `gate` | A gate that failed in one round and passed in a later one; a gate already failing before the task doesn't count | `pnpm typecheck` failed, then passed after a fix: `TS2304 …` |
| `format` | A format gate that rewrote files | The formatter rewrote 2 files |
| `review` | Must-fix and should-fix findings (not notes) | must-fix in src/cart.js: rounds half down |
| `guard` | Guard blocks | Bash `rm -rf dist` was blocked |
| `approval` | Approvals the person denied | The person denied Bash `npm publish` |
| `notes` | The implementer's `## Notes` lines | I didn't run the tests, since … |

- **Limits:** at most 30 signals per call, each text trimmed.
- **No signals:** nothing is sent to the model, and the card says nothing in the run points at a lesson.

## 3. Suggesting

- **The call:** one haiku call with no tools, no settings, structured output and a $0.05 cap. It gets the signals, the
  current CLAUDE.md and the lessons dismissed before. It returns at most 5 lessons: short imperative rules for any
  task in this project, each with why and its signals' refs.
- **The instructions:** nothing task-specific, nothing CLAUDE.md already says, no secrets, no absolute or home-folder
  paths. "None" is a fine answer, and the card says so. A run whose records only concern itself gets none.
- **After the call, a lesson is dropped when:**
  - 80% of its words are in a CLAUDE.md line or a dismissed lesson;
  - or 80% of such a line's words are in it, for a line of 4 words or more, so a very short line can't swallow every
    suggestion;
  - or it names a home-folder path, or looks like a key or token.
- **Storage:**
  - The suggestions are kept in the task's folder (`lessons.json`), so the card shows them again without a call.
  - Dismissed lessons are kept per workspace in `.agentchainer/lessons.json`, which git ignores, and are never
    offered again.

## 4. Adding to CLAUDE.md

- **The file:** `CLAUDE.md`, or `.claude/CLAUDE.md` when only that exists.
- **The edit:** the picked lessons become bullets under `## Lessons`, each ending in "(from task “<title>”, <date>)".
  - The section is created at the end when it's missing. Otherwise the bullets go after its last line, before the
    next `#` or `##` heading.
  - The rest of the file stays exactly as it was.
- **Checks before writing:** the file must stay within 300 lines (the setup plan's rule), with no home-folder paths and
  no key or token shapes.
- **The preview:** the person sees the change as a diff before adding.
- **The write:** it's `applyFileEdits`, so the change is a History run that can be rolled back. The lessons not picked
  are dismissed.

## 5. UI

```
 Lessons   What this run suggests Claude should know next time, as CLAUDE.md lines.
 ☑ If a shell command is denied, don't call the task complete; list each unrun check …
   Why: two commands were denied and the report said done.     [denied: 1] [implementer's note: 3]
 ☐ Keep edits within the requested scope …
 CLAUDE.md
 + ## Lessons
 + - If a shell command is denied, … (from task “Add a comment”, 2026-11-03)
 Added as a History run, so it can be rolled back.        [Dismiss all] [Add 1 to CLAUDE.md]
```

- **Where:** the card sits after the Evidence card, on any task whose run ended.
- **Before suggesting:** the card says what it reads and what it costs.

## 6. Security

See THREAT_MODEL, "Lessons (M8-06)":
- Text from a run's records reaches CLAUDE.md only after a person reads and picks each line, in a diff.
- Records can carry repository content (T-02).
- Writes go only to CLAUDE.md, as History runs, after the path, size, home-path and secret checks.

## 7. Verification

- **Unit tests** (`lessons.test.ts`):
  - every signal kind, and a gate failing before the task left out;
  - a clean run makes no model call;
  - duplicates against CLAUDE.md, dismissals and short lines;
  - the section created or extended, with the rest of the file kept;
  - apply, roll back and dismissal;
  - home paths and tokens refused;
  - a fake model's lessons, with their sources.
- **Live:** `spike-host.ts --scenario lessons` on haiku, about $0.009, 4 of 4 passed:
  - a sample-app task ran with every command denied;
  - 4 lessons came back, each citing its signals;
  - one was added to CLAUDE.md under `## Lessons`, exactly as previewed;
  - rolling it back from History removed it;
  - the rest were dismissed.
