import { spawnSync } from "node:child_process";
import path from "node:path";
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
import { findTool, toolsDir } from "../bootstrap/tools.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { RpcFailure } from "../rpc.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { listFiles } from "../workspace.ts";
import { availableGates, draftContract, normalizeContract } from "./contract.ts";
import { buildEvidence, type FileChange, renderEvidence, type SecretsScan } from "./evidence.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun, Orchestrator, parseReview } from "./orchestrator.ts";
import { fileStats, type SessionHost, sessionRunner, startBase } from "./runner.ts";
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
const STARTABLE = new Set<Task["state"]>(["ready", "done", "accepted", "failed", "unverified", "cancelled"]);

function launch(root: string, task: Task, host: SessionHost, notify: (task: Task) => void, resume: boolean): void {
  const workflow = Object.values(library.workflows).find((w) => w.id === task.run?.workflow.id);
  if (!workflow) throw invalid(`The workflow ${task.run?.workflow.id} isn't in this version of the app.`);
  // The runner reports approvals and guard blocks as they happen; they go into the run's records.
  let orchestrator: Orchestrator | undefined;
  const runner = sessionRunner(root, task, library, host, {
    approval: (record) => orchestrator?.recordApproval(record),
    guardBlock: (block) => orchestrator?.recordGuardBlock(block),
  });
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
    resume,
  });
  const running = orchestrator;
  runs.set(task.id, running);
  void running.run().finally(() => {
    runs.delete(task.id);
    if (shuttingDown) return;
    const ended = present(running.current);
    try {
      writeEvidence(root, ended);
    } catch {
      // The report can be built again on request (task.evidence).
    }
    notify(ended);
  });
}

/** Starts a run of an approved task (S, M or L; XL comes later). It continues in the background and reports through `notify`. */
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
    throw invalid(`${task.triage.chosen} tasks can run in a later update; S, M and L tasks can run now.`);
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

/* ---------- Accepted risk (M3-10) and evidence (M3-09) ---------- */

/** Ends a failed or unverified run as accepted with risk, with the user's reason; the report keeps it. */
export function acceptRisk(root: string, id: string, reason: string, now = new Date()): Task {
  const task = present(loadTask(root, id));
  if (runs.has(id)) throw invalid("The task is running. Stop it first.");
  if ((task.state !== "failed" && task.state !== "unverified") || !task.run) {
    throw invalid("Only a failed or unverified run can be accepted with risk.");
  }
  const why = reason.trim();
  if (!why) throw invalid("Say why the risk is acceptable.");
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

/** gitleaks over the changed files, when it's installed (the catalog's copy, or one on PATH). */
export function scanSecrets(root: string, files: FileChange[]): SecretsScan {
  const gitleaks = findTool("gitleaks", toolsDir());
  if (!gitleaks) return { ran: false, why: "gitleaks isn't installed" };
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
    else if (r.status !== 0)
      return {
        ran: false,
        why: `gitleaks failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200) || `exit ${r.status}`}`,
      };
  }
  return { ran: true, scanned: targets.length, flagged };
}

/** Builds the evidence from the task's records and writes `evidence.json` and `evidence.md` in its folder. */
export function writeEvidence(root: string, task: Task, now = new Date()): { markdown: string; path: string } {
  if (!task.run) throw invalid("The task hasn't run yet.");
  const files = fileStats(root, task.run.base, task.run.untrackedAtStart);
  const reviewText = readTaskFile(root, task.id, "review.json");
  let review = null;
  try {
    review = reviewText ? parseReview(JSON.parse(reviewText), reviewText) : null;
  } catch {
    review = null;
  }
  const evidence = buildEvidence({
    task,
    files,
    summary: readTaskFile(root, task.id, "summary.md"),
    review,
    secrets: scanSecrets(root, files),
    now,
  });
  const markdown = renderEvidence(evidence);
  writeTaskFile(root, task.id, "evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
  writeTaskFile(root, task.id, "evidence.md", markdown);
  return { markdown, path: path.join(root, AC_DIR, "tasks", task.id, "evidence.md") };
}

/**
 * The stored report while nothing in the task changed after it was written; otherwise (a newer run, an interrupted
 * one, a run from before reports existed) it's built again from the records.
 */
export function taskEvidence(root: string, id: string): { markdown: string; path: string } {
  const task = present(loadTask(root, id));
  if (!task.run || task.state === "running") throw invalid("The report is written when the run ends.");
  const stored = readTaskFile(root, id, "evidence.md");
  let generatedAt = Number.NaN;
  try {
    generatedAt = Date.parse(JSON.parse(readTaskFile(root, id, "evidence.json") ?? "{}").generatedAt);
  } catch {
    // Unreadable: built again below.
  }
  if (stored && generatedAt >= Date.parse(task.updatedAt)) {
    return { markdown: stored, path: path.join(root, AC_DIR, "tasks", id, "evidence.md") };
  }
  return writeEvidence(root, task);
}
