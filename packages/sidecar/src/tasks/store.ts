import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type GateKind,
  RpcErrorCode,
  type Task,
  TaskContractSchema,
  TaskIdSchema,
  TaskSchema,
  type TaskSummary,
  TriageSchema,
} from "@agentchainer/protocol";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { RpcFailure } from "../rpc.ts";

/**
 * Task files (M3): `.agentchainer/tasks/<id>/` holds `task.json` (state), `contract.json` and `triage.json`, the
 * hand-off files later steps read. The folder is git-ignored (planner.md §15). Everything read back is validated, and
 * a task folder that isn't a real folder inside the workspace is refused: the files come from a repository, which may
 * not be trustworthy (THREAT_MODEL T-03).
 */

const TASKS = "tasks";
const MetaSchema = TaskSchema.omit({ contract: true, triage: true });

function tasksRoot(root: string): string {
  return path.join(root, AC_DIR, TASKS);
}

/** The task's folder, after checking the id (it becomes part of a path). */
function taskDir(root: string, id: string): string {
  if (!TaskIdSchema.safeParse(id).success) throw new RpcFailure(RpcErrorCode.invalidParams, `Not a task id: ${id}`);
  return path.join(tasksRoot(root), id);
}

/** Refuses a task folder that's a symlink, or that resolves outside the workspace. */
function requireRealDir(root: string, dir: string): void {
  const inside = path.relative(realpathSync(root), realpathSync(dir));
  if (lstatSync(dir).isSymbolicLink() || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new RpcFailure(RpcErrorCode.invalidParams, "The task folder isn't a folder inside the workspace.");
  }
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function newTaskId(now = new Date()): string {
  return `${now.toISOString().slice(0, 10)}-${randomBytes(4).toString("hex")}`;
}

export function createTask(root: string, request: string, availableGates: GateKind[], now = new Date()): Task {
  ensureIgnored(root, `${TASKS}/`);
  const at = now.toISOString();
  const task: Task = {
    id: newTaskId(now),
    request,
    state: "draft",
    createdAt: at,
    updatedAt: at,
    contract: null,
    triage: null,
    availableGates,
    costUsd: 0,
    run: null,
  };
  mkdirSync(taskDir(root, task.id), { recursive: true });
  saveTask(root, task);
  return task;
}

export function saveTask(root: string, task: Task): void {
  const dir = taskDir(root, task.id);
  requireRealDir(root, dir);
  const { contract, triage, ...meta } = TaskSchema.parse(task);
  writeJson(path.join(dir, "task.json"), meta);
  for (const [name, value] of [
    ["contract.json", contract],
    ["triage.json", triage],
  ] as const) {
    const file = path.join(dir, name);
    if (value) writeJson(file, value);
    else rmSync(file, { force: true });
  }
}

export function loadTask(root: string, id: string): Task {
  const dir = taskDir(root, id);
  if (!existsSync(path.join(dir, "task.json"))) throw new RpcFailure(RpcErrorCode.invalidParams, `No task ${id}.`);
  requireRealDir(root, dir);
  const optional = (name: string) => (existsSync(path.join(dir, name)) ? readJson(path.join(dir, name)) : null);
  const meta = MetaSchema.safeParse(readJson(path.join(dir, "task.json")));
  const contract = TaskContractSchema.nullable().safeParse(optional("contract.json"));
  const triage = TriageSchema.nullable().safeParse(optional("triage.json"));
  if (!meta.success || !contract.success || !triage.success || meta.data.id !== id) {
    throw new RpcFailure(RpcErrorCode.invalidParams, `Task ${id} can't be read: its files aren't valid.`);
  }
  return { ...meta.data, contract: contract.data, triage: triage.data };
}

/** This workspace's tasks, newest first. Folders that aren't valid tasks are skipped. */
export function listTasks(root: string): TaskSummary[] {
  const dir = tasksRoot(root);
  if (!existsSync(dir)) return [];
  const tasks: TaskSummary[] = [];
  for (const id of readdirSync(dir)) {
    if (!TaskIdSchema.safeParse(id).success) continue;
    try {
      const t = loadTask(root, id);
      tasks.push({
        id: t.id,
        request: t.request,
        state: t.state,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        costUsd: t.costUsd,
        tier: t.triage?.chosen ?? null,
      });
    } catch {
      // not a valid task: leave it out
    }
  }
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Files steps hand to each other (planner.md §6), kept in the task's folder. */
const HAND_OFF_FILES = new Set(["plan.md", "review.json"]);

export function readTaskFile(root: string, id: string, name: string): string | null {
  if (!HAND_OFF_FILES.has(name)) throw new Error(`Not a task file: ${name}`);
  const file = path.join(taskDir(root, id), name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function writeTaskFile(root: string, id: string, name: string, text: string): void {
  if (!HAND_OFF_FILES.has(name)) throw new Error(`Not a task file: ${name}`);
  const dir = taskDir(root, id);
  requireRealDir(root, dir);
  writeFileSync(path.join(dir, name), text);
}

export function deleteTask(root: string, id: string): void {
  const dir = taskDir(root, id);
  if (!existsSync(dir)) return;
  requireRealDir(root, dir);
  rmSync(dir, { recursive: true, force: true });
}
