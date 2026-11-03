import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { GateRun, Task } from "@agentchainer/protocol";
import { detectWorkspace } from "../detect/detect.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun } from "./orchestrator.ts";
import { normalizeSplit, splitPrompt } from "./split.ts";
import { XlOrchestrator, type XlWorld } from "./xl.ts";

const workflow = LibrarySchema.parse(shipped).xl;
if (!workflow) throw new Error("no XL workflow");

const PARENT = "2026-11-03-00000000";
const APP = "2026-11-03-0000000a";
const API = "2026-11-03-0000000b";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  request: `Do ${id}`,
  state: "ready",
  createdAt: "2026-11-03T00:00:00.000Z",
  updatedAt: "2026-11-03T00:00:00.000Z",
  contract: null,
  triage: null,
  availableGates: ["test"],
  costUsd: 0,
  run: null,
  ...over,
});

const gate = (round: number): GateRun => ({
  kind: "test",
  command: "npm test",
  package: ".",
  exitCode: 0,
  timedOut: false,
  durationMs: 5,
  tail: "",
  round,
  at: "2026-11-03T00:00:00.000Z",
});

describe("an XL task across a workspace's folders (M8-01)", () => {
  it("splits work by folder, keeping only folders the workspace has", () => {
    const subs = normalizeSplit(
      {
        subtasks: [
          { title: "Route", request: "Add the route", tier: "S", dependsOn: [], contract: {}, folder: "api" },
          { title: "Page", request: "Use it", tier: "S", dependsOn: [1], contract: {} },
          { title: "Odd", request: "Elsewhere", tier: "S", dependsOn: [], contract: {}, folder: "web" },
        ],
      },
      ["test"],
      ["api"],
    );
    assert.deepEqual(
      subs.map((s) => [s.title, s.folder]),
      [
        ["Route", "api"],
        ["Page", undefined],
        ["Odd", undefined],
      ],
    );
    const prompt = splitPrompt(
      {
        task: "t",
        objective: "o",
        acceptanceCriteria: [],
        constraints: [],
        outOfScope: [],
        risks: [],
        affectedAreas: [],
        openQuestions: [],
      },
      detectWorkspace(tmpdir()),
      [],
      [{ name: "api", path: "/w/api" }],
    );
    assert.match(prompt, /- api: \/w\/api/);
  });

  it("branches, merges and runs gates for a sub-task in its own folder's repository", async () => {
    const calls: string[] = [];
    const tips = new Map<string, string>();
    const store = new Map<string, Task>([
      [APP, task(APP, { dependsOn: [API] })],
      [API, task(API, { folder: { name: "api", path: "/repo/api" } })],
    ]);
    const where = (repo?: string) => repo ?? "/repo/app";
    const world: XlWorld = {
      worktree: (id, from, repo) => {
        calls.push(`worktree ${id.slice(-1)} in ${where(repo)} from ${from}`);
        return { path: `${where(repo)}/wt/${id}`, branch: `agentchainer/${id}`, code: `${where(repo)}/wt/${id}` };
      },
      codeOf: (p) => p,
      exists: () => true,
      removeWorktree: (p) => calls.push(`remove ${p}`),
      head: () => "h0",
      tip: (b, repo) => tips.get(`${where(repo)}|${b}`) ?? `tip-of-${where(repo)}`,
      setup: async (code) => {
        calls.push(`setup ${code}`);
        return null;
      },
      untracked: () => [],
      gates: async (code, _kinds, round) => {
        calls.push(`gates ${code}`);
        return { runs: [gate(round)], notRun: [] };
      },
      commit: () => "c",
      merge: (code, branch) => {
        calls.push(`merge ${branch.slice(-1)} into ${code}`);
        return { merged: true, conflicts: [] };
      },
      load: (id) => store.get(id) ?? task(id),
      save: (c) => store.set(c.id, c),
      runChild: (child) => ({ done: Promise.resolve({ ...child, state: "done" }), cancel: () => undefined }),
    };
    const parent = task(PARENT, {
      state: "running",
      subtasks: [API, APP],
      folders: [
        {
          name: "api",
          path: "/repo/api",
          worktree: { path: `/repo/api/wt/${PARENT}`, branch: `agentchainer/${PARENT}`, base: "a0", untracked: [] },
        },
      ],
      run: newRun(workflow, { permissionMode: "default", base: null, untrackedAtStart: [] }, new Date()),
    });
    const end = await new XlOrchestrator(parent, { workflow, world, save: () => undefined }).run();

    assert.equal(end.state, "done", end.run?.outcome);
    assert.ok(calls.includes(`setup /repo/api/wt/${PARENT}`), "the task's branch in api is set up");
    assert.ok(calls.includes("worktree b in /repo/api from tip-of-/repo/api"), "api's sub-task branches in api");
    assert.ok(calls.includes(`merge b into /repo/api/wt/${PARENT}`), "and merges into the task's branch there");
    assert.ok(calls.includes(`merge a into /repo/app/wt/${PARENT}`), "the app's sub-task merges into the app's");
    assert.ok(calls.includes(`remove /repo/api/wt/${API}`));
    // The baseline and integration gates run in both folders; api's carry its name.
    assert.equal(calls.filter((c) => c === `gates /repo/api/wt/${PARENT}`).length, 2);
    assert.deepEqual(
      end.run?.gates.map((g) => [g.package, g.folder]),
      [
        [".", undefined],
        ["api", "api"],
      ],
    );
  });
});
