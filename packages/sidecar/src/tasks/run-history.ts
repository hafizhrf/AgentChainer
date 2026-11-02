import type { RunSummary, Task, TaskRun } from "@agentchainer/protocol";

/**
 * Run history (M7, docs/design/evals.md §3): "Run again" replaces `task.run`, so the run it replaces is kept as a
 * summary in `task.runs`. A task's runs are `runs` then `run`; a task from before this has no `runs`, and its one run
 * is `run`.
 */

/** Whether the last gate round passed every gate that ran; null when no gate ran. */
export function lastRoundPassed(run: Pick<TaskRun, "gates">): boolean | null {
  if (!run.gates.length) return null;
  const last = Math.max(...run.gates.map((g) => g.round));
  return run.gates.filter((g) => g.round === last).every((g) => g.exitCode === 0 && !g.timedOut);
}

/** A run as the history keeps it, with the state the task ended that run in. */
export function summarizeRun(run: TaskRun, state: Task["state"]): RunSummary {
  return {
    workflow: run.workflow,
    ...(run.model ? { model: run.model } : {}),
    state,
    costUsd: run.costUsd,
    gateRounds: run.gates.length ? Math.max(...run.gates.map((g) => g.round)) + 1 : 0,
    gatesPassed: lastRoundPassed(run),
    fixRounds: run.fixRounds,
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  };
}

/** The history with `task`'s current run added, for a task about to start a new one; nothing when it hasn't run. */
export function withPastRun(task: Task): Pick<Task, "runs"> {
  if (!task.run) return task.runs ? { runs: task.runs } : {};
  return { runs: [...(task.runs ?? []), summarizeRun(task.run, task.state)] };
}

/** Every run of a task, oldest first: the kept summaries, then the latest. */
export function allRuns(task: Task): RunSummary[] {
  return [...(task.runs ?? []), ...(task.run ? [summarizeRun(task.run, task.state)] : [])];
}
