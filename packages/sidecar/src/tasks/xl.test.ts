import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type GateRun,
  type MessageRef,
  resultEnglish,
  resultText,
  type StepRun,
  setLanguage,
  type Task,
} from "@agentchainer/protocol";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun } from "./orchestrator.ts";
import { result } from "./result.ts";
import { type ChildRun, XlOrchestrator, type XlWorld } from "./xl.ts";

const workflow = LibrarySchema.parse(shipped).xl;
if (!workflow) throw new Error("no XL workflow");

const PARENT = "2026-10-30-00000000";
const A = "2026-10-30-0000000a";
const B = "2026-10-30-0000000b";
const C = "2026-10-30-0000000c";
const name = (id: string) => ({ [A]: "A", [B]: "B", [C]: "C", [PARENT]: "P" })[id] ?? id;

const gate = (kind: GateRun["kind"], exitCode: number, round = 0): GateRun => ({
  kind,
  command: `pnpm ${kind}`,
  package: ".",
  exitCode,
  timedOut: false,
  durationMs: 5,
  tail: "",
  round,
  at: "2026-10-30T00:00:00.000Z",
});

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    request: `Do ${name(id)}`,
    title: name(id),
    state: "ready",
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    contract: null,
    triage: null,
    availableGates: ["test"],
    costUsd: 0,
    run: null,
    ...over,
  };
}

function parent(over: Partial<Task> = {}): Task {
  return task(PARENT, {
    title: undefined,
    state: "running",
    subtasks: [A, B, C],
    run: newRun(
      workflow ?? { id: "tier-xl", version: 1 },
      { permissionMode: "default", base: null, untrackedAtStart: [] },
      new Date(),
    ),
    ...over,
  });
}

/** A world in memory: worktrees are names, merges move the task branch's tip, sub-tasks end as `ends` says. */
function fakeWorld(
  children: Task[],
  opts: {
    ends?: Record<string, Task["state"]>;
    conflicts?: Record<string, string[]>;
    baseline?: GateRun[];
    integration?: GateRun[];
    setupFails?: boolean;
    /** The worktrees whose setup fails, by task id; the others' passes when `setupRuns`, or there is none. */
    setupFailsIn?: string[];
    setupRuns?: boolean;
    /** What a sub-task that doesn't end Done says, instead of a failing gate's English. */
    failedOutcome?: { text: string; ref: MessageRef };
    /** Merges that throw, as `mergeInto` does when git fails for another reason than a conflict. */
    mergeThrows?: Record<string, Error>;
    slow?: Record<string, number>;
    /** Sub-tasks that end only once the log has this line, however slow the machine is. */
    until?: Record<string, string>;
    /** Worktrees that can't be removed yet, as on Windows while a process still runs in them. */
    busy?: string[];
  } = {},
) {
  const store = new Map(children.map((c) => [c.id, c]));
  const trees = new Set<string>();
  const tips = new Map<string, string>();
  const log: string[] = [];
  const cancelled: string[] = [];
  let running = 0;
  let peak = 0;
  let gateCalls = 0;
  const world: XlWorld = {
    worktree: (id, from) => {
      trees.add(`/wt/${id}`);
      if (!tips.has(`agentchainer/${id}`)) tips.set(`agentchainer/${id}`, from);
      log.push(`worktree ${name(id)} from ${from}`);
      return { path: `/wt/${id}`, branch: `agentchainer/${id}`, code: `/wt/${id}` };
    },
    codeOf: (p) => p,
    exists: (p) => trees.has(p),
    removeWorktree: (p) => {
      if (opts.busy?.includes(p.slice(4))) throw new Error(`EPERM, Permission denied: ${p}`);
      trees.delete(p);
      log.push(`remove ${name(p.slice(4))}`);
    },
    head: () => "h0",
    tip: (b) => tips.get(b) ?? "h0",
    setup: async (code) =>
      opts.setupFails || opts.setupFailsIn?.includes(code.slice(4))
        ? { command: "pnpm install", exitCode: 1, timedOut: false, durationMs: 1000, tail: "ERR" }
        : opts.setupRuns
          ? { command: "pnpm install", exitCode: 0, timedOut: false, durationMs: 2500, tail: "" }
          : null,
    untracked: () => [],
    gates: async (_code, _kinds, round) => {
      gateCalls++;
      return { runs: (gateCalls === 1 ? opts.baseline : opts.integration) ?? [gate("test", 0, round)], notRun: [] };
    },
    commit: (code) => {
      log.push(`commit ${name(code.slice(4))}`);
      return "c";
    },
    merge: (_code, branch) => {
      const id = branch.slice("agentchainer/".length);
      const thrown = opts.mergeThrows?.[id];
      if (thrown) throw thrown;
      const conflicts = opts.conflicts?.[id];
      if (conflicts) return { merged: false, conflicts };
      log.push(`merge ${name(id)}`);
      tips.set(`agentchainer/${PARENT}`, `after-${name(id)}`);
      return { merged: true, conflicts: [] };
    },
    load: (id) => {
      const t = store.get(id);
      if (!t) throw new Error(`no ${id}`);
      return t;
    },
    save: (c) => store.set(c.id, c),
    runChild: (child, resume): ChildRun => {
      running++;
      peak = Math.max(peak, running);
      log.push(`run ${name(child.id)}${resume ? " (resume)" : ""}`);
      let stop: (() => void) | undefined;
      const done = new Promise<Task>((resolve) => {
        const end = (state: Task["state"]) => {
          running--;
          const ended: Task = {
            ...child,
            state,
            run: {
              ...newRun(
                { id: "tier-s", version: 1 },
                { permissionMode: "default", base: null, untrackedAtStart: [] },
                new Date(),
              ),
              costUsd: 0.1,
              outcome: state === "done" ? "Every gate passed." : "test still failing after 2 fix rounds.",
              ...(state !== "done" && opts.failedOutcome
                ? { outcome: opts.failedOutcome.text, outcomeRef: opts.failedOutcome.ref }
                : {}),
            },
          };
          store.set(child.id, ended);
          resolve(ended);
        };
        const wait = opts.until?.[child.id];
        const tick = () => {
          if (wait && !log.includes(wait)) t = setTimeout(tick, 5);
          else end(opts.ends?.[child.id] ?? "done");
        };
        let t = setTimeout(tick, opts.slow?.[child.id] ?? 5);
        stop = () => {
          clearTimeout(t);
          cancelled.push(name(child.id));
          end("cancelled");
        };
      });
      return { done, cancel: () => stop?.() };
    },
  };
  return { world, log, store, cancelled, peak: () => peak };
}

const orchestrate = (p: Task, world: XlWorld, resume = false) => {
  const saved: Task[] = [];
  const o = new XlOrchestrator(p, { workflow, world, save: (t) => saved.push(t), resume });
  return { o, saved };
};

const timeline = (t: Task) => t.run?.steps.map((s) => `${s.id}:${s.status}`);

/**
 * X-13 part 2b: the outcome and the labels of the steps this run wrote (from `from` on) have refs, and every ref says
 * in English exactly what its text says. A note goes without one only when it isn't the app's words: the task branch's
 * name, or a sub-task's outcome copied from a record that has none.
 */
function assertRefs(t: Task, from = 0) {
  const run = t.run;
  assert.ok(run?.outcome !== undefined && run.outcomeRef, `the outcome has a ref: ${run?.outcome}`);
  assert.equal(resultEnglish(run.outcomeRef), run.outcome);
  for (const s of run.steps.slice(from)) {
    assert.ok(s.labelRef, `${s.id} has a label ref`);
    assert.equal(resultEnglish(s.labelRef), s.label);
    if (s.noteRef) assert.equal(resultEnglish(s.noteRef), s.note, s.id);
    else if (s.note) assert.ok(s.kind === "setup" || s.kind === "subtask", `${s.id}'s note has no ref: ${s.note}`);
  }
}

/** Renders with the app in Bahasa Indonesia, then back in English. */
async function inIndonesian<T>(f: () => T): Promise<T> {
  await setLanguage("id");
  try {
    return f();
  } finally {
    await setLanguage("en");
  }
}

const rendered = (ref: MessageRef | undefined) => (ref ? resultText(ref) : "(no ref)");

describe("XL runs", () => {
  it("runs sub-tasks in dependency order, two at once, merges each, then the integration gates", async () => {
    const f = fakeWorld([task(A), task(B), task(C, { dependsOn: [A] })], { until: { [B]: "remove C" } });
    const { o } = orchestrate(parent(), f.world);
    const done = await o.run();
    assert.equal(done.state, "done", done.run?.outcome);
    assert.equal(f.peak(), 2, "never more than maxParallel");
    assert.deepEqual(f.log, [
      "worktree P from h0",
      "worktree A from h0",
      "worktree B from h0",
      "run A",
      "run B",
      "commit A",
      "merge A",
      "remove A",
      "worktree C from after-A",
      "run C",
      "commit C",
      "merge C",
      "remove C",
      "commit B",
      "merge B",
      "remove B",
    ]);
    assert.deepEqual(timeline(done), [
      "setup:done",
      "baseline:done",
      "subtask-1:done",
      "subtask-2:done",
      "merge-1:done",
      "subtask-3:done",
      "merge-3:done",
      "merge-2:done",
      "integration:done",
    ]);
    assert.equal(done.run?.costUsd, 0.30000000000000004);
    assert.equal(done.worktree?.branch, `agentchainer/${PARENT}`);
    assert.equal(f.store.get(A)?.worktree?.removed, true);
    assert.match(done.run?.outcome ?? "", /^Every sub-task was merged into agentchainer\//);
    assertRefs(done);
  });

  it("goes on when a merged sub-task's worktree can't be removed yet, and leaves it for Clean up", async () => {
    const f = fakeWorld([task(A), task(B), task(C, { dependsOn: [A] })], { busy: [A] });
    const { o } = orchestrate(parent(), f.world);
    const done = await o.run();
    assert.equal(done.state, "done", done.run?.outcome);
    assert.equal(timeline(done)?.at(-1), "integration:done");
    assert.match(
      done.run?.steps.find((s) => s.id === "merge-1")?.note ?? "",
      /^Merged\. Its worktree is left for Clean up\.$/,
    );
    assert.equal(f.store.get(A)?.worktree?.removed, undefined, "still there for Clean up");
    assert.equal(f.store.get(C)?.worktree?.removed, true);
    assertRefs(done);
  });

  it("starts nothing new after a sub-task fails, lets the running one finish, and names it", async () => {
    const f = fakeWorld([task(A), task(B), task(C, { dependsOn: [A] })], {
      ends: { [A]: "failed" },
      slow: { [B]: 20 },
    });
    const { o } = orchestrate(parent(), f.world);
    const done = await o.run();
    assert.equal(done.state, "failed");
    assert.ok(!f.log.includes("run C"), "C waits for A, which failed");
    assert.ok(f.log.includes("merge B"), "B was running and finished: it's merged");
    assert.match(done.run?.outcome ?? "", /^Sub-task 1 \(A\) failed: test still failing.*then Continue\.$/);
    assertRefs(done);
  });

  it("continues: merged sub-tasks are skipped, an accepted one is merged as it is, a failed one runs again", async () => {
    const before = parent({
      state: "failed",
      worktree: { path: `/wt/${PARENT}`, branch: `agentchainer/${PARENT}`, base: "h0", untracked: [] },
    });
    if (!before.run) throw new Error("no run");
    before.run.steps = [
      { id: "setup", step: "setup", label: "Task branch", kind: "setup", status: "done", startedAt: "", costUsd: 0 },
      { id: "baseline", step: "baseline", label: "b", kind: "baseline", status: "done", startedAt: "", costUsd: 0 },
      {
        id: "merge-1",
        step: "merge-1",
        label: "m",
        kind: "merge",
        status: "done",
        taskId: A,
        startedAt: "",
        costUsd: 0,
      },
    ];
    const wt = (id: string) => ({ path: `/wt/${id}`, branch: `agentchainer/${id}`, base: "h0", untracked: [] });
    const f = fakeWorld([
      task(A, { state: "done", worktree: { ...wt(A), removed: true } }),
      task(B, { state: "accepted", worktree: wt(B) }),
      task(C, { state: "failed", dependsOn: [A], worktree: wt(C) }),
    ]);
    f.world.worktree(PARENT, "h0");
    f.world.worktree(B, "h0");
    f.world.worktree(C, "h0");
    f.log.length = 0;
    const { o } = orchestrate(before, f.world);
    const done = await o.run();
    assert.equal(done.state, "done", done.run?.outcome);
    assert.deepEqual(f.log, ["commit B", "merge B", "remove B", "run C", "commit C", "merge C", "remove C"]);
    assert.equal(
      done.run?.steps.find((s) => s.taskId === B && s.kind === "merge")?.note,
      "Merged; it was accepted with risk.",
    );
    assertRefs(done, 3);
  });

  it("stops on a merge conflict and leaves it for the user", async () => {
    const f = fakeWorld([task(A), task(B)], { conflicts: { [B]: ["src/cart.js"] } });
    const { o } = orchestrate(parent({ subtasks: [A, B] }), f.world);
    const done = await o.run();
    assert.equal(done.state, "failed");
    assert.match(done.run?.outcome ?? "", /^Merging sub-task 2 \(B\) conflicts in src\/cart\.js\. .*then Continue\.$/);
    assert.equal(done.run?.steps.find((s) => s.id === "merge-2")?.status, "failed");
    assertRefs(done);
  });

  it("judges the merged branch by the baseline: old failures need accepting, new ones fail it", async () => {
    const old = fakeWorld([task(A)], { baseline: [gate("test", 1)], integration: [gate("test", 1)] });
    const first = await orchestrate(parent({ subtasks: [A] }), old.world).o.run();
    assert.equal(first.state, "failed");
    assert.match(first.run?.outcome ?? "", /^test was already failing before the task/);
    assert.equal(first.run?.steps.find((s) => s.kind === "baseline")?.note, "Already failing: test.");
    assertRefs(first);

    const fresh = fakeWorld([task(A)], { integration: [gate("lint", 1)] });
    const second = await orchestrate(parent({ subtasks: [A] }), fresh.world).o.run();
    assert.equal(second.state, "failed");
    assert.match(second.run?.outcome ?? "", /fails lint, which passed before the task\.$/);
    assertRefs(second);

    const both = [gate("test", 1), gate("lint", 1)];
    const two = fakeWorld([task(A)], { baseline: both, integration: both });
    const third = await orchestrate(parent({ subtasks: [A] }), two.world).o.run();
    assert.equal(
      third.run?.outcome,
      "test, lint were already failing before the task and still fail. Accept the risk if that's expected.",
    );
    assertRefs(third);

    const none = fakeWorld([task(A)], { integration: [] });
    const fourth = await orchestrate(parent({ subtasks: [A] }), none.world).o.run();
    assert.equal(fourth.state, "unverified");
    assert.equal(fourth.run?.steps.at(-1)?.note, "No gates to run.");
    assertRefs(fourth);
  });

  it("fails before any sub-task when the task branch's setup fails", async () => {
    const f = fakeWorld([task(A)], { setupFails: true });
    const done = await orchestrate(parent({ subtasks: [A] }), f.world).o.run();
    assert.equal(done.state, "failed");
    assert.match(done.run?.outcome ?? "", /^Setting up the task branch failed: `pnpm install` exited 1 in 1\.0 s$/);
    assert.ok(!f.log.some((l) => l.startsWith("run")));
    assertRefs(done);
  });

  it("stops the running sub-tasks on Stop", async () => {
    const f = fakeWorld([task(A), task(B)], { slow: { [A]: 1000, [B]: 1000 } });
    const { o } = orchestrate(parent({ subtasks: [A, B] }), f.world);
    const running = o.run();
    await new Promise((r) => setTimeout(r, 20));
    o.cancel();
    const done = await running;
    assert.equal(done.state, "cancelled");
    assert.deepEqual(f.cancelled.sort(), ["A", "B"]);
    assert.ok(!f.log.some((l) => l.startsWith("merge")));
    assert.equal(done.run?.outcome, "Stopped by the user. The worktrees are left as they are.");
    assertRefs(done);
  });
});

describe("XL results in the app's language (X-13 part 2b)", () => {
  it("words a sub-task that didn't end Done in one language, down to its setup's exit code", async () => {
    const f = fakeWorld([task(A)], { setupFailsIn: [A] });
    const done = await orchestrate(parent({ subtasks: [A] }), f.world).o.run();
    assertRefs(done);
    const step = done.run?.steps.find((s) => s.kind === "subtask");
    assert.equal(
      done.run?.outcome,
      "Sub-task 1 (A) failed: Setup failed: `pnpm install` exited 1 in 1.0 s. Open it to run it again or accept its risk, then Continue.",
    );
    assert.equal(step?.note, "Setup failed: `pnpm install` exited 1 in 1.0 s");
    const indonesian = await inIndonesian(() => [done.run?.outcomeRef, step?.labelRef, step?.noteRef].map(rendered));
    assert.deepEqual(indonesian, [
      "Sub-task 1 (A) gagal: Setup gagal: `pnpm install` selesai dengan exit code 1 dalam 1.0 dtk. Buka sub-task itu untuk menjalankannya lagi atau menerima risikonya, lalu Teruskan.",
      "Sub-task 1 (A)",
      "Setup gagal: `pnpm install` selesai dengan exit code 1 dalam 1.0 dtk",
    ]);
  });

  it("quotes a sub-task's own outcome by its ref, so it's shown in the same language", async () => {
    // Stands in for the outcome the sub-task's run wrote; any result does.
    const own = result("xl.outcome.waiting");
    const f = fakeWorld([task(A)], { ends: { [A]: "unverified" }, failedOutcome: own });
    const done = await orchestrate(parent({ subtasks: [A] }), f.world).o.run();
    assertRefs(done);
    const step = done.run?.steps.find((s) => s.kind === "subtask");
    assert.deepEqual(step?.noteRef, own.ref, "the parent's step keeps the child's ref");
    assert.deepEqual(done.run?.outcomeRef?.params?.why, own.ref);
    assert.match(done.run?.outcome ?? "", /^Sub-task 1 \(A\) wasn't verified: Some sub-tasks wait for others/);
    assert.match(
      await inIndonesian(() => rendered(done.run?.outcomeRef)),
      /^Sub-task 1 \(A\) belum diverifikasi: Beberapa sub-task menunggu sub-task lain yang tidak dapat berjalan\.\. Buka sub-task itu/,
    );
  });

  it("keeps the ref of git's failure to merge, and git's own output as it is", async () => {
    const failed = result("xl.note.gitMergeFailed", { output: "fatal: refusing to merge unrelated histories" });
    const f = fakeWorld([task(A)], {
      mergeThrows: { [A]: Object.assign(new Error(failed.text), { ref: failed.ref }) },
    });
    const done = await orchestrate(parent({ subtasks: [A] }), f.world).o.run();
    assert.equal(done.state, "failed");
    assertRefs(done);
    assert.equal(
      done.run?.outcome,
      "Sub-task 1 (A) couldn't be merged: git merge failed: fatal: refusing to merge unrelated histories",
    );
    assert.deepEqual(done.run?.steps.find((s) => s.kind === "merge")?.noteRef, failed.ref);
    assert.equal(
      await inIndonesian(() => rendered(done.run?.outcomeRef)),
      "Sub-task 1 (A) tidak dapat di-merge: git merge gagal: fatal: refusing to merge unrelated histories",
    );
  });

  it("joins the task branch's setup notes, each with its own ref", async () => {
    const f = fakeWorld([task(A)], { setupRuns: true });
    const done = await orchestrate(parent({ subtasks: [A] }), f.world).o.run();
    assertRefs(done);
    const setup = done.run?.steps.find((s) => s.kind === "setup");
    assert.equal(setup?.note, `agentchainer/${PARENT}; \`pnpm install\` exited 0 in 2.5 s`);
    assert.equal(
      await inIndonesian(() => rendered(setup?.noteRef)),
      `agentchainer/${PARENT}; \`pnpm install\` selesai dengan exit code 0 dalam 2.5 dtk`,
    );
  });

  it("runs a baseline the app was cut off in again: by its note's key, or by its English in an older record", async () => {
    const baseline = (over: Partial<StepRun>): StepRun => ({
      id: "baseline",
      step: "baseline",
      label: "Gates before the task",
      kind: "baseline",
      status: "failed",
      startedAt: "",
      costUsd: 0,
      ...over,
    });
    const passed = result("xl.note.allPassed");
    const cases: [string, StepRun, boolean][] = [
      ["a record from before refs", baseline({ note: "Interrupted" }), true],
      ["a task run's note", baseline({ note: "Interrupted", noteRef: { key: "run.note.interrupted" } }), true],
      ["the key, whatever the words", baseline({ note: "Cut off", noteRef: { key: "xl.note.interrupted" } }), true],
      ["a baseline that finished", baseline({ status: "done", note: passed.text, noteRef: passed.ref }), false],
      ["a ref that says otherwise", baseline({ note: "Interrupted", noteRef: passed.ref }), false],
    ];
    for (const [what, step, again] of cases) {
      const before = parent({
        subtasks: [A],
        worktree: { path: `/wt/${PARENT}`, branch: `agentchainer/${PARENT}`, base: "h0", untracked: [] },
      });
      if (!before.run) throw new Error("no run");
      before.run.steps = [step];
      const f = fakeWorld([task(A)]);
      f.world.worktree(PARENT, "h0");
      const done = await orchestrate(before, f.world).o.run();
      assert.equal(timeline(done)?.includes("baseline-2:done"), again, what);
    }
  });

  it("marks a step it was cut off in as interrupted, with the note's ref", async () => {
    const before = parent({
      subtasks: [A],
      worktree: { path: `/wt/${PARENT}`, branch: `agentchainer/${PARENT}`, base: "h0", untracked: [] },
    });
    if (!before.run) throw new Error("no run");
    before.run.steps = [
      { id: "baseline", step: "baseline", label: "b", kind: "baseline", status: "running", startedAt: "", costUsd: 0 },
    ];
    const f = fakeWorld([task(A)]);
    f.world.worktree(PARENT, "h0");
    const done = await orchestrate(before, f.world, true).o.run();
    const cut = done.run?.steps[0];
    assert.deepEqual([cut?.status, cut?.note, cut?.noteRef?.key], ["failed", "Interrupted", "xl.note.interrupted"]);
    assert.equal(timeline(done)?.[1], "baseline-2:done", "and runs it again");
  });
});
