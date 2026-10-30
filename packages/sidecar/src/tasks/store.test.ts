import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { TaskContract } from "@agentchainer/protocol";
import { createTask, deleteTask, listTasks, loadTask, newTaskId, saveTask } from "./store.ts";

const contract: TaskContract = {
  task: "Fix the typo",
  objective: "The README spells the name right.",
  acceptanceCriteria: [{ id: "c1", text: "README says AgentChainer", check: "review" }],
  constraints: [],
  outOfScope: [],
  risks: [],
  affectedAreas: ["README.md"],
  openQuestions: [],
};

describe("task store", () => {
  let root = "";
  let outside = "";
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ac-tasks-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ac-outside-")));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("makes date-prefixed ids", () => {
    assert.match(newTaskId(new Date("2026-10-30T12:00:00Z")), /^2026-10-30-[0-9a-f]{8}$/);
  });

  it("creates a task, keeps the folder out of git, and round-trips its files", () => {
    const task = createTask(root, "Fix the typo", ["test"], new Date("2026-10-30T10:00:00Z"));
    assert.equal(task.state, "draft");
    assert.equal(readFileSync(join(root, ".agentchainer", ".gitignore"), "utf8"), "tasks/\n");
    assert.deepEqual(loadTask(root, task.id), task);

    const withContract = { ...task, contract, costUsd: 0.12 };
    saveTask(root, withContract);
    assert.deepEqual(loadTask(root, task.id), withContract);
    assert.ok(readFileSync(join(root, ".agentchainer", "tasks", task.id, "contract.json"), "utf8").includes("README"));
    // Clearing the contract removes its file.
    saveTask(root, task);
    assert.equal(loadTask(root, task.id).contract, null);
  });

  it("lists tasks newest first and skips folders that aren't valid tasks", () => {
    const older = createTask(root, "Older", [], new Date("2026-10-29T09:00:00Z"));
    const dir = join(root, ".agentchainer", "tasks");
    mkdirSync(join(dir, "not-a-task"));
    mkdirSync(join(dir, "2026-10-31-deadbeef"));
    writeFileSync(join(dir, "2026-10-31-deadbeef", "task.json"), '{"id":"2026-10-31-deadbeef","state":"hacked"}');
    const listed = listTasks(root).map((t) => t.request);
    assert.deepEqual(listed, ["Fix the typo", "Older"]);
    assert.throws(() => loadTask(root, "2026-10-31-deadbeef"), /can't be read/);
    deleteTask(root, older.id);
    assert.deepEqual(
      listTasks(root).map((t) => t.request),
      ["Fix the typo"],
    );
  });

  it("refuses ids that could leave the tasks folder", () => {
    for (const id of ["../x", "2026-10-30-../../a", "", "2026-10-30-ABCDEF12"]) {
      assert.throws(() => loadTask(root, id), /Not a task id/);
    }
  });

  it("refuses a task folder that is a symlink out of the workspace", () => {
    const id = "2026-10-30-0badc0de";
    mkdirSync(join(outside, "planted"));
    writeFileSync(
      join(outside, "planted", "task.json"),
      JSON.stringify({
        id,
        request: "x",
        state: "draft",
        createdAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
        availableGates: [],
        costUsd: 0,
      }),
    );
    symlinkSync(join(outside, "planted"), join(root, ".agentchainer", "tasks", id), "dir");
    assert.throws(() => loadTask(root, id), /isn't a folder inside the workspace/);
    assert.ok(!listTasks(root).some((t) => t.id === id));
    assert.throws(() => deleteTask(root, id), /isn't a folder inside the workspace/);
    assert.ok(readFileSync(join(outside, "planted", "task.json"), "utf8").includes(id), "the target is untouched");
  });
});
