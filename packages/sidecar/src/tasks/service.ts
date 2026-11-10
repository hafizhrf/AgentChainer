import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  type AgentRoles,
  MAX_CI_FIXES,
  type MergeGate,
  type MessageRef,
  type PermissionMode,
  type ResultKey,
  RpcErrorCode,
  resultEnglish,
  resultRef,
  resultText,
  type Task,
  type TaskContract,
  type TaskFolder,
  type TaskRun,
  type TaskSummary,
  type Tier,
  type Triage,
} from "@agentchainer/protocol";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { stringify as stringifyYaml } from "yaml";
import { AC_DIR } from "../ac-dir.ts";
import { agentsNeeded } from "../backends/choose.ts";
import { budgetFor, readDefaults } from "../backends/defaults.ts";
import { findTool, toolsDir } from "../bootstrap/tools.ts";
import { listDeploys } from "../deploy/service.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { branches, merge, pushBranch } from "../git.ts";
import {
  createPr,
  failedJobLog,
  findPr,
  type Gh,
  ghCredentialConfig,
  githubStatus,
  jobOf,
  mergeMethods,
  mergePullRequest,
  prChecks,
  prState,
} from "../github.ts";
import { t } from "../i18n/index.ts";
import { log, RpcFailure } from "../rpc.ts";
import { runAsync } from "../run-async.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { git, listFiles, repoOf } from "../workspace.ts";
import { availableGates, draftContract, normalizeContract } from "./contract.ts";
import {
  buildEvidence,
  type Evidence,
  type FileChange,
  named,
  notScanned,
  renderEvidence,
  type SecretsScan,
  STATE_TEXT,
  sectionLines,
} from "./evidence.ts";
import { branchFolders, folderDirs, folderFileStats, removeFolderWorktrees, taskFolders } from "./folders.ts";
import { generateWorkflow } from "./generate-workflow.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema, type Workflow, WorkflowSchema, type XlWorkflow, XlWorkflowSchema } from "./library.ts";
import { newRun, Orchestrator, type OrchestratorDeps, parseReview } from "./orchestrator.ts";
import {
  type EffectiveLibrary,
  effectiveLibrary,
  parseProjectWorkflow,
  type WorkflowRef,
  workflowRef,
} from "./project-workflows.ts";
import { result } from "./result.ts";
import { runEvidenceFile, withPastRun } from "./run-history.ts";
import { changedPaths, fileStats, type SessionHost, sessionRunner, startBase, untracked } from "./runner.ts";

/** The agents' CLIs as a person knows them. */
const AGENT_NAME = { claude: "Claude", codex: "Codex", agy: "the Antigravity CLI (agy)" } as const;

import { semgrepScan, trivyScan } from "./scanners.ts";
import { proposeSplit } from "./split.ts";
import { createTask, deleteTask, listTasks, loadTask, readTaskFile, saveTask, writeTaskFile } from "./store.ts";
import { classify, classifyPrompt, DEFAULT_BUDGET_USD, signals, triageRecord } from "./triage.ts";
import {
  addWorktree,
  branchOf,
  codeRootIn,
  commitAll,
  deleteBranch,
  hasTrackedChanges,
  headOf,
  removeWorktree,
  worktreePath,
} from "./worktree.ts";
import { type SetupRun, setupResult, XlOrchestrator } from "./xl.ts";
import { gitWorld, setupWorktree } from "./xl-world.ts";

/**
 * The task operations behind `task.*` (M3-02, M3-03). A task is drafted (contract, then triage on the draft), edited
 * and re-triaged as needed, then approved with its tier: `draft` → `ready`. Running it arrives with M3-06.
 */

export type Claude = { sdk: AgentSdkModule; claudePath: string };

const invalid = (message: string) => new RpcFailure(RpcErrorCode.invalidParams, message);

/** Drafts and triages in progress, by task id, so `task.cancel` can stop them. */
const running = new Map<string, AbortController>();

async function cancellable<T>(id: string, fn: (controller: AbortController) => Promise<T>): Promise<T> {
  if (running.has(id)) throw invalid(t("tasks.service.alreadyDrafting"));
  const controller = new AbortController();
  running.set(id, controller);
  try {
    return await fn(controller);
  } catch (err) {
    if (controller.signal.aborted) throw new RpcFailure(RpcErrorCode.cancelled, t("tasks.service.stopped"));
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
  if (task.state !== "draft") throw invalid(t("tasks.service.contractApproved"));
}

/**
 * A new draft task; `context` is the chat it's made from (UX-13), which drafting reads, and `folders` a multi-folder
 * workspace's other folders (M8-01), which it works across.
 */
export function newTask(root: string, request: string, context?: string, folders: string[] = []): Task {
  const text = request.trim();
  if (!text) throw invalid(t("tasks.service.describeFirst"));
  const task = createTask(root, text, availableGates(detectWorkspace(root), root));
  if (!context?.trim() && !folders.length) return task;
  const extra: Task = {
    ...task,
    ...(context?.trim() ? { chatContext: context.trim() } : {}),
    ...(folders.length ? { folders: taskFolders(root, folders) } : {}),
  };
  saveTask(root, extra);
  return extra;
}

/** Drafting's messages, so the thread shows what it reads (UX-13). */
export type DraftListener = (m: SDKMessage) => void;

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
  const budgetOf = (tier: Tier) => budgetFor(root, tier, DEFAULT_BUDGET_USD[tier]);
  return { triage: triageRecord(found, model, new Date(), budgetOf), costUsd: model.costUsd };
}

/**
 * Drafts the contract from the request (and the chat it came from), then triages the draft. With `feedback`, it drafts
 * again from the current contract and the person's reply (UX-13). The spend is recorded even when drafting fails.
 */
export async function draftTask(
  root: string,
  id: string,
  claude: Claude,
  model?: string,
  listen?: DraftListener,
  feedback?: string,
): Promise<Task> {
  const task = loadTask(root, id);
  requireDraft(task);
  if (feedback !== undefined && !task.contract) throw invalid(t("tasks.service.draftFirst"));
  return cancellable(id, async (controller) => {
    const profile = detectWorkspace(root);
    const draft = await draftContract(claude.sdk, claude.claudePath, root, task.request, profile, {
      ...(model ? { model } : {}),
      abortController: controller,
      extra: {
        ...(task.chatContext ? { context: task.chatContext } : {}),
        ...(feedback !== undefined && task.contract ? { current: task.contract, feedback } : {}),
        ...(task.folders?.length ? { folders: task.folders.map(({ name, path }) => ({ name, path })) } : {}),
      },
      ...(listen ? { onMessage: listen } : {}),
    });
    const drafted: Task = {
      ...task,
      availableGates: availableGates(profile, root),
      costUsd: task.costUsd + draft.costUsd,
      updatedAt: new Date().toISOString(),
    };
    if (!draft.contract) {
      saveTask(root, drafted);
      throw new Error(draft.error ?? t("tasks.service.draftingFailed"));
    }
    const triaged = await triage(root, task.request, draft.contract, claude, controller);
    const next: Task = {
      ...drafted,
      contract: draft.contract,
      triage: triaged.triage,
      costUsd: drafted.costUsd + triaged.costUsd,
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
    const triaged = await triage(root, task.request, contract, claude, controller);
    const next: Task = {
      ...task,
      contract,
      triage: triaged.triage,
      costUsd: task.costUsd + triaged.costUsd,
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
  budgetUsd: number | null,
  now = new Date(),
): Task {
  const task = loadTask(root, id);
  requireDraft(task);
  if (!task.contract || !task.triage) throw invalid(t("tasks.service.draftFirst"));
  const contract = normalizeContract(task.request, edited, task.availableGates);
  if (comparable(contract) !== comparable(task.contract)) {
    throw invalid(t("tasks.service.contractChanged"));
  }
  if (task.parent && tier === "XL") throw invalid(t("tasks.service.subtaskTier"));
  if (!contract.objective) throw invalid(t("tasks.service.objectiveFirst"));
  if (contract.acceptanceCriteria.length === 0) throw invalid(t("tasks.service.criterionFirst"));
  const why = reason?.trim() ?? "";
  if (tier !== task.triage.proposed && !why) {
    throw invalid(t("tasks.service.tierReason", { tier, proposed: task.triage.proposed }));
  }
  const { override: previous, ...proposal } = task.triage;
  // A reason the sidecar gave (a split's sub-task, approved as drafted) keeps its ref while its text is the same.
  const reasonRef = previous?.reason === why ? previous.reasonRef : undefined;
  const at = now.toISOString();
  const next: Task = {
    ...task,
    state: "ready",
    contract: { ...contract, approvedAt: at },
    triage: {
      ...proposal,
      chosen: tier,
      budgetUsd,
      ...(tier !== proposal.proposed ? { override: { reason: why, ...(reasonRef ? { reasonRef } : {}) } } : {}),
    },
    updatedAt: at,
  };
  saveTask(root, next);
  return next;
}

/** Reopens an approved contract for editing. Unchanged, it can be approved again without a new triage. */
export function reviseTask(root: string, id: string, now = new Date()): Task {
  const task = loadTask(root, id);
  if (runs.has(id)) throw invalid(t("tasks.service.runningStopFirst"));
  if (task.state === "draft" || !task.contract) return task;
  const { approvedAt: _approved, ...contract } = task.contract;
  // A new contract makes the last run's results meaningless.
  const next: Task = { ...task, state: "draft", contract, run: null, updatedAt: now.toISOString() };
  saveTask(root, next);
  return next;
}

/* ---------- Runs (M3-06) ---------- */

const library = LibrarySchema.parse(shipped);
/** The app's own library, as compiled into the app. */
export const shippedLibrary = library;

/** The workflows for `root`: the app's, with the project's valid files in their place (M6-04). */
export const workflowsOf = (root: string): EffectiveLibrary => effectiveLibrary(root, library);

/**
 * A new run on `workflow`. A project's workflow is copied into the task's folder, so a resume runs the workflow the
 * run started with, whatever happens to the file meanwhile.
 */
export function startRun(
  root: string,
  task: Task,
  workflow: Workflow | XlWorkflow,
  eff: EffectiveLibrary,
  opts: Parameters<typeof newRun>[1],
  now: Date,
  /** The task's own flow's hash, when the run follows it (UX-14). */
  taskFlow?: string,
): TaskRun {
  const ref: WorkflowRef = taskFlow
    ? { id: workflow.id, version: workflow.version, source: "task", file: "task flow", hash: taskFlow }
    : workflowRef(workflow, eff);
  if (ref.source) writeTaskFile(root, task.id, "workflow.json", `${JSON.stringify(workflow, null, 2)}\n`);
  return newRun(ref, opts, now);
}

/** The task's own flow as a workflow (UX-14); it was checked when proposed, and is checked again here. */
function flowOf(task: Task): Workflow | null {
  const tier = task.triage?.chosen;
  if (!task.flow || !tier || tier === "XL") return null;
  try {
    const w = parseProjectWorkflow(`${tier.toLowerCase()}.yaml`, task.flow.yaml, library);
    return "split" in w ? null : w;
  } catch (err) {
    throw invalid(t("tasks.service.flowCantRun", { error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * AI writes the task's own flow from its contract (UX-14): the tier's workflow, changed only where the task calls for
 * it. Kept on the task when it passes the checks; its spend is recorded either way.
 */
export async function proposeFlow(root: string, id: string, claude: Claude, model?: string): Promise<Task> {
  const task = loadTask(root, id);
  requireDraft(task);
  const tier = task.triage?.chosen;
  const contract = task.contract;
  if (!contract || !tier) throw invalid(t("tasks.service.draftFirst"));
  if (tier === "XL") throw invalid(t("tasks.service.xlFlow"));
  const current = workflowsOf(root).library.workflows[tier];
  if (!current) throw invalid(t("tasks.service.noWorkflow", { tier }));
  return cancellable(id, async (controller) => {
    const r = await generateWorkflow(
      claude.sdk,
      claude.claudePath,
      root,
      tier,
      stringifyYaml(current),
      { contract },
      library,
      { ...(model ? { model } : {}), abortController: controller },
    );
    const at = new Date().toISOString();
    const hash = r.yaml ? createHash("sha256").update(r.yaml).digest("hex").slice(0, 12) : "";
    const next: Task = {
      ...task,
      costUsd: task.costUsd + r.costUsd,
      ...(r.yaml ? { flow: { yaml: r.yaml, summary: r.summary, hash, at } } : {}),
      updatedAt: at,
    };
    saveTask(root, next);
    if (!r.yaml) throw invalid(r.error ?? t("tasks.service.noFlowProposed"));
    return next;
  });
}

/** Drops the task's own flow: it runs its tier's again. */
export function dropFlow(root: string, id: string): Task {
  const task = loadTask(root, id);
  requireDraft(task);
  const { flow: _dropped, ...rest } = task;
  const next: Task = { ...rest, updatedAt: new Date().toISOString() };
  saveTask(root, next);
  return next;
}

/** The project's workflow a run started with, from the copy kept with the task. */
function keptWorkflow<T>(
  root: string,
  task: Task,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
): T {
  const ref = task.run?.workflow;
  let parsed: { success: boolean; data?: T } = { success: false };
  try {
    const kept = readTaskFile(root, task.id, "workflow.json");
    if (kept) parsed = schema.safeParse(JSON.parse(kept));
  } catch {
    // Reported below.
  }
  if (!parsed.success || !parsed.data) {
    throw invalid(t("tasks.service.keptWorkflowDamaged", { file: String(ref?.file) }));
  }
  return parsed.data;
}

/** The workflow a tier's run started with: the project's copy, or the app's by id. */
export function runWorkflow(root: string, task: Task): Workflow {
  const ref = task.run?.workflow;
  if (ref?.source === "project" || ref?.source === "task") return keptWorkflow(root, task, WorkflowSchema);
  const workflow = Object.values(library.workflows).find((w) => w.id === ref?.id);
  if (!workflow) throw invalid(t("tasks.service.workflowNotInApp", { id: String(ref?.id) }));
  return workflow;
}

/** The XL workflow an XL run started with. */
function runXlWorkflow(root: string, task: Task): XlWorkflow {
  if (task.run?.workflow.source === "project") return keptWorkflow(root, task, XlWorkflowSchema);
  if (!library.xl) throw invalid(t("tasks.service.noXlWorkflow"));
  return library.xl;
}

/**
 * The workflow a task's Flow tab draws (UX-14): the one its run started with, or, before any run, the one its tier
 * would run now (the project's when it has one). Null before triage.
 */
export function taskWorkflow(
  root: string,
  id: string,
): { workflow: Workflow | XlWorkflow; source: "app" | "project" | "task" } | null {
  const task = loadTask(root, id);
  if (task.run) {
    const source = task.run.workflow.source ?? "app";
    return { workflow: task.triage?.chosen === "XL" ? runXlWorkflow(root, task) : runWorkflow(root, task), source };
  }
  const tier = task.triage?.chosen;
  if (!tier) return null;
  const own = flowOf(task);
  if (own) return { workflow: own, source: "task" };
  const eff = workflowsOf(root);
  const workflow = tier === "XL" ? eff.library.xl : eff.library.workflows[tier];
  if (!workflow) return null;
  return { workflow, source: eff.origins[workflow.id] ? "project" : "app" };
}

/** Runs in progress in this sidecar, by task id: a tier's workflow, or an XL run. */
const runs = new Map<string, { cancel: () => void; message?: (text: string) => boolean; readonly current: Task }>();
/** Each run's promise, until it has fully ended: its sessions closed after its end was saved. */
const endings = new Map<string, Promise<unknown>>();

/**
 * Waits for a run whose end is already saved, while it closes its sessions, so Merge or Clean up clicked right away
 * finds it ended and its worktree free (Windows won't remove a folder a process runs in). A run still working isn't
 * waited for: the caller says it's running.
 */
export async function settleRun(id: string): Promise<void> {
  const run = runs.get(id);
  const ending = endings.get(id);
  if (run && ending && run.current.state !== "running") await ending.catch(() => undefined);
}
/** Set while the sidecar shuts down: a run cut off then is left `running`, so it reads back as interrupted. */
let shuttingDown = false;

/** A run that says it's running but has no orchestrator here was cut off (the app quit): it's `interrupted`. */
/** Whether the task's run is going on in this sidecar. */
export const runningTask = (id: string) => runs.has(id);

export function present(task: Task): Task {
  return task.state === "running" && !runs.has(task.id) ? { ...task, state: "interrupted" } : task;
}

export function listTasksLive(root: string): TaskSummary[] {
  return listTasks(root).map((t) => (t.state === "running" && !runs.has(t.id) ? { ...t, state: "interrupted" } : t));
}

/**
 * Deletes a task. An XL task takes its sub-tasks and worktrees with it; their branches stay, since they may hold work
 * that was never merged. A sub-task goes only with its XL task.
 */
export function deleteTaskSafe(root: string, id: string): void {
  if (runs.has(id)) throw invalid(t("tasks.service.runningStopFirst"));
  const task = loadTask(root, id);
  if (task.parent) throw invalid(t("tasks.service.subtaskDelete"));
  const children = (task.subtasks ?? []).map((c) => loadTask(root, c));
  if (children.some((c) => runs.has(c.id))) throw invalid(t("tasks.service.subtaskRunning"));
  for (const t of [...children, task]) {
    if (t.worktree && !t.worktree.removed) removeWorktree(t.folder?.path ?? root, t.worktree.path);
    removeFolderWorktrees(t);
    if (t !== task) deleteTask(root, t.id);
  }
  deleteTask(root, id);
}

/** Where a task's code is: its worktree while it exists, otherwise the workspace (one without git). */
function codeRootOf(root: string, task: Task): string {
  const wt = task.worktree;
  // An XL sub-task in another folder works in that folder's repository (M8-01).
  const repo = task.folder?.path ?? root;
  return wt && !wt.removed && existsSync(wt.path) ? codeRootIn(repo, wt.path) : repo;
}

/** Tasks a new run can start from. */
const STARTABLE = new Set<Task["state"]>(["ready", "done", "accepted", "failed", "unverified", "cancelled"]);

/**
 * Whether a schedule may run this task (M8-05): an approved S, M or L task of its own, whose last run isn't left
 * interrupted. Throws with the reason, for the schedule's form or its last run.
 */
export function schedulable(root: string, id: string): Task {
  const task = present(loadTask(root, id));
  if (!task.contract?.approvedAt || !task.triage) {
    throw invalid(t("tasks.service.scheduleApproveFirst"));
  }
  if (task.triage.chosen === "XL") throw invalid(t("tasks.service.scheduleXl"));
  if (task.parent) throw invalid(t("tasks.service.scheduleSubtask"));
  if (task.state === "interrupted") throw invalid(t("tasks.service.scheduleInterrupted"));
  return task;
}

/**
 * Runs a task's tier workflow in the background, in its code folder (a sub-task's worktree, or the workspace); its
 * files stay in the workspace's task folder. Resolves with the task as it ended, after its evidence was written.
 */
function launch(
  root: string,
  task: Task,
  host: SessionHost,
  notify: (task: Task) => void,
  resume: boolean,
  setup = false,
): Promise<Task> {
  const orchestrator = orchestratorFor(root, task, host, notify, {
    resume,
    ...(setup ? { setup: (signal: AbortSignal) => readyBranch(root, task, signal) } : {}),
  });
  return track(root, task.id, orchestrator, notify);
}

/** The orchestrator of a task's run, in its code folder, saving and reporting every change. */
function orchestratorFor(
  root: string,
  task: Task,
  host: SessionHost,
  notify: (task: Task) => void,
  extra: Pick<OrchestratorDeps, "resume" | "setup"> = {},
): Orchestrator {
  const workflow = runWorkflow(root, task);
  // The runner reports approvals and guard blocks as they happen; they go into the run's records.
  let orchestrator: Orchestrator | undefined;
  const others = folderDirs(task).map(({ name, dir, folder }) => ({
    name,
    dir,
    base: folder.worktree?.base ?? null,
    untracked: folder.worktree?.untracked ?? [],
  }));
  const runner = sessionRunner(
    codeRootOf(root, task),
    task,
    library,
    host,
    {
      approval: (record) => orchestrator?.recordApproval(record),
      guardBlock: (block) => orchestrator?.recordGuardBlock(block),
    },
    others,
  );
  orchestrator = new Orchestrator(task, {
    workflow,
    runner,
    files: {
      read: (name) => readTaskFile(root, task.id, name),
      write: (name, text) => writeTaskFile(root, task.id, name, text),
    },
    save: (t) => {
      if (shuttingDown) return;
      saveTask(root, t);
      notify(present(t));
    },
    ...extra,
  });
  return orchestrator;
}

/** How a worktree's install command went, for the "Task branch" step's note: xl.ts's own sentence. */
const setupRef = (s: SetupRun): MessageRef => setupResult(s).ref;

/**
 * The task's branch, ready to work in: the project's install command in its new worktree (M5-01). The note says which
 * branch, and that the workspace's uncommitted changes aren't on it.
 */
export async function readyBranch(
  root: string,
  task: Task,
  signal: AbortSignal,
): Promise<{ ok: boolean; note: string; noteRef?: MessageRef }> {
  const wt = task.worktree;
  // A multi-folder task's other worktrees are set up too, each with its own folder's install command (M8-01).
  const others = folderDirs(task).filter((f) => f.folder.worktree && !f.folder.worktree.removed);
  if (!wt && !others.length) return { ok: true, note: "" };
  let ok = true;
  // Branch names are as they are; the rest is shown in the app's language.
  const notes: (string | MessageRef)[] = [];
  if (wt) {
    const run = await setupWorktree(codeRootIn(root, wt.path), signal);
    ok = !run || (run.exitCode === 0 && !run.timedOut);
    notes.push(wt.branch, ...(run ? [setupRef(run)] : []));
    if (hasTrackedChanges(root)) notes.push(resultRef("run.branch.uncommitted"));
  }
  for (const o of others) {
    const run = await setupWorktree(o.dir, signal);
    if (run && (run.exitCode !== 0 || run.timedOut)) ok = false;
    const branch = o.folder.worktree?.branch ?? "";
    notes.push(
      run
        ? resultRef("run.branch.folderSetup", { folder: o.name, branch, setup: setupRef(run) })
        : `${o.name}: ${branch}`,
    );
    if (hasTrackedChanges(o.folder.path)) notes.push(resultRef("run.branch.folderUncommitted", { folder: o.name }));
  }
  // "a; b; c" as a; (b; c), so it renders in one language.
  const note = notes.reduceRight((rest, first) => resultRef("run.branch.notes", { first, rest }));
  return typeof note === "string" ? { ok, note } : { ok, note: resultEnglish(note), noteRef: note };
}

/**
 * Gives a task its own worktree and branch, `agentchainer/<id>` from HEAD (M5-01), or keeps the one it has. Returns
 * the task with it and whether it is new, so the run sets it up. A workspace without git, or without a commit to branch
 * from, has no branch: the task runs in the workspace, as before M5.
 */
export function taskBranch(root: string, task: Task): { task: Task; fresh: boolean } {
  const wt = task.worktree;
  if (wt && !wt.removed && existsSync(wt.path)) return { task, fresh: false };
  const head = repoOf(root) ? headOf(root) : null;
  if (!head) return { task, fresh: false };
  const base = wt?.base ?? head;
  const dir = worktreePath(root, task.id);
  addWorktree(root, dir, branchOf(task.id), base);
  // The branch checked out now is where the work goes back to: a PR's base (M5-02).
  const from = wt?.from ?? (git(["symbolic-ref", "--short", "-q", "HEAD"], root).stdout.trim() || undefined);
  const worktree = {
    path: dir,
    branch: branchOf(task.id),
    base,
    ...(from ? { from } : {}),
    untracked: untracked(codeRootIn(root, dir)),
  };
  return { task: { ...task, worktree }, fresh: true };
}

/** Keeps a run in `runs` while it goes; when it ends, writes its evidence and tells the UI. */
function track(
  root: string,
  id: string,
  running: {
    run: () => Promise<Task>;
    cancel: () => void;
    message?: (text: string) => boolean;
    readonly current: Task;
  },
  notify: (task: Task) => void,
): Promise<Task> {
  runs.set(id, running);
  const ending = running
    .run()
    .finally(() => {
      runs.delete(id);
      endings.delete(id);
      if (shuttingDown) return;
      const ended = present(running.current);
      try {
        writeEvidence(root, ended);
      } catch {
        // The report can be built again on request (task.evidence).
      }
      notify(ended);
    })
    .then(() => present(running.current));
  endings.set(id, ending);
  return ending;
}

/**
 * Starts a run of an approved task, in its own worktree and branch (M5-01). It continues in the background and reports
 * through `notify`.
 */
export function startTask(
  root: string,
  id: string,
  host: SessionHost,
  opts: { permissionMode: PermissionMode; model?: string; scheduled?: boolean; agents?: AgentRoles },
  notify: (task: Task) => void,
  now = new Date(),
): Task {
  const task = present(loadTask(root, id));
  if (runs.has(id)) throw invalid(t("tasks.service.alreadyRunning"));
  if (opts.scheduled) schedulable(root, id);
  if (!STARTABLE.has(task.state) || !task.contract?.approvedAt || !task.triage) {
    throw invalid(t("tasks.service.approveFirst"));
  }
  if (task.triage.chosen === "XL") return startXl(root, task, host, opts, notify, now);
  if (task.parent) requireOwnRun(task);
  const eff = workflowsOf(root);
  const own = flowOf(task);
  const workflow = own ?? eff.library.workflows[task.triage.chosen];
  if (!workflow) throw invalid(t("tasks.service.noWorkflow", { tier: task.triage.chosen }));
  // The task's choice per role over the workspace's defaults (M9-06): step > task > workspace > Claude.
  const chosen = { ...readDefaults(root), ...opts.agents };
  opts = Object.keys(chosen).length ? { ...opts, agents: chosen } : opts;
  // Every agent the run needs is installed, before anything starts (M9-06): the step that names a missing one would
  // otherwise fail mid-run, after the branch and the baseline.
  for (const agent of agentsNeeded(workflow, opts.agents)) {
    const found = agent === "codex" ? host.codex?.() : agent === "agy" ? host.agy?.() : null;
    if (!found) throw invalid(t("tasks.service.agentMissing", { agent: AGENT_NAME[agent] }));
  }
  // A sub-task runs in the worktree its XL task made; any other task gets its own, in each of its folders (M8-01).
  const primary = task.parent ? { task, fresh: false } : taskBranch(root, task);
  const folders = task.parent ? { task: primary.task, fresh: [] } : branchFolders(primary.task);
  const branched = { task: folders.task, fresh: primary.fresh || folders.fresh.length > 0 };
  const wt = branched.task.worktree;
  // Changes count from where the worktree branched, whichever run this is.
  const base = wt ? { base: wt.base, untrackedAtStart: wt.untracked } : startBase(root);
  const started: Task = {
    ...branched.task,
    state: "running",
    ...withPastRun(branched.task),
    run: startRun(root, branched.task, workflow, eff, { ...opts, ...base }, now, own ? task.flow?.hash : undefined),
    updatedAt: now.toISOString(),
  };
  saveTask(root, started);
  notify(started);
  void launch(root, started, host, notify, false, branched.fresh);
  return started;
}

/** A sub-task runs on its own only in its worktree, and not while its XL task runs. */
function requireOwnRun(task: Task): void {
  if (task.parent && runs.has(task.parent.id)) throw invalid(t("tasks.service.parentRunning"));
  if (!task.worktree || task.worktree.removed || !existsSync(task.worktree.path)) {
    throw invalid(t("tasks.service.runFromParent"));
  }
}

/** Continues an interrupted run from the step it stopped in. */
export function resumeTask(root: string, id: string, host: SessionHost, notify: (task: Task) => void): Task {
  const task = present(loadTask(root, id));
  if (task.state !== "interrupted" || !task.run) throw invalid(t("tasks.service.onlyInterrupted"));
  if (task.triage?.chosen === "XL") return continueTask(root, id, host, notify);
  if (task.parent) requireOwnRun(task);
  const running: Task = { ...task, state: "running" };
  // A run cut off while its branch was being set up sets it up again.
  const unready =
    (!!task.worktree || folderDirs(task).some((f) => f.folder.worktree)) &&
    !task.parent &&
    task.run.steps.some((s) => s.kind === "setup" && s.status !== "done");
  void launch(root, running, host, notify, true, unready);
  notify(running);
  return running;
}

/**
 * The person's message to a running task's current step (UX-13). An XL task's sub-tasks take theirs in their own
 * threads.
 */
export function messageRun(id: string, text: string): boolean {
  const run = runs.get(id);
  if (!run) throw invalid(t("tasks.service.notRunning"));
  if (!run.message?.(text)) throw invalid(t("tasks.service.noStepWorking"));
  return true;
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

/* ---------- XL: split, sub-tasks in worktrees, merge (M3-07) ---------- */

/** XL runs in worktrees: the workspace must be in git, with a commit to branch from. */
function requireRepoWithCommit(root: string): void {
  if (!repoOf(root) || !headOf(root)) {
    throw invalid(t("tasks.service.xlNeedsRepo"));
  }
}

const subtasksOf = (root: string, task: Task) => (task.subtasks ?? []).map((id) => present(loadTask(root, id)));

/**
 * Splits an approved XL task into sub-tasks (a read-only session), created as draft tasks with their own contracts
 * and triage: the deterministic signals plus the split's tier, capped at L, so there's no model call per sub-task.
 * Splitting again replaces sub-tasks that haven't run.
 */
export async function splitTask(root: string, id: string, claude: Claude, model?: string): Promise<Task> {
  const task = present(loadTask(root, id));
  if (task.triage?.chosen !== "XL" || !task.contract?.approvedAt || task.state !== "ready") {
    throw invalid(t("tasks.service.approveXlFirst"));
  }
  requireRepoWithCommit(root);
  const xl = workflowsOf(root).library.xl;
  if (!xl) throw invalid(t("tasks.service.noXlWorkflow"));
  const previous = subtasksOf(root, task);
  if (previous.some((c) => c.run || (c.state !== "draft" && c.state !== "ready"))) {
    throw invalid(t("tasks.service.splitStays"));
  }
  const contract = task.contract;
  const budgetUsd = task.triage.budgetUsd;
  return cancellable(id, async (controller) => {
    const profile = detectWorkspace(root);
    const folders = (task.folders ?? []).map(({ name, path }) => ({ name, path }));
    const r = await proposeSplit(claude.sdk, claude.claudePath, root, contract, profile, xl.split, {
      ...(model ? { model } : {}),
      abortController: controller,
      ...(folders.length ? { folders } : {}),
    });
    const now = new Date();
    const spent: Task = { ...task, costUsd: task.costUsd + r.costUsd, updatedAt: now.toISOString() };
    if (r.error) {
      saveTask(root, spent);
      throw new Error(r.error);
    }
    for (const c of previous) deleteTask(root, c.id);
    const listing = listFiles(root);
    const files = listing.files.map((f) => f.path).filter((f) => !f.startsWith(`${AC_DIR}/`));
    const ids: string[] = [];
    for (const [index, sub] of r.subtasks.entries()) {
      const created = createTask(root, sub.request, task.availableGates, now);
      const found = signals({
        request: sub.request,
        contract: sub.contract,
        profile,
        files,
        truncated: listing.truncated,
      });
      const rationale = result("triage.split.rationale");
      const proposal = triageRecord(
        found,
        { model: { tier: sub.tier, rationale: rationale.text, rationaleRef: rationale.ref, confidence: "medium" } },
        now,
      );
      // A sub-task runs as S, M or L; the XL budget is per sub-task.
      const chosen = proposal.proposed === "XL" ? "L" : proposal.proposed;
      const reason = result("triage.split.overrideReason");
      const child: Task = {
        ...created,
        title: sub.title,
        contract: sub.contract,
        triage: {
          ...proposal,
          chosen,
          // The tier's default (the workspace's or app's), within the XL task's own budget per sub-task.
          budgetUsd: ((tierBudget) =>
            budgetUsd === null ? tierBudget : tierBudget === null ? budgetUsd : Math.min(tierBudget, budgetUsd))(
            budgetFor(root, chosen, DEFAULT_BUDGET_USD[chosen]),
          ),
          ...(chosen !== proposal.proposed ? { override: { reason: reason.text, reasonRef: reason.ref } } : {}),
        },
        parent: { id, index },
        dependsOn: sub.dependsOn.map((j) => ids[j]).filter((d): d is string => d !== undefined),
        // The other folder it works in (M8-01).
        ...(() => {
          const f = folders.find((x) => x.name === sub.folder);
          return f ? { folder: f } : {};
        })(),
      };
      saveTask(root, child);
      ids.push(child.id);
    }
    const next: Task = { ...spent, subtasks: ids };
    saveTask(root, next);
    return next;
  });
}

/** Approves every draft sub-task as drafted: its contract and its tier. */
export function approveSubtasks(root: string, id: string, now = new Date()): Task {
  const task = loadTask(root, id);
  if (!task.subtasks?.length) throw invalid(t("tasks.service.splitFirst"));
  for (const child of subtasksOf(root, task)) {
    if (child.state !== "draft" || !child.contract || !child.triage) continue;
    try {
      approveTask(
        root,
        child.id,
        child.contract,
        child.triage.chosen,
        child.triage.override?.reason,
        child.triage.budgetUsd,
        now,
      );
    } catch (err) {
      throw invalid(
        t("tasks.service.subtaskError", {
          n: (child.parent?.index ?? 0) + 1,
          title: child.title ?? child.request,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return loadTask(root, id);
}

function startXl(
  root: string,
  task: Task,
  host: SessionHost,
  opts: { permissionMode: PermissionMode; model?: string },
  notify: (task: Task) => void,
  now: Date,
): Task {
  const eff = workflowsOf(root);
  const xl = eff.library.xl;
  if (!xl) throw invalid(t("tasks.service.noXlWorkflow"));
  if (task.state !== "ready") throw invalid(t("tasks.service.xlContinue"));
  requireRepoWithCommit(root);
  const children = subtasksOf(root, task);
  if (!children.length || children.some((c) => c.state !== "ready")) {
    throw invalid(t("tasks.service.approveSubtasksFirst"));
  }
  // A multi-folder XL task branches in each of its folders, which must be in git too (M8-01); the run sets them up.
  for (const f of task.folders ?? []) {
    if (!repoOf(f.path) || !headOf(f.path)) {
      throw invalid(t("tasks.service.xlFolderNeedsRepo", { folder: f.name }));
    }
  }
  const branched = branchFolders(task).task;
  const started: Task = {
    ...branched,
    state: "running",
    ...withPastRun(task),
    run: startRun(root, task, xl, eff, { ...opts, base: headOf(root), untrackedAtStart: [] }, now),
    updatedAt: now.toISOString(),
  };
  saveTask(root, started);
  notify(started);
  void launchXl(root, started, host, notify, false);
  return started;
}

/** Picks a stopped, failed or interrupted XL run up again: merged sub-tasks are skipped, the others run. */
export function continueTask(root: string, id: string, host: SessionHost, notify: (task: Task) => void): Task {
  const task = present(loadTask(root, id));
  if (task.triage?.chosen !== "XL" || !task.run) throw invalid(t("tasks.service.onlyXlContinues"));
  if (runs.has(id)) throw invalid(t("tasks.service.alreadyRunning"));
  if (!["failed", "unverified", "cancelled", "interrupted"].includes(task.state)) {
    throw invalid(t("tasks.service.continueWhich"));
  }
  const { endedAt: _ended, outcome: _outcome, outcomeRef: _outcomeRef, ...run } = task.run;
  const running: Task = { ...task, state: "running", run, updatedAt: new Date().toISOString() };
  saveTask(root, running);
  notify(running);
  void launchXl(root, running, host, notify, task.state === "interrupted");
  return running;
}

/** An XL run: the task branch, its sub-tasks each with their own tier's run in their worktrees, merges, integration. */
function launchXl(
  root: string,
  task: Task,
  host: SessionHost,
  notify: (task: Task) => void,
  resume: boolean,
): Promise<Task> {
  const run = task.run;
  if (!run) throw invalid(t("tasks.service.xlNotStarted"));
  const xl = runXlWorkflow(root, task);
  const world = gitWorld(root, {
    load: (id) => present(loadTask(root, id)),
    save: (t) => {
      saveTask(root, t);
      notify(present(t));
    },
    runChild: (child, resumeChild) => {
      const eff = workflowsOf(root);
      const workflow = child.triage ? eff.library.workflows[child.triage.chosen] : undefined;
      const wt = child.worktree;
      if (!workflow || !wt) throw new Error(`Sub-task ${child.id} has no workflow or worktree.`);
      const now = new Date();
      const started: Task = resumeChild
        ? { ...child, state: "running" }
        : {
            ...child,
            state: "running",
            ...withPastRun(child),
            run: startRun(
              root,
              child,
              workflow,
              eff,
              {
                permissionMode: run.permissionMode,
                ...(run.model ? { model: run.model } : {}),
                base: wt.base,
                untrackedAtStart: wt.untracked,
              },
              now,
            ),
            updatedAt: now.toISOString(),
          };
      saveTask(root, started);
      notify(started);
      return { done: launch(root, started, host, notify, resumeChild), cancel: () => runs.get(child.id)?.cancel() };
    },
  });
  const orchestrator = new XlOrchestrator(task, {
    workflow: xl,
    world,
    save: (t) => {
      if (shuttingDown) return;
      saveTask(root, t);
      notify(present(t));
    },
    resume,
  });
  return track(root, task.id, orchestrator, notify);
}

/**
 * Merges a finished task's branch into the workspace's current branch (M5-01; XL since M3-07). What the run left
 * uncommitted in its worktree is committed first, with the contract's objective as the message. Conflicts leave the
 * merge in progress.
 */
export function mergeResult(
  root: string,
  id: string,
  now = new Date(),
): { merged: boolean; conflicts: string[]; into: string } {
  const task = present(loadTask(root, id));
  if (!task.worktree || task.parent) throw invalid(t("tasks.service.noOwnBranch"));
  if (runs.has(id)) throw invalid(t("tasks.service.runningStopFirst"));
  if (task.state !== "done" && task.state !== "accepted") {
    throw invalid(t("tasks.service.mergeNotFinished"));
  }
  if (hasTrackedChanges(root)) throw invalid(t("tasks.service.mergeDirty"));
  // A multi-folder task merges into each of its folders' current branches too (M8-01), the primary folder last.
  const others = (task.folders ?? []).filter((f) => f.worktree && !f.worktree.removed);
  for (const f of others) {
    if (hasTrackedChanges(f.path)) throw invalid(t("tasks.service.mergeDirtyFolder", { folder: f.name }));
  }
  for (const f of others) {
    const wt = f.worktree;
    if (!wt) continue;
    commitIn(codeRootIn(f.path, wt.path), task, wt.untracked);
    const r = merge(f.path, wt.branch);
    if (!r.merged) {
      const conflicts = r.conflicts.map((c) => `${f.name}:${c}`);
      return { merged: false, conflicts, into: branches(f.path).current ?? "HEAD" };
    }
  }
  commitResult(root, task);
  const into = branches(root).current ?? "HEAD";
  const r = merge(root, task.worktree.branch);
  if (r.merged)
    saveTask(root, { ...task, mergedInto: { branch: into, at: now.toISOString() }, updatedAt: now.toISOString() });
  return { ...r, into };
}

/**
 * Commits what a task's run left in its worktree, as one commit on its branch; nothing when it's all committed (an XL
 * task's branch holds merges). The user's commit hooks run, and one that fails stops the merge with its message.
 */
function commitResult(root: string, task: Task, title?: string): void {
  const wt = task.worktree;
  if (!wt || wt.removed || !existsSync(wt.path)) return;
  commitIn(codeRootIn(task.folder?.path ?? root, wt.path), task, wt.untracked, title);
}

/** Commits a task's changes in one of its code folders (the primary worktree, or another folder's: M8-01). */
function commitIn(code: string, task: Task, untrackedBefore: string[], title?: string): void {
  if (!existsSync(code)) return;
  const objective = task.contract?.objective || task.request;
  const subject = title ?? shortTitle(objective);
  const message = `${subject}\n\n${subject === objective ? "" : `${objective}\n\n`}AgentChainer task ${task.id}`;
  try {
    commitAll(code, message, untrackedBefore);
  } catch (err) {
    throw invalid(t("tasks.service.commitFailed", { error: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Other tasks whose live branches change the same files as this one's (M5-01): merging both may conflict. Paths are
 * relative to the code folder.
 */
export function overlapsOf(root: string, id: string): { taskId: string; title: string; files: string[] }[] {
  const changed = (t: Task) => {
    const wt = t.worktree;
    if (!wt || wt.removed || t.mergedInto || !existsSync(wt.path)) return null;
    return new Set(changedPaths(codeRootIn(root, wt.path), wt.base, wt.untracked));
  };
  const task = loadTask(root, id);
  const mine = changed(task);
  if (!mine?.size) return [];
  return listTasks(root)
    .filter((s) => s.id !== id)
    .flatMap((s) => {
      const other = loadTask(root, s.id);
      if (other.parent) return [];
      const files = [...(changed(other) ?? [])].filter((f) => mine.has(f)).sort();
      return files.length ? [{ taskId: other.id, title: other.contract?.objective || other.request, files }] : [];
    });
}

/**
 * Removes a task's worktrees (an XL task's sub-tasks' too). What a run left uncommitted is committed on its branch
 * first, and the branches stay unless asked: they may hold unmerged work.
 */
export function cleanupTask(root: string, id: string, deleteBranches: boolean): void {
  const task = loadTask(root, id);
  if (task.parent) throw invalid(t("tasks.service.subtaskWorktree"));
  if (runs.has(id)) throw invalid(t("tasks.service.runningStopFirst"));
  for (const t of [...subtasksOf(root, task), task]) {
    const wt = t.worktree;
    if (!wt) continue;
    // What the run left uncommitted goes on its branch first, so removing the folder loses nothing.
    if (!deleteBranches) commitResult(root, t);
    const repo = t.folder?.path ?? root;
    if (!wt.removed) removeWorktree(repo, wt.path);
    if (deleteBranches) deleteBranch(repo, wt.branch);
    saveTask(root, { ...loadTask(root, t.id), worktree: { ...wt, removed: true } });
  }
  // The other folders' worktrees (M8-01), the same way.
  const current = loadTask(root, id);
  for (const { folder, dir } of folderDirs(current)) {
    const wt = folder.worktree;
    if (!wt || wt.removed) continue;
    if (!deleteBranches) commitIn(dir, current, wt.untracked);
  }
  const cleaned = removeFolderWorktrees(current);
  if (deleteBranches) for (const f of current.folders ?? []) if (f.worktree) deleteBranch(f.path, f.worktree.branch);
  saveTask(root, cleaned);
}

/* ---------- Pull requests (M5-02) ---------- */

/** GitHub allows 65,536 characters in a PR body; the report is cut before that, with a pointer to the full file. */
const MAX_PR_BODY = 60_000;

/** A task that can become a PR: ended Done or accepted, with its own branch and a worktree to commit from. */
function shippable(root: string, id: string): Task & { worktree: NonNullable<Task["worktree"]> } {
  const task = present(loadTask(root, id));
  if (task.parent) throw invalid(t("tasks.service.subtaskBranch"));
  if (runs.has(id)) throw invalid(t("tasks.service.runningStopFirst"));
  if (task.state !== "done" && task.state !== "accepted") {
    throw invalid(t("tasks.service.prNotFinished"));
  }
  const wt = task.worktree;
  if (!wt || wt.removed || !existsSync(wt.path)) throw invalid(t("tasks.service.noWorktreeToPush"));
  return { ...task, worktree: wt };
}

/**
 * A commit subject or PR title from the task's objective: its first sentence, at most 72 characters, cut at a word.
 * The whole objective stays in the commit's body and the PR's contract.
 */
export function shortTitle(objective: string): string {
  const first =
    objective
      .trim()
      .split(/(?<=[.!?])\s/)[0]
      ?.replace(/[.\s]+$/, "") ?? "";
  if (first.length <= 72) return first;
  const cut = first.slice(0, 71);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[\s,;:]+$/, "")}…`;
}

/** The branch a task's PR goes into: the one it started from, else the workspace's current branch. */
function prBase(root: string, task: Task): string {
  const base = task.worktree?.from ?? (git(["symbolic-ref", "--short", "-q", "HEAD"], root).stdout.trim() || null);
  if (!base) throw invalid(t("tasks.service.noBase"));
  return base;
}

/** The PR's body: the contract, then the evidence report, then where it came from. Built here, never by the UI. */
export function prBody(root: string, task: Task): string {
  const c = task.contract;
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`) : ["- None"]);
  const contract = c
    ? [
        "## Contract",
        "",
        `**Objective:** ${c.objective}`,
        "",
        "**Acceptance criteria**",
        "",
        ...c.acceptanceCriteria.map((a) => `- ${a.text} (${a.check})`),
        "",
        "**Out of scope**",
        "",
        ...list(c.outOfScope),
        "",
      ]
    : [];
  const evidence = storedEvidence(root, task.id).markdown.replace(/^# .*\n+/, "");
  // The task's PRs in its other folders' repositories (M8-01), and the branches that have none.
  const linked = (task.folders ?? []).flatMap((f) => (f.pr ? [`- \`${f.name}\`: ${f.pr.url}`] : []));
  // Before Create PR (the preview), a changed folder has no PR yet: it gets one, linked here, when this one is opened.
  const pending = folderDirs(task).filter(
    ({ folder, dir }) =>
      folder.worktree && !folder.pr && changedPaths(dir, folder.worktree.base, folder.worktree.untracked).length > 0,
  );
  const pendingNames = pending.map((f) => `\`${f.name}\``);
  const elsewhere = [
    ...(linked.length ? ["", "## The task's other pull requests", "", ...linked] : []),
    ...(pendingNames.length
      ? [
          "",
          `> The task's changes in ${pendingNames.join(", ")} get their own PRs, linked here, when this one is opened.`,
        ]
      : []),
  ];
  const footer = [...elsewhere, "", "---", `Opened from AgentChainer task \`${task.id}\`.`];
  let body = [...contract, "## Evidence", "", evidence.trim(), ...footer].join("\n");
  if (body.length > MAX_PR_BODY) {
    body = `${body.slice(0, MAX_PR_BODY)}\n\n…the report goes on in \`.agentchainer/tasks/${task.id}/evidence.md\`.${footer.join("\n")}`;
  }
  return body;
}

/** What Create PR would send, without sending anything. */
export async function prPreview(root: string, id: string, gh: Gh | null) {
  const task = shippable(root, id);
  return {
    github: await githubStatus(root, gh),
    base: prBase(root, task),
    head: task.worktree.branch,
    title: shortTitle(task.contract?.objective || task.request),
    body: prBody(root, task),
  };
}

/**
 * Creates the task's PR: commits what the run left, scans the branch's changed files with gitleaks, pushes the branch
 * (never forced) and opens the PR through the user's `gh`. A branch with an open PR gets that one recorded.
 */
export async function createTaskPr(
  root: string,
  id: string,
  opts: { title: string; draft: boolean },
  gh: Gh | null,
  now = new Date(),
): Promise<Task> {
  const task = shippable(root, id);
  const status = await githubStatus(root, gh);
  if (!gh || status.state !== "ready") {
    throw invalid(
      status.state === "missing"
        ? t("tasks.service.ghMissing")
        : status.state === "no-remote"
          ? t("tasks.service.noOrigin")
          : t("tasks.service.ghSignedOut", { host: String(status.host) }),
    );
  }
  const base = prBase(root, task);
  const head = task.worktree.branch;
  commitResult(root, task);
  if (git(["rev-list", "--count", `${base}..${head}`], root).stdout.trim() === "0") {
    throw invalid(t("tasks.service.nothingToPropose", { head, base }));
  }
  // A multi-folder task's other repositories get their own PRs (M8-01). Every check runs before anything is pushed.
  const others = await otherRepos(task, gh);
  // Nothing leaves the machine before the changed files were scanned for secrets (T-08).
  const code = codeRootIn(root, task.worktree.path);
  await requireNoSecrets(code, base, head, "");
  for (const o of others) await requireNoSecrets(o.code, o.base, o.head, `${o.folder.name}:`);
  const made: NonNullable<TaskFolder["pr"]>[] = [];
  for (const o of others) {
    await pushBranch(o.folder.path, o.head, ghCredentialConfig(o.folder.path) ?? []);
    let view = await findPr(gh, o.folder.path, o.head);
    if (!view) {
      const name = "pr-body-other.md";
      writeTaskFile(root, id, name, otherPrBody(task, o.folder.name, null));
      const bodyFile = path.join(root, AC_DIR, "tasks", id, name);
      view = await createPr(gh, o.folder.path, {
        base: o.base,
        head: o.head,
        title: opts.title,
        bodyFile,
        draft: true,
      });
    }
    made.push({ number: view.number, url: view.url, base: view.baseRefName, head: view.headRefName });
  }
  const withFolders: Task = {
    ...task,
    ...(task.folders
      ? {
          folders: task.folders.map((f) => {
            const i = others.findIndex((o) => o.folder.name === f.name);
            const pr = made[i];
            return pr ? { ...f, pr } : f;
          }),
        }
      : {}),
  };
  if (others.length) saveTask(root, { ...loadTask(root, id), folders: withFolders.folders });
  await pushBranch(root, head, ghCredentialConfig(root) ?? []);
  const existing = await findPr(gh, root, head);
  let pr = existing;
  if (!pr) {
    writeTaskFile(root, id, "pr-body.md", prBody(root, withFolders));
    const bodyFile = path.join(root, AC_DIR, "tasks", id, "pr-body.md");
    pr = await createPr(gh, root, { base, head, title: opts.title, bodyFile, draft: opts.draft });
  }
  // The other PRs link back to the main one, now that it exists.
  for (const [i, o] of others.entries()) {
    const other = made[i];
    if (!other) continue;
    const name = "pr-body-other.md";
    writeTaskFile(root, id, name, otherPrBody(task, o.folder.name, pr.url));
    const r = await gh(
      ["pr", "edit", String(other.number), "--body-file", path.join(root, AC_DIR, "tasks", id, name)],
      o.folder.path,
    );
    if (r.status !== 0) log(`Couldn't link ${other.url} to ${pr.url}: ${(r.stderr || r.stdout).trim()}`);
  }
  const runReview = task.run?.steps.some((st) => st.step === "review" && st.status === "done")
    ? storedReview(root, id)
    : null;
  const next: Task = {
    ...loadTask(root, id),
    pr: {
      number: pr.number,
      url: pr.url,
      base: pr.baseRefName,
      head: pr.headRefName,
      headSha: pr.headRefOid,
      draft: pr.isDraft,
      createdAt: now.toISOString(),
      // The run's own review (M and L) covers what was just pushed (M5-04).
      ...(runReview
        ? { review: { ...runReview, headSha: pr.headRefOid, at: now.toISOString(), source: "run" as const } }
        : {}),
    },
    updatedAt: now.toISOString(),
  };
  saveTask(root, next);
  return present(next);
}

/** A multi-folder task's other repository with commits to propose (M8-01). */
type OtherRepo = { folder: TaskFolder; code: string; base: string; head: string };

/**
 * The other folders whose branch has commits its base lacks, after committing what the run left; each must be on
 * GitHub with `gh` signed in, or nothing is pushed.
 */
async function otherRepos(task: Task, gh: Gh): Promise<OtherRepo[]> {
  const out: OtherRepo[] = [];
  for (const { folder, dir } of folderDirs(task)) {
    const wt = folder.worktree;
    if (!wt || wt.removed || !existsSync(wt.path)) continue;
    commitIn(dir, task, wt.untracked);
    const base = wt.from ?? (git(["symbolic-ref", "--short", "-q", "HEAD"], folder.path).stdout.trim() || null);
    if (!base) throw invalid(t("tasks.service.folderNoBase", { folder: folder.name }));
    if (git(["rev-list", "--count", `${base}..${wt.branch}`], folder.path).stdout.trim() === "0") continue;
    const status = await githubStatus(folder.path, gh);
    if (status.state !== "ready") {
      throw invalid(
        status.state === "no-remote"
          ? t("tasks.service.folderNoOrigin", { folder: folder.name })
          : t("tasks.service.folderCantOpenPr", { folder: folder.name, state: status.state }),
      );
    }
    out.push({ folder, code: dir, base, head: wt.branch });
  }
  return out;
}

/** Refuses to push a branch whose changed files gitleaks flags (T-08); `prefix` names another folder's files. */
async function requireNoSecrets(code: string, base: string, head: string, prefix: string): Promise<void> {
  const changed = git(["diff", "--name-only", "--no-renames", `${base}...${head}`, "--", "."], code)
    .stdout.split("\n")
    .filter((f) => f && existsSync(path.join(code, ...f.split("/"))))
    .map((f): FileChange => ({ path: f, status: "modified", added: null, removed: null }));
  const scan = await scanSecretsAsync(code, changed);
  if (scan.ran && scan.flagged.length) {
    const files = scan.flagged.map((f) => `${prefix}${f}`).join(", ");
    throw invalid(t("tasks.service.secretsFound", { files }));
  }
}

/** The body of a task's PR in another folder's repository: what the task is, and where its main PR and evidence are. */
export function otherPrBody(task: Task, folder: string, mainUrl: string | null): string {
  const objective = task.contract?.objective || task.request;
  return [
    `Part of a change across several repositories, made by AgentChainer task \`${task.id}\`.`,
    "",
    `**Objective:** ${objective}`,
    "",
    mainUrl
      ? `The contract and the evidence for every repository are in the main PR: ${mainUrl}`
      : "The contract and the evidence are in the task's main PR.",
    "",
    "---",
    `Opened from AgentChainer task \`${task.id}\` (folder \`${folder}\`).`,
  ].join("\n");
}

/* ---------- CI status and Fix CI (M5-03) ---------- */

function withPr(root: string, id: string, gh: Gh | null): { task: Task; pr: NonNullable<Task["pr"]>; gh: Gh } {
  const task = present(loadTask(root, id));
  if (!task.pr) throw invalid(t("tasks.service.noPr"));
  if (!gh) throw invalid(t("tasks.service.ghMissing"));
  return { task, pr: task.pr, gh };
}

/** The task's PR on GitHub and its checks. */
export async function prStatus(root: string, id: string, gh: Gh | null) {
  const { pr, gh: run } = withPr(root, id, gh);
  return { ...(await prState(run, root, pr.number)), checks: await prChecks(run, root, pr.number) };
}

/** The failed steps' log of one of the PR's checks, named by its link, which must be one of the PR's. */
export async function ciLog(root: string, id: string, link: string, gh: Gh | null): Promise<string> {
  const { pr, gh: run } = withPr(root, id, gh);
  if (!(await prChecks(run, root, pr.number)).some((c) => c.link === link)) throw invalid(t("tasks.service.notACheck"));
  const job = jobOf(link);
  if (!job) throw invalid(t("tasks.service.actionsOnly"));
  return failedJobLog(run, root, job);
}

/**
 * Starts a Fix CI round on a failing check of the task's PR, after the user saw its log. It runs in the background
 * like a run; when it ends Done, what it changed is committed and pushed (never forced). Rounds are capped.
 */
export async function fixCiTask(
  root: string,
  id: string,
  link: string,
  host: SessionHost,
  gh: Gh | null,
  notify: (task: Task) => void,
  now = new Date(),
): Promise<Task> {
  const task = shippable(root, id);
  const { pr, gh: run } = withPr(root, id, gh);
  const fixes = pr.fixes ?? [];
  if (fixes.length >= MAX_CI_FIXES) {
    throw invalid(t("tasks.service.fixCiCap", { max: MAX_CI_FIXES }));
  }
  const check = (await prChecks(run, root, pr.number)).find((c) => c.link === link);
  if (check?.bucket !== "fail") throw invalid(t("tasks.service.checkNotFailing"));
  const job = jobOf(link);
  if (!job) throw invalid(t("tasks.service.actionsOnly"));
  const log = await failedJobLog(run, root, job);
  const running: Task = { ...task, state: "running", updatedAt: now.toISOString() };
  saveTask(root, running);
  notify(running);
  const orchestrator = orchestratorFor(root, running, host, notify);
  const round = {
    run: () => orchestrator.fixCi({ check: check.name, log }),
    cancel: () => orchestrator.cancel(),
    get current() {
      return orchestrator.current;
    },
  };
  void track(root, id, round, notify).then(async (ended) => {
    let state: "done" | "failed" | "cancelled" =
      ended.state === "done" ? "done" : ended.state === "cancelled" ? "cancelled" : "failed";
    let outcome: { text: string; ref: MessageRef } | null = null;
    const latest = loadTask(root, id);
    if (state === "done" && latest.worktree) {
      try {
        commitResult(root, latest, `Fix CI: ${check.name}`);
        await pushBranch(root, latest.worktree.branch, ghCredentialConfig(root) ?? []);
      } catch (err) {
        state = "failed";
        outcome = result("run.outcome.pushFailed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const head = latest.worktree ? git(["rev-parse", latest.worktree.branch], root).stdout.trim() : "";
    const next: Task = {
      ...latest,
      ...(outcome && latest.run
        ? { state: "failed" as const, run: { ...latest.run, outcome: outcome.text, outcomeRef: outcome.ref } }
        : {}),
      ...(latest.pr
        ? {
            pr: {
              ...latest.pr,
              ...(head && state === "done" ? { headSha: head } : {}),
              fixes: [...(latest.pr.fixes ?? []), { check: check.name, at: now.toISOString(), state }],
            },
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    saveTask(root, next);
    notify(present(next));
  });
  return running;
}

/* ---------- Merge gates and the human merge (M5-04, M5-05) ---------- */

/** The verdict in the task's `review.json`, as a merge gate counts it. */
function storedReview(
  root: string,
  id: string,
): { verdict: "approve" | "changes-requested" | "unreadable"; mustFix: number } | null {
  const text = readTaskFile(root, id, "review.json");
  if (!text) return null;
  try {
    const json = JSON.parse(text) as unknown;
    const review = parseReview(json, "");
    if (!review) return { verdict: "unreadable", mustFix: 0 };
    return { verdict: review.verdict, mustFix: review.findings.filter((f) => f.severity === "must-fix").length };
  } catch {
    return { verdict: "unreadable", mustFix: 0 };
  }
}

/** Gate states that hold Merge back until a person accepts them with a reason. */
const HOLDS = new Set<MergeGate["state"]>(["fail", "pending", "missing"]);

/**
 * The merge gates of the task's PR, worked out now (design §7). The scanners run on the task's worktree, and only
 * when it is at the PR's head; otherwise they say so and don't hold Merge back.
 */
export async function mergeGates(root: string, id: string, gh: Gh | null) {
  const { task, pr, gh: run } = withPr(root, id, gh);
  const state = await prState(run, root, pr.number);
  const head = state.headSha;
  const gates: MergeGate[] = [];
  // Worked out on each call and never stored: shown in the app's language as they are (X-13 part 2b).
  const say = (key: ResultKey, params?: Record<string, string | number | MessageRef>) =>
    resultText(resultRef(key, params));

  const local = say("run.mergeGates.localLabel");
  const outcome = task.run?.outcomeRef ? resultText(task.run.outcomeRef) : task.run?.outcome;
  gates.push(
    task.state === "done"
      ? { id: "local", label: local, state: "pass", detail: outcome ?? say("run.mergeGates.runDone") }
      : task.state === "accepted"
        ? {
            id: "local",
            label: local,
            state: "pass",
            detail: say("run.mergeGates.accepted", { reason: task.run?.acceptance?.reason ?? "" }),
          }
        : {
            id: "local",
            label: local,
            state: "fail",
            detail: say("run.mergeGates.runState", { state: named(STATE_TEXT, task.state) }),
          },
  );

  const rv = pr.review;
  const review = say("run.mergeGates.reviewLabel");
  gates.push(
    !rv
      ? { id: "review", label: review, state: "missing", detail: say("run.mergeGates.noReview") }
      : rv.headSha !== head
        ? { id: "review", label: review, state: "missing", detail: say("run.mergeGates.reviewStale") }
        : rv.verdict === "unreadable"
          ? { id: "review", label: review, state: "fail", detail: say("run.mergeGates.reviewUnreadable") }
          : rv.mustFix
            ? {
                id: "review",
                label: review,
                state: "fail",
                detail: say("run.mergeGates.mustFix", { count: rv.mustFix }),
              }
            : {
                id: "review",
                label: review,
                state: "pass",
                detail:
                  rv.source === "run"
                    ? say("run.mergeGates.noMustFixRun", { verdict: rv.verdict })
                    : say("run.mergeGates.noMustFixPr", { verdict: rv.verdict }),
              },
  );

  const secretsLabel = say("run.mergeGates.secretsLabel");
  const semgrepLabel = say("run.mergeGates.semgrepLabel");
  const trivyLabel = say("run.mergeGates.trivyLabel");
  const wt = task.worktree;
  const code = wt && !wt.removed && existsSync(wt.path) ? codeRootIn(root, wt.path) : null;
  const atHead = code !== null && git(["rev-parse", "HEAD"], code).stdout.trim() === head;
  if (!code || !atHead) {
    const why = !code ? say("run.mergeGates.worktreeRemoved") : say("run.mergeGates.worktreeNotAtHead");
    for (const [gid, label] of [
      ["secrets", secretsLabel],
      ["semgrep", semgrepLabel],
      ["trivy", trivyLabel],
    ] as const) {
      gates.push({ id: gid, label, state: "not-run", detail: why });
    }
  } else {
    const files = git(["diff", "--name-only", "--no-renames", `${pr.base}...${head}`, "--", "."], code)
      .stdout.split("\n")
      .filter((f) => f && existsSync(path.join(code, ...f.split("/"))));
    const secrets = await scanSecretsAsync(
      code,
      files.map((f): FileChange => ({ path: f, status: "modified", added: null, removed: null })),
    );
    gates.push(
      !secrets.ran
        ? {
            id: "secrets",
            label: secretsLabel,
            state: "not-run",
            detail: secrets.whyRef ? resultText(secrets.whyRef) : secrets.why,
          }
        : secrets.flagged.length
          ? {
              id: "secrets",
              label: secretsLabel,
              state: "fail",
              detail: say("run.mergeGates.secretsFound", { files: secrets.flagged.join(", ") }),
            }
          : {
              id: "secrets",
              label: secretsLabel,
              state: "pass",
              detail: say("run.mergeGates.secretsNone", { count: secrets.scanned }),
            },
    );
    const [semgrep, trivy] = await Promise.all([semgrepScan(code, files), trivyScan(code)]);
    for (const [gid, label, scan] of [
      ["semgrep", semgrepLabel, semgrep],
      ["trivy", trivyLabel, trivy],
    ] as const) {
      gates.push(
        !scan.ran
          ? { id: gid, label, state: "not-run", detail: resultText(scan.whyRef) }
          : { id: gid, label, state: scan.findings ? "fail" : "pass", detail: resultText(scan.detailRef) },
      );
    }
  }

  const checks = await prChecks(run, root, pr.number);
  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  const pending = checks.filter((c) => c.bucket === "pending");
  const ci = say("run.mergeGates.ciLabel");
  const names = (list: typeof checks) => list.map((c) => c.name).join(", ");
  gates.push(
    !checks.length
      ? { id: "ci", label: ci, state: "not-run", detail: say("run.mergeGates.noChecks") }
      : failed.length
        ? { id: "ci", label: ci, state: "fail", detail: say("run.mergeGates.checksFailing", { checks: names(failed) }) }
        : pending.length
          ? {
              id: "ci",
              label: ci,
              state: "pending",
              detail: say("run.mergeGates.checksPending", { checks: names(pending) }),
            }
          : {
              id: "ci",
              label: ci,
              state: "pass",
              detail: say("run.mergeGates.checksPassed", { count: checks.length }),
            },
  );
  return { headSha: head, draft: state.draft, gates, ...(await mergeMethods(run, root)) };
}

/**
 * Runs the independent reviewer on the PR's change, in the background like a run (M5-04). Its verdict is recorded for
 * the head it reviewed; a newer push makes it stale.
 */
export async function reviewPrTask(
  root: string,
  id: string,
  host: SessionHost,
  gh: Gh | null,
  notify: (task: Task) => void,
  now = new Date(),
): Promise<Task> {
  const task = shippable(root, id);
  const { pr, gh: run } = withPr(root, id, gh);
  const head = (await prState(run, root, pr.number)).headSha;
  const code = codeRootIn(root, task.worktree.path);
  if (git(["rev-parse", "HEAD"], code).stdout.trim() !== head) {
    throw invalid(t("tasks.service.worktreeNotAtHead"));
  }
  const running: Task = { ...task, state: "running", updatedAt: now.toISOString() };
  saveTask(root, running);
  notify(running);
  const orchestrator = orchestratorFor(root, running, host, notify);
  const round = {
    run: () => orchestrator.reviewPr(),
    cancel: () => orchestrator.cancel(),
    get current() {
      return orchestrator.current;
    },
  };
  void track(root, id, round, notify).then((ended) => {
    const reviewed = ended.run?.steps.some(
      (st) => st.step === "pr-review" && st.status === "done" && st.startedAt >= now.toISOString(),
    );
    const verdict = reviewed ? storedReview(root, id) : null;
    const latest = loadTask(root, id);
    if (!verdict || !latest.pr) return;
    const next: Task = {
      ...latest,
      pr: { ...latest.pr, review: { ...verdict, headSha: head, at: new Date().toISOString(), source: "pr" } },
      updatedAt: new Date().toISOString(),
    };
    saveTask(root, next);
    notify(present(next));
  });
  return running;
}

/**
 * Merges the task's PR on GitHub (M5-05): a person clicked Merge and confirmed. The gates are worked out again for the
 * head they saw; gates that hold Merge back need the person's reason, which the task keeps.
 */
export async function mergePrTask(
  root: string,
  id: string,
  opts: { method: "merge" | "squash" | "rebase"; headSha: string; acceptReason?: string },
  gh: Gh | null,
  now = new Date(),
): Promise<Task> {
  const { pr, gh: run } = withPr(root, id, gh);
  if (runs.has(id)) throw invalid(t("tasks.service.runningWait"));
  if (pr.merged) throw invalid(t("tasks.service.prMerged"));
  const g = await mergeGates(root, id, run);
  if (g.headSha !== opts.headSha) throw invalid(t("tasks.service.prChanged"));
  if (!g.methods.includes(opts.method)) throw invalid(t("tasks.service.methodNotAllowed", { method: opts.method }));
  const held = g.gates.filter((x) => HOLDS.has(x.state));
  if (held.length && !opts.acceptReason?.trim()) {
    throw invalid(t("tasks.service.mergeHeld", { gates: held.map((x) => x.label).join(", ") }));
  }
  await mergePullRequest(run, root, pr.number, opts.method, opts.headSha, g.draft);
  const at = now.toISOString();
  const latest = loadTask(root, id);
  const next: Task = {
    ...latest,
    mergedInto: { branch: pr.base, at },
    pr: {
      ...pr,
      draft: false,
      merged: {
        method: opts.method,
        sha: opts.headSha,
        at,
        ...(held.length && opts.acceptReason ? { accepted: opts.acceptReason.trim() } : {}),
      },
    },
    updatedAt: at,
  };
  saveTask(root, next);
  writeEvidence(root, next);
  return present(next);
}

/* ---------- Accepted risk (M3-10) and evidence (M3-09) ---------- */

/** Ends a failed or unverified run as accepted with risk, with the user's reason; the report keeps it. */
export function acceptRisk(root: string, id: string, reason: string, now = new Date()): Task {
  const task = present(loadTask(root, id));
  if (runs.has(id)) throw invalid(t("tasks.service.runningStopFirst"));
  if ((task.state !== "failed" && task.state !== "unverified") || !task.run) {
    throw invalid(t("tasks.service.acceptWhich"));
  }
  const why = reason.trim();
  if (!why) throw invalid(t("tasks.service.riskReason"));
  const at = now.toISOString();
  const next: Task = {
    ...task,
    state: "accepted",
    run: { ...task.run, acceptance: { reason: why, at } },
    updatedAt: at,
  };
  saveTask(root, next);
  writeEvidence(root, next);
  return next;
}

/**
 * `scanSecrets` without blocking the sidecar, for the PR's push and its merge gates, where the files can be many (the
 * UI restarts a sidecar that doesn't answer its health ping within 5 s).
 */
export async function scanSecretsAsync(root: string, files: FileChange[]): Promise<SecretsScan> {
  const gitleaks = findTool("gitleaks", toolsDir());
  if (!gitleaks) return gitleaksMissing();
  const targets = files.filter((f) => f.status !== "deleted");
  const flagged: string[] = [];
  for (const f of targets) {
    const r = await runAsync(
      gitleaks,
      ["dir", path.join(root, ...f.path.split("/")), "--no-banner", "--redact", "--exit-code", "3"],
      { cwd: root, timeoutMs: 60_000 },
    );
    if (r.status === 3) flagged.push(f.path);
    else if (r.status !== 0) return gitleaksFailed(r);
  }
  return { ran: true, scanned: targets.length, flagged };
}

const gitleaksMissing = () => notScanned(result("evidence.scan.notInstalled", { tool: "gitleaks" }));

/** gitleaks exiting other than 0 or 3: what it said, or its exit code. */
const gitleaksFailed = (r: { status: number | null; stdout: string | null; stderr: string | null }) =>
  notScanned(
    result("evidence.scan.failed", {
      tool: "gitleaks",
      error:
        (r.stderr || r.stdout || "").trim().slice(0, 200) ||
        resultRef("evidence.gate.exit", { code: String(r.status) }),
    }),
  );

/** gitleaks over the changed files, when it's installed (the catalog's copy, or one on PATH). */
export function scanSecrets(root: string, files: FileChange[]): SecretsScan {
  const gitleaks = findTool("gitleaks", toolsDir());
  if (!gitleaks) return gitleaksMissing();
  const targets = files.filter((f) => f.status !== "deleted");
  const flagged: string[] = [];
  for (const f of targets) {
    // Exit code 3 means "leaks found"; anything else non-zero is gitleaks failing.
    const r = spawnSync(
      gitleaks,
      ["dir", path.join(root, ...f.path.split("/")), "--no-banner", "--redact", "--exit-code", "3"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    if (r.status === 3) flagged.push(f.path);
    else if (r.status !== 0) return gitleaksFailed(r);
  }
  return { ran: true, scanned: targets.length, flagged };
}

/** The secrets scan across a multi-folder task's folders (M8-01): each in its own code folder, named `folder:path`. */
function scanSecretsAcross(code: string, own: FileChange[], task: Task): SecretsScan {
  const first = scanSecrets(code, own);
  if (!first.ran) return first;
  let { scanned } = first;
  const flagged = [...first.flagged];
  for (const { name, dir, folder } of folderDirs(task)) {
    const wt = folder.worktree;
    if (!wt) continue;
    const r = scanSecrets(dir, fileStats(dir, wt.base, wt.untracked));
    if (!r.ran) return r;
    scanned += r.scanned;
    flagged.push(...r.flagged.map((f) => `${name}:${f}`));
  }
  return { ran: true, scanned, flagged };
}

/** Builds the evidence from the task's records and writes `evidence.json` and `evidence.md` in its folder. */
export function writeEvidence(root: string, task: Task, now = new Date()): { markdown: string; path: string } {
  if (!task.run) throw invalid(t("tasks.service.notRunYet"));
  // XL tasks and sub-tasks changed their worktree, where the files their setup installed don't count.
  const code = codeRootOf(root, task);
  const stats = fileStats(code, task.run.base, task.worktree?.untracked ?? task.run.untrackedAtStart);
  // An XL sub-task in another folder names its files with the folder, like its XL task's report does.
  const own = task.folder ? stats.map((f) => ({ ...f, path: `${task.folder?.name}:${f.path}` })) : stats;
  // A multi-folder task's other folders' changes, named `folder:path` (M8-01).
  const files = [...own, ...folderFileStats(task)];
  const children = subtasksOf(root, task);
  const reviewText = readTaskFile(root, task.id, "review.json");
  let review = null;
  try {
    review = reviewText ? parseReview(JSON.parse(reviewText), reviewText) : null;
  } catch {
    review = null;
  }
  const xl = children.length ? subtaskSummaries(root, children) : null;
  const evidence = buildEvidence({
    task,
    files,
    summary: xl ? xl.summary : readTaskFile(root, task.id, "summary.md"),
    ...(xl ? { notes: xl.notes, records: subtaskRecords(children) } : {}),
    review,
    secrets: scanSecretsAcross(code, stats, task),
    deploys: listDeploys(root, task.id),
    subtasks: children.map((c) => ({
      number: (c.parent?.index ?? 0) + 1,
      title: c.title ?? c.request,
      tier: c.triage?.chosen ?? null,
      state: c.state,
      costUsd: c.run?.costUsd ?? 0,
      outcome: c.run?.outcome ?? null,
      ...(c.run?.outcomeRef ? { outcomeRef: c.run.outcomeRef } : {}),
      report: path.join(AC_DIR, "tasks", c.id, "evidence.md"),
    })),
    now,
  });
  // In English, like the PR it goes into (X-13): the task page renders `evidence.json` in the app's language.
  const markdown = renderEvidence(evidence);
  writeTaskFile(root, task.id, "evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
  writeTaskFile(root, task.id, "evidence.md", markdown);
  // Each run keeps its own report, which the next run's would otherwise replace (M8-05).
  if (task.run.endedAt) writeTaskFile(root, task.id, runEvidenceFile((task.runs?.length ?? 0) + 1), markdown);
  return { markdown, path: path.join(root, AC_DIR, "tasks", task.id, "evidence.md") };
}

/** A text an XL task's report marks with its sub-task ("Sub-task 2: …"). */
const ofSubtask = (c: Task, text: string) =>
  result("evidence.subtask.labeled", { n: (c.parent?.index ?? 0) + 1, text });

/** An XL task's report lists the approvals and guard blocks of its sub-tasks' steps, each marked with its sub-task. */
function subtaskRecords(children: Task[]) {
  return {
    approvals: children.flatMap((c) =>
      (c.run?.approvals ?? []).map((a) => {
        const label = ofSubtask(c, a.label);
        return { ...a, label: label.text, labelRef: label.ref };
      }),
    ),
    guardBlocks: children.flatMap((c) => c.run?.guardBlocks ?? []),
  };
}

/**
 * What an XL task's files are for (the `## Changes` its sub-tasks' latest summaries have), and its implementers'
 * notes, each marked with its sub-task.
 */
function subtaskSummaries(root: string, children: Task[]) {
  const changes: string[] = [];
  const notes: ReturnType<typeof result>[] = [];
  for (const c of children) {
    const text = readTaskFile(root, c.id, "summary.md");
    changes.push(...sectionLines(text, "Changes"));
    notes.push(...sectionLines(text, "Notes").map((n) => ofSubtask(c, n)));
  }
  return { summary: ["## Changes", ...changes.map((l) => `- ${l}`)].join("\n"), notes };
}

/** The task's evidence report as data, written again first when it's out of date (M8-06). */
export function evidenceOf(root: string, id: string): Evidence {
  storedEvidence(root, id);
  return JSON.parse(readTaskFile(root, id, "evidence.json") ?? "null") as Evidence;
}

/**
 * The report for the task page (`task.evidence`), in the app's language (X-13 part 2b): rendered from `evidence.json`
 * with the results catalog. A report from before its prose had refs, or without its `evidence.json`, is shown as it
 * was written, in English.
 */
export function taskEvidence(root: string, id: string): { markdown: string; path: string } {
  const stored = storedEvidence(root, id);
  let evidence: Evidence | null = null;
  try {
    evidence = JSON.parse(readTaskFile(root, id, "evidence.json") ?? "null") as Evidence | null;
  } catch {
    // Unreadable: the stored report.
  }
  return evidence?.refs ? { ...stored, markdown: renderEvidence(evidence, resultText) } : stored;
}

/**
 * `evidence.md`, in English like the PR it goes into: the stored report while nothing in the task changed after it was
 * written; otherwise (a newer run, an interrupted one, a run from before reports existed) it's built again from the
 * records.
 */
function storedEvidence(root: string, id: string): { markdown: string; path: string } {
  const task = present(loadTask(root, id));
  if (!task.run || task.state === "running") throw invalid(t("tasks.service.reportAtEnd"));
  const stored = readTaskFile(root, id, "evidence.md");
  let generatedAt = Number.NaN;
  try {
    generatedAt = Date.parse(JSON.parse(readTaskFile(root, id, "evidence.json") ?? "{}").generatedAt);
  } catch {
    // Unreadable: built again below.
  }
  const kept = { markdown: stored ?? "", path: path.join(root, AC_DIR, "tasks", id, "evidence.md") };
  if (stored && generatedAt >= Date.parse(task.updatedAt)) return kept;
  // Its worktree is gone (merged, or cleaned up): the report written when it ended is the one that holds.
  if (stored && task.worktree && codeRootOf(root, task) === root) return kept;
  return writeEvidence(root, task);
}
