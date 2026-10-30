import { RpcErrorCode, type Task, type TaskContract, type Tier, type Triage } from "@agentchainer/protocol";
import { AC_DIR } from "../ac-dir.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { RpcFailure } from "../rpc.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { listFiles } from "../workspace.ts";
import { availableGates, draftContract, normalizeContract } from "./contract.ts";
import { createTask, loadTask, saveTask } from "./store.ts";
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

export function cancelTask(id: string): boolean {
  const controller = running.get(id);
  controller?.abort();
  return controller !== undefined;
}

function requireDraft(task: Task): void {
  if (task.state !== "draft") throw invalid("The contract is approved. Revise it to make changes.");
}

export function newTask(root: string, request: string): Task {
  const text = request.trim();
  if (!text) throw invalid("Describe the task first.");
  return createTask(root, text, availableGates(detectWorkspace(root)));
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
      availableGates: availableGates(profile),
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
  if (task.state === "draft" || !task.contract) return task;
  const { approvedAt: _approved, ...contract } = task.contract;
  const next: Task = { ...task, state: "draft", contract, updatedAt: now.toISOString() };
  saveTask(root, next);
  return next;
}
