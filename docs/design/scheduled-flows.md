# Design: scheduled flows (M8-05)

- **Status:** Accepted by the owner, 2026-11-03
- **Covers:** M8-05: run a task on a schedule (e.g. a nightly dependency bump), locally, with a budget cap and an
  evidence report per run
- **Source:** [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator)'s flows (CAO, Apache-2.0),
  used as ideas only; no code is copied
- **Builds on:** M3's tasks and evidence, M7's run history ("Run again"), M8-02's fleet view

## 1. Decisions (owner, 2026-11-03)

1. **What runs:** a schedule re-runs one task that a person approved. The contract stays fixed, nothing is drafted
   per run, and the task's budget cap applies to each run.
2. **Approvals:** a scheduled run uses `acceptEdits`, so edits go ahead. Any other approval (a command, a web fetch, …)
   pauses the run, which waits for the person. They're notified, and nothing is denied or allowed on their behalf.
3. **Missed runs:** schedules run only while the app is open; v0.x installs no OS service. A time missed while the app
   was closed, or the computer asleep, runs once on the next check, marked late. There's never more than one
   catch-up.
4. **Cadence:** presets only, in local time:
   - every N hours, on the hour counted from midnight;
   - daily at a time;
   - weekly on chosen days at a time.

## 2. How it works (`packages/sidecar/src/tasks/schedules.ts`)

- **Storage:** a schedule lives with its workspace in `.agentchainer/schedules.json`, which git ignores. A file the
  app can't read runs nothing.
  - A schedule's fields: id, task id, title, cadence, enabled, next time, last run.
  - The last run records `started`, `skipped` (the task still ran) or `failed-to-start` with a reason, and whether it
    was late (more than 2 minutes after its time).
- **Watching:**
  - `schedule.watch {cwds}` names the workspaces whose schedules run. The UI sends it after every handshake, so a
    restarted sidecar runs them again.
  - The sidecar checks once a minute. That's robust to sleep and clock changes.
- **When a schedule is due:**
  - The task must still be one a schedule can run (`schedulable`):
    - approved;
    - not XL (each run's split needs a person);
    - not a sub-task;
    - its last run not left interrupted.
  - The run starts like Run again: in `acceptEdits`, with the model of the task's last run, so a schedule never
    switches it to a costlier one, and `trigger: "schedule"` on the run.
  - Its steps' sessions carry `TaskTag.scheduled`, so the UI knows an approval belongs to a scheduled run.
  - Either way, the next time becomes the first one after now.
- **Evidence per run:** when a run ends, its report is also kept as `evidence-<n>.md` in the task's folder. The run's
  summary names it (`RunSummary.evidence`), so the next run no longer replaces the last one's report. This holds for
  every run, not only scheduled ones.
- **Methods:** `schedule.list`, `schedule.save` (create or edit, checked), `schedule.delete`, `schedule.runNow` (runs it
  now; its next time stays), and `schedule.watch`. Notifications: `schedule.changed` and `schedule.deleted`.

## 3. UI (PR 2)

```
 Task → [Schedule…]
 ┌ Schedule "Bump dependencies" ───────────────────────────────┐
 │ (•) Daily at [02:00]   ( ) Every [6] hours   ( ) Weekly      │
 │ Next runs: Tue 02:00 · Wed 02:00 · Thu 02:00                 │
 │ Each run: up to $1.50 (the task's budget), Haiku 5.5        │
 │ Edits are accepted; anything else waits for you.             │
 │ Runs only while AgentChainer is open.     [Cancel] [Save]    │
 └──────────────────────────────────────────────────────────────┘
 Fleet → Scheduled
   Bump dependencies · app-ws · Daily at 02:00 · next Tue 02:00 · last: done, late   [on] Run now ⋯
```

- **OS notifications** (`tauri-plugin-notification`, asked for on the first schedule saved):
  - a scheduled run needs an approval;
  - a scheduled run ended, with its state and cost.
- **Schedule…** sits on a task that can be scheduled.
- **Fleet → Scheduled** lists every schedule in the watched workspaces, with enable, Run now, edit and delete.

## 4. Security

See THREAT_MODEL T-17:
- A schedule only re-runs a task a person approved, with its budget cap per run.
- Edits go ahead, and everything else waits for the person.
- It runs only while the app is open.
- Schedules are local data that git ignores, never read from a repository's tracked files.
- No OS service, timer or background process is installed.

## 5. Verification

- **Unit tests:**
  - `schedules.test.ts`:
    - next times for each preset (wraps, times already passed);
    - a schedule that's due runs once, with the next time set after;
    - a missed run caught up once, marked late;
    - a run skipped while the task still runs;
    - a refused task;
    - a disabled schedule and Run now;
    - edit and delete;
    - a broken file.
  - `run-history.test.ts`: per-run evidence names and the trigger.
- **Live:** `spike-host.ts --scenario schedule` on haiku, about $0.03 a run, two runs. It checked that:
  - an unknown task is refused;
  - a sample-app task, run once by hand, was scheduled daily at the next minute;
  - the minute check ran it again as a scheduled run with the same model and `acceptEdits`;
  - the next time moved a day on;
  - both runs kept their own evidence report.
