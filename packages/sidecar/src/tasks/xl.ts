import type { GateKind, GateRun, StepRun, Task, TaskRun } from "@agentchainer/protocol";
import type { XlWorkflow } from "./library.ts";
import { failing, kinds } from "./orchestrator.ts";

/**
 * XL runs (M3-07, planner.md §8). The task gets its own branch and worktree; each approved sub-task runs its own tier's
 * workflow in a worktree of its own, branched from the task branch's tip when it starts, `maxParallel` at once and
 * after the sub-tasks it depends on. A sub-task that ends Done (or that the user accepted) is committed on its branch
 * and merged into the task branch; the integration gates run on the result. Nothing touches the user's branch: they
 * merge the task branch when they want it.
 */

/** A setup command's run in a fresh worktree (the project's install command). */
export type SetupRun = {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  tail: string;
};

/** A sub-task's run in progress. */
export type ChildRun = { done: Promise<Task>; cancel: () => void };

/** What an XL run needs from the world, injected so it's tested without git or models. */
export interface XlWorld {
  /** Adds the worktree for a task id on its branch, from `from` (or reuses its branch); returns its code folder. */
  worktree(id: string, from: string): { path: string; branch: string; code: string };
  /** The code folder of an existing worktree. */
  codeOf(path: string): string;
  exists(path: string): boolean;
  removeWorktree(path: string): void;
  head(): string | null;
  tip(branch: string): string;
  /** Runs the install command in a fresh worktree; null when the workspace has none. */
  setup(code: string, signal: AbortSignal): Promise<SetupRun | null>;
  untracked(code: string): string[];
  gates(
    code: string,
    kinds: readonly GateKind[],
    round: number,
    signal: AbortSignal,
  ): Promise<{ runs: GateRun[]; notRun: GateKind[] }>;
  commit(code: string, message: string, untracked: string[]): string | null;
  merge(code: string, branch: string, message: string): { merged: boolean; conflicts: string[] };
  /** A sub-task as stored now (running without a live run reads as interrupted). */
  load(id: string): Task;
  save(child: Task): void;
  /** Starts a sub-task's run in its worktree; `resume` continues an interrupted one. */
  runChild(child: Task, resume: boolean): ChildRun;
}

export type XlDeps = {
  workflow: XlWorkflow;
  world: XlWorld;
  /** Persists the task and tells the UI; called on every change. */
  save: (task: Task) => void;
  now?: () => Date;
  /** Pick up an interrupted run: entries left running are marked, interrupted sub-tasks resume. */
  resume?: boolean;
};

const ENDS: Partial<Record<Task["state"], string>> = {
  failed: "failed",
  unverified: "wasn't verified",
  cancelled: "was stopped",
  interrupted: "was interrupted",
};

export class XlOrchestrator {
  private task: Task;
  private readonly d: XlDeps;
  private readonly now: () => Date;
  private readonly abort = new AbortController();
  private readonly children = new Map<string, ChildRun>();
  private cancelled = false;

  constructor(task: Task, deps: XlDeps) {
    this.task = task;
    this.d = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get current(): Task {
    return this.task;
  }

  private get rec(): TaskRun {
    if (!this.task.run) throw new Error("The task has no run.");
    return this.task.run;
  }

  /** Stops the run: setup or gates in progress, and every running sub-task. */
  cancel(): void {
    this.cancelled = true;
    this.abort.abort();
    for (const child of this.children.values()) child.cancel();
  }

  async run(): Promise<Task> {
    const stopped = "Stopped by the user. The worktrees are left as they are.";
    try {
      if (this.d.resume) {
        this.commit((r) => ({
          steps: r.steps.map((s) =>
            s.status === "running" ? { ...s, status: "failed", endedAt: this.at(), note: "Interrupted" } : s,
          ),
        }));
      }
      const code = await this.prepare();
      if (this.cancelled) return this.end("cancelled", stopped);
      if (!code) return this.end("failed");
      const merged = await this.subtasks(code);
      if (this.cancelled) return this.end("cancelled", stopped);
      if (!merged) return this.end("failed");
      return await this.integrate(code);
    } catch (err) {
      if (this.cancelled) return this.end("cancelled", stopped);
      return this.end("failed", `Stopped on an error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ---------- The run's record ---------- */

  private at(): string {
    return this.now().toISOString();
  }

  private commit(change: (run: TaskRun) => Partial<TaskRun>, task: Partial<Task> = {}): void {
    const run = { ...this.rec, ...change(this.rec) };
    this.task = { ...this.task, ...task, run, updatedAt: this.at() };
    this.d.save(this.task);
  }

  private begin(entry: Omit<StepRun, "id" | "status" | "startedAt" | "costUsd">): string {
    const n = this.rec.steps.filter((s) => s.step === entry.step).length + 1;
    const id = n === 1 ? entry.step : `${entry.step}-${n}`;
    this.commit((r) => ({
      steps: [...r.steps, { ...entry, id, status: "running", startedAt: this.at(), costUsd: 0 }],
    }));
    return id;
  }

  private finish(id: string, change: Partial<StepRun>, costUsd = 0): void {
    this.commit(
      (r) => ({
        costUsd: r.costUsd + costUsd,
        steps: r.steps.map((s) =>
          s.id === id ? { ...s, ...change, costUsd: s.costUsd + costUsd, endedAt: this.at() } : s,
        ),
      }),
      { costUsd: this.task.costUsd + costUsd },
    );
  }

  private end(state: Task["state"], outcome?: string): Task {
    this.commit(
      (r) => ({
        endedAt: this.at(),
        outcome: outcome ?? r.outcome ?? "The run failed.",
        steps: r.steps.map((s) => (s.status === "running" ? { ...s, status: "cancelled", endedAt: this.at() } : s)),
      }),
      { state },
    );
    return this.task;
  }

  private fail(outcome: string): false {
    this.commit(() => ({ outcome }));
    return false;
  }

  /* ---------- The task branch ---------- */

  /** The task's worktree (made once, with its setup) and the baseline gates in it; its code folder, or null. */
  private async prepare(): Promise<string | null> {
    const { world } = this.d;
    let wt = this.task.worktree;
    if (!wt || wt.removed || !world.exists(wt.path)) {
      const base = wt?.base ?? world.head();
      const id = this.begin({ step: "setup", label: "Task branch", kind: "setup" });
      if (!base) {
        this.finish(id, { status: "failed", note: "No commit to start from." });
        this.fail("The repository has no commit to branch from. Commit once, then run the task again.");
        return null;
      }
      const added = world.worktree(this.task.id, base);
      const setup = await world.setup(added.code, this.abort.signal);
      if (this.cancelled) {
        this.finish(id, { status: "cancelled" });
        return null;
      }
      if (setup && (setup.exitCode !== 0 || setup.timedOut)) {
        this.finish(id, { status: "failed", note: setupNote(setup) });
        this.fail(`Setting up the task branch failed: ${setupNote(setup)}`);
        return null;
      }
      wt = { path: added.path, branch: added.branch, base, untracked: world.untracked(added.code) };
      this.commit(() => ({ base }), { worktree: wt });
      this.finish(id, { status: "done", note: setup ? `${added.branch}; ${setupNote(setup)}` : added.branch });
    }
    const code = world.codeOf(wt.path);
    // A baseline that finished counts; one the app was cut off in runs again.
    if (!this.rec.steps.some((s) => s.kind === "baseline" && s.status !== "running" && s.note !== "Interrupted")) {
      const id = this.begin({ step: "baseline", label: "Gates before the task", kind: "baseline" });
      const { runs, notRun } = await world.gates(code, this.d.workflow.integration.gates, 0, this.abort.signal);
      this.commit(() => ({ baseline: runs, notRun }));
      if (this.cancelled) {
        this.finish(id, { status: "cancelled" });
        return null;
      }
      const failed = failing(runs);
      this.finish(id, {
        status: failed.length ? "failed" : "done",
        note: !runs.length ? "No gates to run." : failed.length ? `Already failing: ${kinds(failed)}.` : "All passed.",
      });
    }
    return code;
  }

  /* ---------- Sub-tasks ---------- */

  private merged(): Set<string> {
    return new Set(
      this.rec.steps.flatMap((s) => (s.kind === "merge" && s.status === "done" && s.taskId ? [s.taskId] : [])),
    );
  }

  /**
   * Runs the sub-tasks in dependency order, `maxParallel` at once, and merges each one that ends Done or was accepted.
   * After a sub-task that doesn't end Done, or a conflict, no new one starts; the running ones finish.
   */
  private async subtasks(code: string): Promise<boolean> {
    const ids = this.task.subtasks ?? [];
    const merged = this.merged();
    const running = new Map<string, Promise<Ended>>();
    let stop: string | null = null;

    const start = () => {
      let progressed = true;
      while (progressed && !stop && !this.cancelled) {
        progressed = false;
        for (const id of ids) {
          if (merged.has(id) || running.has(id) || running.size >= this.d.workflow.maxParallel) continue;
          const child = this.d.world.load(id);
          if (!(child.dependsOn ?? []).every((d) => merged.has(d))) continue;
          if (child.state === "done" || child.state === "accepted") {
            // Finished outside this run (run again on its own, or accepted after a failure): merge it as it is.
            stop = this.merge(code, child, merged);
            progressed = true;
            break;
          }
          running.set(id, this.startChild(child));
          progressed = true;
        }
      }
    };

    start();
    while (running.size) {
      const { id, entry, child, note } = await Promise.race(running.values());
      running.delete(id);
      this.children.delete(id);
      const ok = child.state === "done";
      this.finish(
        entry,
        {
          status: this.cancelled || child.state === "cancelled" ? "cancelled" : ok ? "done" : "failed",
          ...((note ?? child.run?.outcome) ? { note: note ?? child.run?.outcome } : {}),
        },
        child.run?.costUsd ?? 0,
      );
      if (this.cancelled) continue;
      // A sub-task that finished is merged even after a stop: its work is done either way.
      if (ok) {
        const why = this.merge(code, child, merged);
        stop = stop ?? why;
      } else
        stop =
          stop ??
          `${this.name(child)} ${ENDS[child.state] ?? "didn't finish"}: ${note ?? child.run?.outcome ?? "no outcome"}. Open it to run it again or accept its risk, then Continue.`;
      start();
    }
    if (this.cancelled) return false;
    if (stop) return this.fail(stop);
    if (ids.some((id) => !merged.has(id))) return this.fail("Some sub-tasks wait for others that couldn't run.");
    return true;
  }

  /** Its worktree (from the task branch's tip, with the setup) unless it has one, then its tier's workflow. */
  private async startChild(stored: Task): Promise<Ended> {
    const { world } = this.d;
    let child = stored;
    const entry = this.begin({
      step: `subtask-${this.number(child)}`,
      label: this.name(child),
      kind: "subtask",
      taskId: child.id,
    });
    if (!child.worktree || child.worktree.removed || !world.exists(child.worktree.path)) {
      const from = world.tip(this.task.worktree?.branch ?? "");
      const added = world.worktree(child.id, from);
      const setup = await world.setup(added.code, this.abort.signal);
      if (setup && (setup.exitCode !== 0 || setup.timedOut)) {
        return { id: child.id, entry, child: { ...child, state: "failed" }, note: `Setup failed: ${setupNote(setup)}` };
      }
      child = {
        ...child,
        worktree: { path: added.path, branch: added.branch, base: from, untracked: world.untracked(added.code) },
      };
      world.save(child);
    }
    if (this.cancelled) return { id: child.id, entry, child: { ...child, state: "cancelled" } };
    const run = world.runChild(child, child.state === "interrupted");
    this.children.set(child.id, run);
    return { id: child.id, entry, child: await run.done };
  }

  /** Commits the sub-task on its branch and merges it into the task branch; why the run stops, or null. */
  private merge(code: string, child: Task, merged: Set<string>): string | null {
    const { world } = this.d;
    const n = this.number(child);
    const id = this.begin({ step: `merge-${n}`, label: `Merge sub-task ${n}`, kind: "merge", taskId: child.id });
    const wt = child.worktree;
    if (!wt) {
      this.finish(id, { status: "failed", note: "It has no worktree." });
      return `${this.name(child)} has no worktree to merge.`;
    }
    const accepted = child.state === "accepted";
    try {
      if (!wt.removed && world.exists(wt.path)) {
        world.commit(
          world.codeOf(wt.path),
          `${child.title ?? child.request}\n\nAgentChainer sub-task ${n} of task ${this.task.id}${accepted ? ", accepted with risk" : ""}.`,
          wt.untracked,
        );
      }
      const r = world.merge(code, wt.branch, `Merge sub-task ${n}: ${child.title ?? child.request}`);
      if (!r.merged) {
        this.finish(id, { status: "failed", note: `Conflicts in ${r.conflicts.join(", ")}.` });
        return `Merging ${this.name(child, "sub-task")} conflicts in ${r.conflicts.join(", ")}. The merge is left in progress in the task's worktree: resolve and commit it there, or abort it, then Continue.`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.finish(id, { status: "failed", note: message });
      return `${this.name(child)} couldn't be merged: ${message}`;
    }
    let kept = false;
    if (!wt.removed && world.exists(wt.path)) {
      // Its work is merged, so a folder that can't go yet (on Windows, while a process it started still runs there) is
      // left for Clean up instead of stopping the run.
      try {
        world.removeWorktree(wt.path);
        world.save({ ...world.load(child.id), worktree: { ...wt, removed: true } });
      } catch {
        kept = true;
      }
    }
    const note = [
      accepted ? "Merged; it was accepted with risk." : "Merged.",
      kept ? "Its worktree is left for Clean up." : "",
    ];
    this.finish(id, { status: "done", note: note.filter(Boolean).join(" ") });
    merged.add(child.id);
    return null;
  }

  /** A sub-task's number, from its place in the split. */
  private number(child: Task): number {
    return (this.task.subtasks ?? []).indexOf(child.id) + 1;
  }

  private name(child: Task, word = "Sub-task"): string {
    return `${word} ${this.number(child)} (${child.title ?? child.request})`;
  }

  /* ---------- Integration ---------- */

  /** The gates on the merged task branch: Done only when nothing fails that didn't fail before the task. */
  private async integrate(code: string): Promise<Task> {
    const round = Math.max(-1, ...this.rec.gates.map((g) => g.round)) + 1;
    const id = this.begin({ step: "integration", label: "Integration gates", kind: "gates" });
    const { runs, notRun } = await this.d.world.gates(
      code,
      this.d.workflow.integration.gates,
      round,
      this.abort.signal,
    );
    this.commit((r) => ({ gates: [...r.gates, ...runs], notRun }));
    if (this.cancelled) {
      this.finish(id, { status: "cancelled" });
      return this.end("cancelled", "Stopped by the user. The worktrees are left as they are.");
    }
    const failed = failing(runs);
    const before = (g: GateRun) =>
      this.rec.baseline.some((b) => b.kind === g.kind && b.package === g.package && (b.exitCode !== 0 || b.timedOut));
    const fresh = failed.filter((g) => !before(g));
    const old = failed.filter(before);
    this.finish(id, {
      status: failed.length ? "failed" : "done",
      note: !runs.length ? "No gates to run." : failed.length ? `Failed: ${kinds(failed)}.` : "All passed.",
    });
    const branch = this.task.worktree?.branch ?? "the task branch";
    if (!runs.length) {
      return this.end(
        "unverified",
        `Every sub-task was merged into ${branch}, but no gate ran on it: nothing proved it.`,
      );
    }
    if (fresh.length) {
      return this.end("failed", `The merged branch ${branch} fails ${kinds(fresh)}, which passed before the task.`);
    }
    if (old.length) {
      const were =
        new Set(old.map((g) => g.kind)).size === 1
          ? "was already failing before the task and still fails"
          : "were already failing before the task and still fail";
      return this.end("failed", `${kinds(old)} ${were}. Accept the risk if that's expected.`);
    }
    return this.end("done", `Every sub-task was merged into ${branch}, and every gate passed on it.`);
  }
}

/** A sub-task's run that ended; `note` says why when it never got to run (its setup failed). */
type Ended = { id: string; entry: string; child: Task; note?: string };

function setupNote(s: SetupRun): string {
  return `\`${s.command}\` ${s.timedOut ? "timed out" : `exited ${s.exitCode}`} in ${(s.durationMs / 1000).toFixed(1)} s`;
}
