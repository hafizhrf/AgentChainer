import {
  type PermissionMode,
  RpcErrorCode,
  type Task,
  type TaskContract,
  type TaskSummary,
  type Tier,
  type Triage,
} from "@agentchainer/protocol";
import { AC_DIR } from "../ac-dir.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { RpcFailure } from "../rpc.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { listFiles } from "../workspace.ts";
import { availableGates, draftContract, normalizeContract } from "./contract.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun, Orchestrator } from "./orchestrator.ts";
import { type SessionHost, sessionRunner, startBase } from "./runner.ts";
import { createTask, deleteTask, listTasks, loadTask, readTaskFile, saveTask, writeTaskFile } from "./store.ts";
import { classify, classifyPrompt, signals, triageRecord } from "./triage.ts";

/**
 * The task operations behind `task.*` (M3-02, M3-03). A task is drafted (contract, then triage on the draft), edited
 * and re-triaged as needed, then approved with its tier: `draft` → `ready`. Running it arrives with M3-06.
 */

export type Claude = { sdk: AgentSdkModule; claudePath: string };

const invalid = (message: string) => new RpcFailure(RpcErrorCode.invalidParams, message);

/** Drafts and triages in progress, by task id, so `task.cancel` can stop them. */
const running = new Map<string, AbortController>();

async function cancellable<T>(id: string, fn: (controller: AbortController) => Promise<T>): Promise<T> {
  if (running.has(id)) throw invalid("Claude is already working on this task's contract.");
  const controller = new AbortController();
  running.set(id, controller);
  try {
    return await fn(controller);
  } catch (err) {
    if (controller.signal.aborted) throw new RpcFailure(RpcErrorCode.cancelled, "Stopped.");
    throw err;
  } finally {
    running.delete(id);
  }
}

/** Stops a draft, a triage or a run in progress. */
export function cancelTask(id: string): boolean {
  const controller = running.get(id);
  controller?.abort();
  return controller !== undefined || stopRun(id);
}

function requireDraft(task: Task): void {
  if (task.state !== "draft") throw invalid("The contract is approved. Revise it to make changes.");
}

export function newTask(root: string, request: string): Task {
  const text = request.trim();
  if (!text) throw invalid("Describe the task first.");
  return createTask(root, text, availableGates(detectWorkspace(root), root));
}

async function triage(
  root: string,
  request: string,
  contract: TaskContract,
  claude: Claude,
  controller: AbortController,
): Promise<{ triage: Triage; costUsd: number }> {
  const listing = listFiles(root);
  const found = signals({
    request,
    contract,
    profile: detectWorkspace(root),
    // AgentChainer's own files aren't part of the project's size or scope.
    files: listing.files.map((f) => f.path).filter((f) => !f.startsWith(`${AC_DIR}/`)),
    truncated: listing.truncated,
  });
  const model = await classify(
    claude.sdk,
    claude.claudePath,
    root,
    classifyPrompt(request, contract, found.signals),
    controller,
  );
  return { triage: triageRecord(found, model), costUsd: model.costUsd };
}

/** Drafts the contract from the request, then triages the draft. The spend is recorded even when drafting fails. */
export async function draftTask(root: string, id: string, claude: Claude, model?: string): Promise<Task> {
  const task = loadTask(root, id);
  requireDraft(task);
  return cancellable(id, async (controller) => {
    const profile = detectWorkspace(root);
    const draft = await draftContract(claude.sdk, claude.claudePath, root, task.request, profile, {
      ...(model ? { model } : {}),
      abortController: controller,
    });
    const drafted: Task = {
      ...task,
      availableGates: availableGates(profile, root),
      costUsd: task.costUsd + draft.costUsd,
      updatedAt: new Date().toISOString(),
    };
    if (!draft.contract) {
      saveTask(root, drafted);
      throw new Error(draft.error ?? "Drafting failed.");
    }
    const t = await triage(root, task.request, draft.contract, claude, controller);
    const next: Task = {
      ...drafted,
      contract: draft.contract,
      triage: t.triage,
      costUsd: drafted.costUsd + t.costUsd,
      updatedAt: new Date().toISOString(),
    };
    saveTask(root, next);
    return next;
  });
}

/** Saves the user's edits to the draft and triages it again. */
export async function retriageTask(root: string, id: string, edited: TaskContract, claude: Claude): Promise<Task> {
  const task = loadTask(root, id);
  requireDraft(task);
  const contract = normalizeContract(task.request, edited, task.availableGates);
  return cancellable(id, async (controller) => {
    const t = await triage(root, task.request, contract, claude, controller);
    const next: Task = {
      ...task,
      contract,
      triage: t.triage,
      costUsd: task.costUsd + t.costUsd,
      updatedAt: new Date().toISOString(),
    };
    saveTask(root, next);
    return next;
  });
}

const comparable = (c: TaskContract) => JSON.stringify({ ...c, approvedAt: undefined });

/**
 * Approves the contract and the tier together. The contract must be the one that was triaged; a tier other than the
 * proposal needs a reason, which stays in the triage record for the evidence report.
 */
export function approveTask(
  root: string,
  id: string,
  edited: TaskContract,
  tier: Tier,
  reason: string | undefined,
  budgetUsd: number,
  now = new Date(),
): Task {
  const task = loadTask(root, id);
  requireDraft(task);
  if (!task.contract || !task.triage) throw invalid("Draft the contract first.");
  const contract = normalizeContract(task.request, edited, task.availableGates);
  if (comparable(contract) !== comparable(task.contract)) {
    throw invalid("The contract changed after triage. Run triage again before approving.");
  }
  if (!contract.objective) throw invalid("Write the objective first.");
  if (contract.acceptanceCriteria.length === 0) throw invalid("Add at least one acceptance criterion.");
  const why = reason?.trim() ?? "";
  if (tier !== task.triage.proposed && !why) {
    throw invalid(`Say why this task should be ${tier} rather than the proposed ${task.triage.proposed}.`);
  }
  const { override: _previous, ...proposal } = task.triage;
  const at = now.toISOString();
  const next: Task = {
    ...task,
    state: "ready",
    contract: { ...contract, approvedAt: at },
    triage: {
      ...proposal,
      chosen: tier,
      budgetUsd,
      ...(tier !== proposal.proposed ? { override: { reason: why } } : {}),
    },
    updatedAt: at,
  };
  saveTask(root, next);
  return next;
}

/** Reopens an approved contract for editing. Unchanged, it can be approved again without a new triage. */
export function reviseTask(root: string, id: string, now = new Date()): Task {
  const task = loadTask(root, id);
  if (runs.has(id)) throw invalid("The task is running. Stop it first.");
  if (task.state === "draft" || !task.contract) return task;
  const { approvedAt: _approved, ...contract } = task.contract;
  // A new contract makes the last run's results meaningless.
  const next: Task = { ...task, state: "draft", contract, run: null, updatedAt: now.toISOString() };
  saveTask(root, next);
  return next;
}

/* ---------- Runs (M3-06) ---------- */

const library = LibrarySchema.parse(shipped);

/** Runs in progress in this sidecar, by task id. */
const runs = new Map<string, Orchestrator>();
/** Set while the sidecar shuts down: a run cut off then is left `running`, so it reads back as interrupted. */
let shuttingDown = false;

/** A run that says it's running but has no orchestrator here was cut off (the app quit): it's `interrupted`. */
export function present(task: Task): Task {
  return task.state === "running" && !runs.has(task.id) ? { ...task, state: "interrupted" } : task;
}

export function listTasksLive(root: string): TaskSummary[] {
  return listTasks(root).map((t) => (t.state === "running" && !runs.has(t.id) ? { ...t, state: "interrupted" } : t));
}

export function deleteTaskSafe(root: string, id: string): void {
  if (runs.has(id)) throw invalid("The task is running. Stop it first.");
  deleteTask(root, id);
}

/** Tasks a new run can start from. */
const STARTABLE = new Set<Task["state"]>(["ready", "done", "failed", "unverified", "cancelled"]);

function launch(root: string, task: Task, host: SessionHost, notify: (task: Task) => void, resume: boolean): void {
  const workflow = Object.values(library.workflows).find((w) => w.id === task.run?.workflow.id);
  if (!workflow) throw invalid(`The workflow ${task.run?.workflow.id} isn't in this version of the app.`);
  const orchestrator = new Orchestrator(task, {
    workflow,
    runner: sessionRunner(root, task, library, host),
    files: {
      read: (name) => readTaskFile(root, task.id, name),
      write: (name, text) => writeTaskFile(root, task.id, name, text),
    },
    save: (t) => {
      if (shuttingDown) return;
      saveTask(root, t);
      notify(present(t));
    },
    resume,
  });
  runs.set(task.id, orchestrator);
  void orchestrator.run().finally(() => {
    runs.delete(task.id);
    if (!shuttingDown) notify(present(orchestrator.current));
  });
}

/** Starts a run of an approved task (S or M for now). It continues in the background and reports through `notify`. */
export function startTask(
  root: string,
  id: string,
  host: SessionHost,
  opts: { permissionMode: PermissionMode; model?: string },
  notify: (task: Task) => void,
  now = new Date(),
): Task {
  const task = present(loadTask(root, id));
  if (runs.has(id)) throw invalid("The task is already running.");
  if (!STARTABLE.has(task.state) || !task.contract?.approvedAt || !task.triage) {
    throw invalid("Approve the contract and the tier first.");
  }
  const workflow = library.workflows[task.triage.chosen];
  if (!workflow) {
    throw invalid(`${task.triage.chosen} tasks can run in a later update; S and M tasks can run now.`);
  }
  const started: Task = {
    ...task,
    state: "running",
    run: newRun(workflow, { ...opts, ...startBase(root) }, now),
    updatedAt: now.toISOString(),
  };
  saveTask(root, started);
  notify(started);
  launch(root, started, host, notify, false);
  return started;
}

/** Continues an interrupted run from the step it stopped in. */
export function resumeTask(root: string, id: string, host: SessionHost, notify: (task: Task) => void): Task {
  const task = present(loadTask(root, id));
  if (task.state !== "interrupted" || !task.run) throw invalid("Only an interrupted run can be resumed.");
  const running: Task = { ...task, state: "running" };
  launch(root, running, host, notify, true);
  notify(running);
  return running;
}

/** Stops a running task. */
export function stopRun(id: string): boolean {
  const orchestrator = runs.get(id);
  orchestrator?.cancel();
  return orchestrator !== undefined;
}

/** The sidecar is shutting down: runs still going stay `running` on disk and read back as interrupted. */
export function shutdownRuns(): void {
  shuttingDown = true;
}
