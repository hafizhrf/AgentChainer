import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GateRun, Task } from "@agentchainer/protocol";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun } from "./orchestrator.ts";
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
    slow?: Record<string, number>;
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
    setup: async () =>
      opts.setupFails ? { command: "pnpm install", exitCode: 1, timedOut: false, durationMs: 1000, tail: "ERR" } : null,
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
            },
          };
          store.set(child.id, ended);
          resolve(ended);
        };
        const t = setTimeout(() => end(opts.ends?.[child.id] ?? "done"), opts.slow?.[child.id] ?? 5);
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

describe("XL runs", () => {
  it("runs sub-tasks in dependency order, two at once, merges each, then the integration gates", async () => {
    const f = fakeWorld([task(A), task(B), task(C, { dependsOn: [A] })], { slow: { [B]: 30 } });
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
  });

  it("stops on a merge conflict and leaves it for the user", async () => {
    const f = fakeWorld([task(A), task(B)], { conflicts: { [B]: ["src/cart.js"] } });
    const { o } = orchestrate(parent({ subtasks: [A, B] }), f.world);
    const done = await o.run();
    assert.equal(done.state, "failed");
    assert.match(done.run?.outcome ?? "", /^Merging sub-task 2 \(B\) conflicts in src\/cart\.js\. .*then Continue\.$/);
    assert.equal(done.run?.steps.find((s) => s.id === "merge-2")?.status, "failed");
  });

  it("judges the merged branch by the baseline: old failures need accepting, new ones fail it", async () => {
    const old = fakeWorld([task(A)], { baseline: [gate("test", 1)], integration: [gate("test", 1)] });
    const first = await orchestrate(parent({ subtasks: [A] }), old.world).o.run();
    assert.equal(first.state, "failed");
    assert.match(first.run?.outcome ?? "", /^test was already failing before the task/);
    assert.equal(first.run?.steps.find((s) => s.kind === "baseline")?.note, "Already failing: test.");

    const fresh = fakeWorld([task(A)], { integration: [gate("lint", 1)] });
    const second = await orchestrate(parent({ subtasks: [A] }), fresh.world).o.run();
    assert.equal(second.state, "failed");
    assert.match(second.run?.outcome ?? "", /fails lint, which passed before the task\.$/);
  });

  it("fails before any sub-task when the task branch's setup fails", async () => {
    const f = fakeWorld([task(A)], { setupFails: true });
    const done = await orchestrate(parent({ subtasks: [A] }), f.world).o.run();
    assert.equal(done.state, "failed");
    assert.match(done.run?.outcome ?? "", /^Setting up the task branch failed: `pnpm install` exited 1 in 1\.0 s$/);
    assert.ok(!f.log.some((l) => l.startsWith("run")));
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
  });
});
