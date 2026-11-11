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
import { t } from "../i18n/index.ts";
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
  if (!TaskIdSchema.safeParse(id).success)
    throw new RpcFailure(RpcErrorCode.invalidParams, t("tasks.store.notTaskId", { id }));
  return path.join(tasksRoot(root), id);
}

/** Refuses a task folder that's a symlink, or that resolves outside the workspace. */
function requireRealDir(root: string, dir: string): void {
  const inside = path.relative(realpathSync(root), realpathSync(dir));
  if (lstatSync(dir).isSymbolicLink() || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new RpcFailure(RpcErrorCode.invalidParams, t("tasks.store.folderOutside"));
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
  if (!existsSync(path.join(dir, "task.json")))
    throw new RpcFailure(RpcErrorCode.invalidParams, t("tasks.store.notFound", { id }));
  requireRealDir(root, dir);
  const optional = (name: string) => (existsSync(path.join(dir, name)) ? readJson(path.join(dir, name)) : null);
  const meta = MetaSchema.safeParse(readJson(path.join(dir, "task.json")));
  const contract = TaskContractSchema.nullable().safeParse(optional("contract.json"));
  const triage = TriageSchema.nullable().safeParse(optional("triage.json"));
  if (!meta.success || !contract.success || !triage.success || meta.data.id !== id) {
    throw new RpcFailure(RpcErrorCode.invalidParams, t("tasks.store.unreadable", { id }));
  }
  return { ...meta.data, contract: contract.data, triage: triage.data };
}

/** Every task record in the workspace, sub-tasks and variants included; folders that aren't valid tasks are skipped. */
export function everyTask(root: string): Task[] {
  const dir = tasksRoot(root);
  if (!existsSync(dir)) return [];
  const all: Task[] = [];
  for (const id of readdirSync(dir)) {
    if (!TaskIdSchema.safeParse(id).success) continue;
    try {
      all.push(loadTask(root, id));
    } catch {
      // not a valid task: leave it out
    }
  }
  return all;
}

/**
 * This workspace's tasks, newest first, without XL sub-tasks or the variants a Best-of-N compares (CP-06): those show
 * on their task's page. A variant whose task doesn't list it is shown, so it can be found and deleted. Folders that
 * aren't valid tasks are skipped.
 */
export function listTasks(root: string): TaskSummary[] {
  const all = new Map(everyTask(root).map((t) => [t.id, t]));
  const tasks: TaskSummary[] = [];
  for (const t of all.values()) {
    // An XL task's sub-tasks show on its page, not in the list.
    if (t.parent) continue;
    if (t.variantOf && all.get(t.variantOf.id)?.variants?.includes(t.id)) continue;
    tasks.push({
      id: t.id,
      request: t.request,
      state: t.state,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      costUsd: t.costUsd,
      ...(t.variants?.length ? { variants: t.variants } : {}),
      tier: t.triage?.chosen ?? null,
    });
  }
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Files steps hand to each other (planner.md §6), and the body of the task's PR (M5-02), kept in the task's folder. */
const HAND_OFF_FILES = new Set([
  "plan.md",
  "review.json",
  "summary.md",
  "evidence.json",
  "evidence.md",
  "pr-body.md",
  // A multi-folder task's PR body in another repository (M8-01), written for one folder at a time.
  "pr-body-other.md",
  // The project workflow a run started with (M6-04), so editing the file doesn't change a run under way.
  "workflow.json",
]);

export function readTaskFile(root: string, id: string, name: string): string | null {
  if (!isTaskFile(name)) throw new Error(`Not a task file: ${name}`);
  const file = path.join(taskDir(root, id), name);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** A run's own evidence report, kept when the next run starts (M8-05). */
const RUN_EVIDENCE = /^evidence-\d{1,4}\.(md|json)$/;
const isTaskFile = (name: string) => HAND_OFF_FILES.has(name) || RUN_EVIDENCE.test(name);

export function writeTaskFile(root: string, id: string, name: string, text: string): void {
  if (!isTaskFile(name)) throw new Error(`Not a task file: ${name}`);
  const dir = taskDir(root, id);
  requireRealDir(root, dir);
  writeFileSync(path.join(dir, name), text);
}

/** The files a run leaves for the next steps and rounds (CP-06): what a task takes from the variant it keeps. */
const RUN_FILES = ["plan.md", "review.json", "summary.md", "workflow.json"];

/**
 * Gives task `to` the run files of task `from` (CP-06): each is replaced, or removed when `from` has none, so a
 * tier-S variant (no review) leaves no review of an earlier run behind.
 */
export function copyRunFiles(root: string, from: string, to: string): void {
  for (const name of RUN_FILES) {
    const text = readTaskFile(root, from, name);
    if (text !== null) writeTaskFile(root, to, name, text);
    else {
      const dir = taskDir(root, to);
      requireRealDir(root, dir);
      rmSync(path.join(dir, name), { force: true });
    }
  }
}

export function deleteTask(root: string, id: string): void {
  const dir = taskDir(root, id);
  if (!existsSync(dir)) return;
  requireRealDir(root, dir);
  rmSync(dir, { recursive: true, force: true });
}
