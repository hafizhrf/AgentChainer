import {
  type GateKind,
  type GateRun,
  type MessageRef,
  type ResultKey,
  resultRef,
  type StepRun,
  type Task,
  type TaskRun,
} from "@agentchainer/protocol";
import type { XlWorkflow } from "./library.ts";
import { failing, kinds } from "./orchestrator.ts";
import { result } from "./result.ts";

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
  /**
   * Adds the worktree for a task id on its branch, from `from` (or reuses its branch); returns its code folder. `repo`
   * is another folder of a multi-folder workspace (M8-01); the primary folder's repository otherwise, as for the rest.
   */
  worktree(id: string, from: string, repo?: string): { path: string; branch: string; code: string };
  /** The code folder of an existing worktree. */
  codeOf(path: string, repo?: string): string;
  exists(path: string): boolean;
  removeWorktree(path: string, repo?: string): void;
  head(): string | null;
  tip(branch: string, repo?: string): string;
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

const ENDS: Partial<Record<Task["state"], ResultKey>> = {
  failed: "xl.ends.failed",
  unverified: "xl.ends.unverified",
  cancelled: "xl.ends.cancelled",
  interrupted: "xl.ends.interrupted",
};

/**
 * A text the run records (X-13 part 2b): in English, with its ref when the sidecar wrote it, so the app shows it in its
 * language. Without one (a branch name, an error's message, a record from before refs) it shows as written.
 */
type Said = { text: string; ref?: MessageRef | undefined };
/** As a value in another result: its ref, so the whole sentence renders in one language, or its text. */
const value = (s: Said) => s.ref ?? s.text;
const noted = (s: Said) => ({ note: s.text, noteRef: s.ref });
const labelled = (s: Said) => ({ label: s.text, labelRef: s.ref });
/** A run's outcome as said: with its ref when it was written with one. */
const outcomeOf = (r: TaskRun | null | undefined): Said | undefined =>
  r?.outcome === undefined ? undefined : { text: r.outcome, ref: r.outcomeRef };
/** An error's message, with the ref an error from a result carries (`git merge failed: …`). */
function failure(err: unknown): Said {
  const ref = (err as { ref?: unknown } | null)?.ref;
  return {
    text: err instanceof Error ? err.message : String(err),
    ref:
      ref && typeof ref === "object" && typeof (ref as MessageRef).key === "string" ? (ref as MessageRef) : undefined,
  };
}

/** The note a run that picks up gives the steps it was cut off in: this one's, a task run's, or, before refs, the text. */
const INTERRUPTED = ["xl.note.interrupted", "run.note.interrupted"];
const interrupted = (s: StepRun) => (s.noteRef ? INTERRUPTED.includes(s.noteRef.key) : s.note === "Interrupted");

/** Notes as one, "; " between them; each keeps its own ref. */
function joined(parts: Said[]): Said {
  const [first, ...rest] = parts;
  if (!first) return { text: "" };
  return rest.length ? result("xl.note.list", { first: value(first), rest: value(joined(rest)) }) : first;
}

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
    const stopped = result("xl.outcome.stoppedByUser");
    try {
      if (this.d.resume) {
        const note = noted(result("xl.note.interrupted"));
        this.commit((r) => ({
          steps: r.steps.map((s) =>
            s.status === "running" ? { ...s, status: "failed", endedAt: this.at(), ...note } : s,
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
      return this.end("failed", result("xl.outcome.error", { error: value(failure(err)) }));
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

  private end(state: Task["state"], outcome?: Said): Task {
    this.commit(
      (r) => {
        const said = outcome ?? outcomeOf(r) ?? result("xl.outcome.failed");
        return {
          endedAt: this.at(),
          outcome: said.text,
          outcomeRef: said.ref,
          steps: r.steps.map((s) => (s.status === "running" ? { ...s, status: "cancelled", endedAt: this.at() } : s)),
        };
      },
      { state },
    );
    return this.task;
  }

  private fail(outcome: Said): false {
    this.commit(() => ({ outcome: outcome.text, outcomeRef: outcome.ref }));
    return false;
  }

  /* ---------- The task branch ---------- */

  /** The task's worktree (made once, with its setup) and the baseline gates in it; its code folder, or null. */
  private async prepare(): Promise<string | null> {
    const { world } = this.d;
    let wt = this.task.worktree;
    if (!wt || wt.removed || !world.exists(wt.path)) {
      const base = wt?.base ?? world.head();
      const id = this.begin({ step: "setup", ...labelled(result("xl.label.taskBranch")), kind: "setup" });
      if (!base) {
        this.finish(id, { status: "failed", ...noted(result("xl.note.noCommit")) });
        this.fail(result("xl.outcome.noCommit"));
        return null;
      }
      const added = world.worktree(this.task.id, base);
      const setup = await world.setup(added.code, this.abort.signal);
      if (this.cancelled) {
        this.finish(id, { status: "cancelled" });
        return null;
      }
      if (setup && (setup.exitCode !== 0 || setup.timedOut)) {
        const ran = setupResult(setup);
        this.finish(id, { status: "failed", ...noted(ran) });
        this.fail(result("xl.outcome.setupFailed", { setup: ran.ref }));
        return null;
      }
      wt = { path: added.path, branch: added.branch, base, untracked: world.untracked(added.code) };
      this.commit(() => ({ base }), { worktree: wt });
      // A multi-folder task's branches in its other folders were made with the run (M8-01); they're set up here.
      const notes: Said[] = [{ text: added.branch }, ...(setup ? [setupResult(setup)] : [])];
      for (const f of this.folders()) {
        const ready = await world.setup(f.code, this.abort.signal);
        if (ready && (ready.exitCode !== 0 || ready.timedOut)) {
          const ran = setupResult(ready).ref;
          this.finish(id, {
            status: "failed",
            ...noted(result("xl.note.folderSetup", { folder: f.name, setup: ran })),
          });
          this.fail(result("xl.outcome.setupFailedIn", { folder: f.name, setup: ran }));
          return null;
        }
        if (ready) notes.push(result("xl.note.folderSetup", { folder: f.name, setup: setupResult(ready).ref }));
      }
      this.finish(id, { status: "done", ...noted(joined(notes)) });
    }
    const code = world.codeOf(wt.path);
    // A baseline that finished counts; one the app was cut off in runs again.
    if (!this.rec.steps.some((s) => s.kind === "baseline" && s.status !== "running" && !interrupted(s))) {
      const id = this.begin({ step: "baseline", ...labelled(result("xl.label.baseline")), kind: "baseline" });
      const { runs, notRun } = await this.gates(code, 0);
      this.commit(() => ({ baseline: runs, notRun }));
      if (this.cancelled) {
        this.finish(id, { status: "cancelled" });
        return null;
      }
      const failed = failing(runs);
      this.finish(id, {
        status: failed.length ? "failed" : "done",
        ...noted(
          !runs.length
            ? result("xl.note.noGates")
            : failed.length
              ? result("xl.note.alreadyFailing", { gates: kinds(failed) })
              : result("xl.note.allPassed"),
        ),
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
    let stop: Said | null = null;

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
      // Why it ended: its setup's failure, or its own run's outcome, quoted with its ref.
      const said = note ?? outcomeOf(child.run);
      this.finish(
        entry,
        {
          status: this.cancelled || child.state === "cancelled" ? "cancelled" : ok ? "done" : "failed",
          ...(said?.text ? noted(said) : {}),
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
          result("xl.outcome.subtaskEnded", {
            ...this.named(child),
            ends: resultRef(ENDS[child.state] ?? "xl.ends.unfinished"),
            why: value(said ?? result("xl.phrase.noOutcome")),
          });
      start();
    }
    if (this.cancelled) return false;
    if (stop) return this.fail(stop);
    if (ids.some((id) => !merged.has(id))) return this.fail(result("xl.outcome.waiting"));
    return true;
  }

  /** Its worktree (from the task branch's tip, with the setup) unless it has one, then its tier's workflow. */
  private async startChild(stored: Task): Promise<Ended> {
    const { world } = this.d;
    let child = stored;
    const entry = this.begin({
      step: `subtask-${this.number(child)}`,
      ...labelled(result("xl.label.subtask", this.named(child))),
      kind: "subtask",
      taskId: child.id,
    });
    if (!child.worktree || child.worktree.removed || !world.exists(child.worktree.path)) {
      // A sub-task in another folder branches from the task's branch in that folder's repository (M8-01).
      const repo = child.folder?.path;
      const from = world.tip(this.task.worktree?.branch ?? "", repo);
      const added = world.worktree(child.id, from, repo);
      const setup = await world.setup(added.code, this.abort.signal);
      if (setup && (setup.exitCode !== 0 || setup.timedOut)) {
        const note = result("xl.note.setupFailed", { setup: setupResult(setup).ref });
        return { id: child.id, entry, child: { ...child, state: "failed" }, note };
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
  private merge(primary: string, child: Task, merged: Set<string>): Said | null {
    const { world } = this.d;
    const n = this.number(child);
    const named = this.named(child);
    // Into the task's branch in the sub-task's own folder (M8-01).
    const repo = child.folder?.path;
    const into = repo ? this.folders().find((f) => f.name === child.folder?.name)?.code : primary;
    const label = labelled(result("xl.label.merge", { n }));
    const id = this.begin({ step: `merge-${n}`, ...label, kind: "merge", taskId: child.id });
    const wt = child.worktree;
    if (!wt) {
      this.finish(id, { status: "failed", ...noted(result("xl.note.noWorktree")) });
      return result("xl.outcome.noWorktree", named);
    }
    if (!into) {
      const folder = String(child.folder?.name);
      this.finish(id, { status: "failed", ...noted(result("xl.note.noBranchIn", { folder })) });
      return result("xl.outcome.noBranchIn", { ...named, folder });
    }
    const accepted = child.state === "accepted";
    try {
      if (!wt.removed && world.exists(wt.path)) {
        world.commit(
          world.codeOf(wt.path, repo),
          `${child.title ?? child.request}\n\nAgentChainer sub-task ${n} of task ${this.task.id}${accepted ? ", accepted with risk" : ""}.`,
          wt.untracked,
        );
      }
      const r = world.merge(into, wt.branch, `Merge sub-task ${n}: ${child.title ?? child.request}`);
      if (!r.merged) {
        const files = r.conflicts.join(", ");
        this.finish(id, { status: "failed", ...noted(result("xl.note.conflicts", { files })) });
        return result("xl.outcome.conflicts", { ...named, files });
      }
    } catch (err) {
      const error = failure(err);
      this.finish(id, { status: "failed", ...noted(error) });
      return result("xl.outcome.mergeFailed", { ...named, error: value(error) });
    }
    let kept = false;
    if (!wt.removed && world.exists(wt.path)) {
      // Its work is merged, so a folder that can't go yet (on Windows, while a process it started still runs there) is
      // left for Clean up instead of stopping the run.
      try {
        world.removeWorktree(wt.path, repo);
        world.save({ ...world.load(child.id), worktree: { ...wt, removed: true } });
      } catch {
        kept = true;
      }
    }
    const done = result(accepted ? "xl.note.mergedAccepted" : "xl.note.merged");
    this.finish(id, { status: "done", ...noted(kept ? result("xl.note.worktreeKept", { merged: done.ref }) : done) });
    merged.add(child.id);
    return null;
  }

  /** A multi-folder task's branches in its other folders (M8-01): each folder's name and code folder. */
  private folders(): { name: string; code: string }[] {
    return (this.task.folders ?? []).flatMap((f) =>
      f.worktree && !f.worktree.removed ? [{ name: f.name, code: this.d.world.codeOf(f.worktree.path, f.path) }] : [],
    );
  }

  /**
   * The integration gates on the task's branch, in each of its folders with that folder's commands (M8-01); another
   * folder's runs carry its name, as a task's do. A gate counts as run when any folder has it.
   */
  private async gates(code: string, round: number): Promise<{ runs: GateRun[]; notRun: GateKind[] }> {
    const kinds = this.d.workflow.integration.gates;
    const first = await this.d.world.gates(code, kinds, round, this.abort.signal);
    const runs = [...first.runs];
    let notRun = first.notRun;
    for (const f of this.folders()) {
      const r = await this.d.world.gates(f.code, kinds, round, this.abort.signal);
      runs.push(
        ...r.runs.map((g) => ({
          ...g,
          folder: f.name,
          package: g.package === "." ? f.name : `${f.name}:${g.package}`,
        })),
      );
      notRun = notRun.filter((k) => r.notRun.includes(k));
    }
    return { runs, notRun };
  }

  /** A sub-task's number, from its place in the split. */
  private number(child: Task): number {
    return (this.task.subtasks ?? []).indexOf(child.id) + 1;
  }

  /** A sub-task's number and title, for the results that name it: "Sub-task 2 (Add the route)". */
  private named(child: Task): { n: number; title: string } {
    return { n: this.number(child), title: child.title ?? child.request };
  }

  /* ---------- Integration ---------- */

  /** The gates on the merged task branch: Done only when nothing fails that didn't fail before the task. */
  private async integrate(code: string): Promise<Task> {
    const round = Math.max(-1, ...this.rec.gates.map((g) => g.round)) + 1;
    const id = this.begin({ step: "integration", ...labelled(result("xl.label.integration")), kind: "gates" });
    const { runs, notRun } = await this.gates(code, round);
    this.commit((r) => ({ gates: [...r.gates, ...runs], notRun }));
    if (this.cancelled) {
      this.finish(id, { status: "cancelled" });
      return this.end("cancelled", result("xl.outcome.stoppedByUser"));
    }
    const failed = failing(runs);
    const before = (g: GateRun) =>
      this.rec.baseline.some((b) => b.kind === g.kind && b.package === g.package && (b.exitCode !== 0 || b.timedOut));
    const fresh = failed.filter((g) => !before(g));
    const old = failed.filter(before);
    this.finish(id, {
      status: failed.length ? "failed" : "done",
      ...noted(
        !runs.length
          ? result("xl.note.noGates")
          : failed.length
            ? result("xl.note.gatesFailed", { gates: kinds(failed) })
            : result("xl.note.allPassed"),
      ),
    });
    const branch = this.task.worktree?.branch ?? resultRef("xl.phrase.taskBranch");
    if (!runs.length) return this.end("unverified", result("xl.outcome.unverified", { branch }));
    if (fresh.length) {
      return this.end("failed", result("xl.outcome.newFailures", { branch, gates: kinds(fresh) }));
    }
    if (old.length) {
      const count = new Set(old.map((g) => g.kind)).size;
      return this.end("failed", result("xl.outcome.stillFailing", { count, gates: kinds(old) }));
    }
    return this.end("done", result("xl.outcome.done", { branch }));
  }
}

/** A sub-task's run that ended; `note` says why when it never got to run (its setup failed). */
type Ended = { id: string; entry: string; child: Task; note?: Said };

/** A setup command's run in a sentence, in English and as a ref (X-13 part 2b). */
export function setupResult(s: SetupRun) {
  const seconds = (s.durationMs / 1000).toFixed(1);
  return s.timedOut
    ? result("xl.setup.timedOut", { command: s.command, seconds })
    : result("xl.setup.exited", { command: s.command, code: String(s.exitCode), seconds });
}

export function setupNote(s: SetupRun): string {
  return setupResult(s).text;
}
