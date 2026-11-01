import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  MAX_CI_FIXES,
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
import { branches, merge, pushBranch } from "../git.ts";
import { createPr, failedJobLog, findPr, type Gh, githubStatus, jobOf, prChecks, prState } from "../github.ts";
import { RpcFailure } from "../rpc.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { git, listFiles, repoOf } from "../workspace.ts";
import { availableGates, draftContract, normalizeContract } from "./contract.ts";
import { buildEvidence, type FileChange, renderEvidence, type SecretsScan, sectionLines } from "./evidence.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun, Orchestrator, type OrchestratorDeps, parseReview } from "./orchestrator.ts";
import { changedPaths, fileStats, type SessionHost, sessionRunner, startBase, untracked } from "./runner.ts";
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
import { setupNote, XlOrchestrator } from "./xl.ts";
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
  if (task.parent && tier === "XL") throw invalid("A sub-task runs as S, M or L.");
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

/** Runs in progress in this sidecar, by task id: a tier's workflow, or an XL run. */
const runs = new Map<string, { cancel: () => void; readonly current: Task }>();
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
  if (runs.has(id)) throw invalid("The task is running. Stop it first.");
  const task = loadTask(root, id);
  if (task.parent) throw invalid("A sub-task goes with its XL task: delete that one instead.");
  const children = (task.subtasks ?? []).map((c) => loadTask(root, c));
  if (children.some((c) => runs.has(c.id))) throw invalid("A sub-task is running. Stop the task first.");
  for (const t of [...children, task]) {
    if (t.worktree && !t.worktree.removed) removeWorktree(root, t.worktree.path);
    if (t !== task) deleteTask(root, t.id);
  }
  deleteTask(root, id);
}

/** Where a task's code is: its worktree while it exists, otherwise the workspace (one without git). */
function codeRootOf(root: string, task: Task): string {
  const wt = task.worktree;
  return wt && !wt.removed && existsSync(wt.path) ? codeRootIn(root, wt.path) : root;
}

/** Tasks a new run can start from. */
const STARTABLE = new Set<Task["state"]>(["ready", "done", "accepted", "failed", "unverified", "cancelled"]);

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
  const workflow = Object.values(library.workflows).find((w) => w.id === task.run?.workflow.id);
  if (!workflow) throw invalid(`The workflow ${task.run?.workflow.id} isn't in this version of the app.`);
  // The runner reports approvals and guard blocks as they happen; they go into the run's records.
  let orchestrator: Orchestrator | undefined;
  const runner = sessionRunner(codeRootOf(root, task), task, library, host, {
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
    ...extra,
  });
  return orchestrator;
}

/**
 * The task's branch, ready to work in: the project's install command in its new worktree (M5-01). The note says which
 * branch, and that the workspace's uncommitted changes aren't on it.
 */
async function readyBranch(root: string, task: Task, signal: AbortSignal): Promise<{ ok: boolean; note: string }> {
  const wt = task.worktree;
  if (!wt) return { ok: true, note: "" };
  const run = await setupWorktree(codeRootIn(root, wt.path), signal);
  const notes = [
    wt.branch,
    ...(run ? [setupNote(run)] : []),
    ...(hasTrackedChanges(root) ? ["your uncommitted changes in the workspace aren't on this branch"] : []),
  ];
  return { ok: !run || (run.exitCode === 0 && !run.timedOut), note: notes.join("; ") };
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
  running: { run: () => Promise<Task>; cancel: () => void; readonly current: Task },
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
  opts: { permissionMode: PermissionMode; model?: string },
  notify: (task: Task) => void,
  now = new Date(),
): Task {
  const task = present(loadTask(root, id));
  if (runs.has(id)) throw invalid("The task is already running.");
  if (!STARTABLE.has(task.state) || !task.contract?.approvedAt || !task.triage) {
    throw invalid("Approve the contract and the tier first.");
  }
  if (task.triage.chosen === "XL") return startXl(root, task, host, opts, notify, now);
  if (task.parent) requireOwnRun(task);
  const workflow = library.workflows[task.triage.chosen];
  if (!workflow) throw invalid(`${task.triage.chosen} tasks have no workflow in this version of the app.`);
  // A sub-task runs in the worktree its XL task made; any other task gets its own.
  const branched = task.parent ? { task, fresh: false } : taskBranch(root, task);
  const wt = branched.task.worktree;
  // Changes count from where the worktree branched, whichever run this is.
  const base = wt ? { base: wt.base, untrackedAtStart: wt.untracked } : startBase(root);
  const started: Task = {
    ...branched.task,
    state: "running",
    run: newRun(workflow, { ...opts, ...base }, now),
    updatedAt: now.toISOString(),
  };
  saveTask(root, started);
  notify(started);
  void launch(root, started, host, notify, false, branched.fresh);
  return started;
}

/** A sub-task runs on its own only in its worktree, and not while its XL task runs. */
function requireOwnRun(task: Task): void {
  if (task.parent && runs.has(task.parent.id)) throw invalid("Its XL task is running: sub-tasks run from there.");
  if (!task.worktree || task.worktree.removed || !existsSync(task.worktree.path)) {
    throw invalid("Sub-tasks run from their XL task: run or continue that one.");
  }
}

/** Continues an interrupted run from the step it stopped in. */
export function resumeTask(root: string, id: string, host: SessionHost, notify: (task: Task) => void): Task {
  const task = present(loadTask(root, id));
  if (task.state !== "interrupted" || !task.run) throw invalid("Only an interrupted run can be resumed.");
  if (task.triage?.chosen === "XL") return continueTask(root, id, host, notify);
  if (task.parent) requireOwnRun(task);
  const running: Task = { ...task, state: "running" };
  // A run cut off while its branch was being set up sets it up again.
  const unready =
    !!task.worktree && !task.parent && task.run.steps.some((s) => s.kind === "setup" && s.status !== "done");
  void launch(root, running, host, notify, true, unready);
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

/* ---------- XL: split, sub-tasks in worktrees, merge (M3-07) ---------- */

/** XL runs in worktrees: the workspace must be in git, with a commit to branch from. */
function requireRepoWithCommit(root: string): void {
  if (!repoOf(root) || !headOf(root)) {
    throw invalid("XL tasks run in git worktrees: this workspace needs a git repository with at least one commit.");
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
    throw invalid("Approve the contract with tier XL first.");
  }
  requireRepoWithCommit(root);
  const xl = library.xl;
  if (!xl) throw invalid("This version of the app has no XL workflow.");
  const previous = subtasksOf(root, task);
  if (previous.some((c) => c.run || (c.state !== "draft" && c.state !== "ready"))) {
    throw invalid("Sub-tasks have run already, so the split stays. Discard the task to start over.");
  }
  const contract = task.contract;
  const budgetUsd = task.triage.budgetUsd;
  return cancellable(id, async (controller) => {
    const profile = detectWorkspace(root);
    const r = await proposeSplit(claude.sdk, claude.claudePath, root, contract, profile, xl.split, {
      ...(model ? { model } : {}),
      abortController: controller,
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
      const proposal = triageRecord(
        found,
        { model: { tier: sub.tier, rationale: "Proposed by the split.", confidence: "medium" } },
        now,
      );
      // A sub-task runs as S, M or L; the XL budget is per sub-task.
      const chosen = proposal.proposed === "XL" ? "L" : proposal.proposed;
      const child: Task = {
        ...created,
        title: sub.title,
        contract: sub.contract,
        triage: {
          ...proposal,
          chosen,
          budgetUsd: Math.min(DEFAULT_BUDGET_USD[chosen], budgetUsd),
          ...(chosen !== proposal.proposed ? { override: { reason: "Sub-tasks run as S, M or L." } } : {}),
        },
        parent: { id, index },
        dependsOn: sub.dependsOn.map((j) => ids[j]).filter((d): d is string => d !== undefined),
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
  if (!task.subtasks?.length) throw invalid("Split the task first.");
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
        `Sub-task ${(child.parent?.index ?? 0) + 1} (${child.title ?? child.request}): ${err instanceof Error ? err.message : String(err)}`,
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
  const xl = library.xl;
  if (!xl) throw invalid("This version of the app has no XL workflow.");
  if (task.state !== "ready") throw invalid("An XL run that stopped goes on with Continue.");
  requireRepoWithCommit(root);
  const children = subtasksOf(root, task);
  if (!children.length || children.some((c) => c.state !== "ready")) {
    throw invalid("Split the task and approve every sub-task first.");
  }
  const started: Task = {
    ...task,
    state: "running",
    run: newRun(xl, { ...opts, base: headOf(root), untrackedAtStart: [] }, now),
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
  if (task.triage?.chosen !== "XL" || !task.run) throw invalid("Only an XL run can be continued.");
  if (runs.has(id)) throw invalid("The task is already running.");
  if (!["failed", "unverified", "cancelled", "interrupted"].includes(task.state)) {
    throw invalid("Only a stopped, failed or interrupted XL run can be continued.");
  }
  const { endedAt: _ended, outcome: _outcome, ...run } = task.run;
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
  const xl = library.xl;
  const run = task.run;
  if (!xl || !run) throw invalid("This version of the app has no XL workflow.");
  const world = gitWorld(root, {
    load: (id) => present(loadTask(root, id)),
    save: (t) => {
      saveTask(root, t);
      notify(present(t));
    },
    runChild: (child, resumeChild) => {
      const workflow = child.triage ? library.workflows[child.triage.chosen] : undefined;
      const wt = child.worktree;
      if (!workflow || !wt) throw new Error(`Sub-task ${child.id} has no workflow or worktree.`);
      const now = new Date();
      const started: Task = resumeChild
        ? { ...child, state: "running" }
        : {
            ...child,
            state: "running",
            run: newRun(
              workflow,
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
  if (!task.worktree || task.parent) throw invalid("This task has no branch of its own to merge.");
  if (runs.has(id)) throw invalid("The task is running. Stop it first.");
  if (task.state !== "done" && task.state !== "accepted") {
    throw invalid("Merge once the run is Done, or accept its risk first.");
  }
  if (hasTrackedChanges(root)) throw invalid("Commit or stash your changes first: the merge would mix with them.");
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
  const objective = task.contract?.objective || task.request;
  const subject = title ?? shortTitle(objective);
  const message = `${subject}\n\n${subject === objective ? "" : `${objective}\n\n`}AgentChainer task ${task.id}`;
  try {
    commitAll(codeRootIn(root, wt.path), message, wt.untracked);
  } catch (err) {
    throw invalid(`Committing the task's changes failed: ${err instanceof Error ? err.message : String(err)}`);
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
  if (task.parent) throw invalid("A sub-task's worktree goes with its XL task.");
  if (runs.has(id)) throw invalid("The task is running. Stop it first.");
  for (const t of [...subtasksOf(root, task), task]) {
    const wt = t.worktree;
    if (!wt) continue;
    // What the run left uncommitted goes on its branch first, so removing the folder loses nothing.
    if (!deleteBranches) commitResult(root, t);
    if (!wt.removed) removeWorktree(root, wt.path);
    if (deleteBranches) deleteBranch(root, wt.branch);
    saveTask(root, { ...loadTask(root, t.id), worktree: { ...wt, removed: true } });
  }
}

/* ---------- Pull requests (M5-02) ---------- */

/** GitHub allows 65,536 characters in a PR body; the report is cut before that, with a pointer to the full file. */
const MAX_PR_BODY = 60_000;

/** A task that can become a PR: ended Done or accepted, with its own branch and a worktree to commit from. */
function shippable(root: string, id: string): Task & { worktree: NonNullable<Task["worktree"]> } {
  const task = present(loadTask(root, id));
  if (task.parent) throw invalid("A sub-task's work goes in with its XL task's branch.");
  if (runs.has(id)) throw invalid("The task is running. Stop it first.");
  if (task.state !== "done" && task.state !== "accepted") {
    throw invalid("Create a PR once the run is Done, or accept its risk first.");
  }
  const wt = task.worktree;
  if (!wt || wt.removed || !existsSync(wt.path)) throw invalid("The task has no worktree to push from.");
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
  if (!base) throw invalid("The workspace isn't on a branch, so the PR has no base. Check one out first.");
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
  const evidence = taskEvidence(root, task.id).markdown.replace(/^# .*\n+/, "");
  const footer = ["", "---", `Opened from AgentChainer task \`${task.id}\`.`];
  let body = [...contract, "## Evidence", "", evidence.trim(), ...footer].join("\n");
  if (body.length > MAX_PR_BODY) {
    body = `${body.slice(0, MAX_PR_BODY)}\n\n…the report goes on in \`.agentchainer/tasks/${task.id}/evidence.md\`.${footer.join("\n")}`;
  }
  return body;
}

/** What Create PR would send, without sending anything. */
export function prPreview(root: string, id: string, gh: Gh | null) {
  const task = shippable(root, id);
  return {
    github: githubStatus(root, gh),
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
export function createTaskPr(
  root: string,
  id: string,
  opts: { title: string; draft: boolean },
  gh: Gh | null,
  now = new Date(),
): Task {
  const task = shippable(root, id);
  const status = githubStatus(root, gh);
  if (!gh || status.state !== "ready") {
    throw invalid(
      status.state === "missing"
        ? "The GitHub CLI (gh) isn't installed."
        : status.state === "no-remote"
          ? "The repository has no origin remote on GitHub."
          : `gh isn't signed in to ${status.host}. Run \`gh auth login\` in a terminal.`,
    );
  }
  const base = prBase(root, task);
  const head = task.worktree.branch;
  commitResult(root, task);
  if (git(["rev-list", "--count", `${base}..${head}`], root).stdout.trim() === "0") {
    throw invalid(`${head} has no commits that ${base} doesn't have: there is nothing to propose.`);
  }
  // Nothing leaves the machine before the changed files were scanned for secrets (T-08).
  const code = codeRootIn(root, task.worktree.path);
  const changed = git(["diff", "--name-only", "--no-renames", `${base}...${head}`, "--", "."], code)
    .stdout.split("\n")
    .filter((f) => f && existsSync(path.join(code, ...f.split("/"))))
    .map((f): FileChange => ({ path: f, status: "modified", added: null, removed: null }));
  const scan = scanSecrets(code, changed);
  if (scan.ran && scan.flagged.length) {
    throw invalid(`gitleaks flagged possible secrets in ${scan.flagged.join(", ")}. Remove them before pushing.`);
  }
  pushBranch(root, head);
  const existing = findPr(gh, root, head);
  let pr = existing;
  if (!pr) {
    writeTaskFile(root, id, "pr-body.md", prBody(root, task));
    const bodyFile = path.join(root, AC_DIR, "tasks", id, "pr-body.md");
    pr = createPr(gh, root, { base, head, title: opts.title, bodyFile, draft: opts.draft });
  }
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
    },
    updatedAt: now.toISOString(),
  };
  saveTask(root, next);
  return present(next);
}

/* ---------- CI status and Fix CI (M5-03) ---------- */

function withPr(root: string, id: string, gh: Gh | null): { task: Task; pr: NonNullable<Task["pr"]>; gh: Gh } {
  const task = present(loadTask(root, id));
  if (!task.pr) throw invalid("The task has no pull request yet.");
  if (!gh) throw invalid("The GitHub CLI (gh) isn't installed.");
  return { task, pr: task.pr, gh };
}

/** The task's PR on GitHub and its checks. */
export function prStatus(root: string, id: string, gh: Gh | null) {
  const { pr, gh: run } = withPr(root, id, gh);
  return { ...prState(run, root, pr.number), checks: prChecks(run, root, pr.number) };
}

/** The failed steps' log of one of the PR's checks, named by its link, which must be one of the PR's. */
export function ciLog(root: string, id: string, link: string, gh: Gh | null): string {
  const { pr, gh: run } = withPr(root, id, gh);
  if (!prChecks(run, root, pr.number).some((c) => c.link === link)) throw invalid("That isn't one of the PR's checks.");
  const job = jobOf(link);
  if (!job) throw invalid("Only GitHub Actions logs can be read here. Open the check's page instead.");
  return failedJobLog(run, root, job);
}

/**
 * Starts a Fix CI round on a failing check of the task's PR, after the user saw its log. It runs in the background
 * like a run; when it ends Done, what it changed is committed and pushed (never forced). Rounds are capped.
 */
export function fixCiTask(
  root: string,
  id: string,
  link: string,
  host: SessionHost,
  gh: Gh | null,
  notify: (task: Task) => void,
  now = new Date(),
): Task {
  const task = shippable(root, id);
  const { pr, gh: run } = withPr(root, id, gh);
  const fixes = pr.fixes ?? [];
  if (fixes.length >= MAX_CI_FIXES) {
    throw invalid(
      `This PR had its ${MAX_CI_FIXES} Fix CI rounds. Look at the failure yourself, or run the task again.`,
    );
  }
  const check = prChecks(run, root, pr.number).find((c) => c.link === link);
  if (check?.bucket !== "fail") throw invalid("That check isn't failing.");
  const job = jobOf(link);
  if (!job) throw invalid("Only GitHub Actions logs can be read here. Open the check's page instead.");
  const log = failedJobLog(run, root, job);
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
  void track(root, id, round, notify).then((ended) => {
    let state: "done" | "failed" | "cancelled" =
      ended.state === "done" ? "done" : ended.state === "cancelled" ? "cancelled" : "failed";
    let outcome: string | null = null;
    const latest = loadTask(root, id);
    if (state === "done" && latest.worktree) {
      try {
        commitResult(root, latest, `Fix CI: ${check.name}`);
        pushBranch(root, latest.worktree.branch);
      } catch (err) {
        state = "failed";
        outcome = `The fix passed the gates, but pushing it failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const head = latest.worktree ? git(["rev-parse", latest.worktree.branch], root).stdout.trim() : "";
    const next: Task = {
      ...latest,
      ...(outcome && latest.run ? { state: "failed" as const, run: { ...latest.run, outcome } } : {}),
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
  // XL tasks and sub-tasks changed their worktree, where the files their setup installed don't count.
  const code = codeRootOf(root, task);
  const files = fileStats(code, task.run.base, task.worktree?.untracked ?? task.run.untrackedAtStart);
  const children = subtasksOf(root, task);
  const reviewText = readTaskFile(root, task.id, "review.json");
  let review = null;
  try {
    review = reviewText ? parseReview(JSON.parse(reviewText), reviewText) : null;
  } catch {
    review = null;
  }
  const evidence = buildEvidence({
    task: children.length ? withSubtaskRecords(task, children) : task,
    files,
    summary: children.length ? subtaskSummaries(root, children) : readTaskFile(root, task.id, "summary.md"),
    review,
    secrets: scanSecrets(code, files),
    subtasks: children.map((c) => ({
      number: (c.parent?.index ?? 0) + 1,
      title: c.title ?? c.request,
      tier: c.triage?.chosen ?? null,
      state: c.state,
      costUsd: c.run?.costUsd ?? 0,
      outcome: c.run?.outcome ?? null,
      report: path.join(AC_DIR, "tasks", c.id, "evidence.md"),
    })),
    now,
  });
  const markdown = renderEvidence(evidence);
  writeTaskFile(root, task.id, "evidence.json", `${JSON.stringify(evidence, null, 2)}\n`);
  writeTaskFile(root, task.id, "evidence.md", markdown);
  return { markdown, path: path.join(root, AC_DIR, "tasks", task.id, "evidence.md") };
}

/** An XL task's report lists the approvals and guard blocks of its sub-tasks' steps, each marked with its sub-task. */
function withSubtaskRecords(task: Task, children: Task[]): Task {
  if (!task.run) return task;
  const mark = (c: Task) => `Sub-task ${(c.parent?.index ?? 0) + 1}`;
  return {
    ...task,
    run: {
      ...task.run,
      approvals: children.flatMap((c) =>
        (c.run?.approvals ?? []).map((a) => ({ ...a, label: `${mark(c)}: ${a.label}` })),
      ),
      guardBlocks: children.flatMap((c) => c.run?.guardBlocks ?? []),
    },
  };
}

/** What an XL task's files are for, and its implementers' notes, from its sub-tasks' latest summaries. */
function subtaskSummaries(root: string, children: Task[]): string {
  const changes: string[] = [];
  const notes: string[] = [];
  for (const c of children) {
    const text = readTaskFile(root, c.id, "summary.md");
    changes.push(...sectionLines(text, "Changes"));
    notes.push(...sectionLines(text, "Notes").map((n) => `Sub-task ${(c.parent?.index ?? 0) + 1}: ${n}`));
  }
  return ["## Changes", ...changes.map((l) => `- ${l}`), "", "## Notes", ...notes.map((l) => `- ${l}`)].join("\n");
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
  const kept = { markdown: stored ?? "", path: path.join(root, AC_DIR, "tasks", id, "evidence.md") };
  if (stored && generatedAt >= Date.parse(task.updatedAt)) return kept;
  // Its worktree is gone (merged, or cleaned up): the report written when it ended is the one that holds.
  if (stored && task.worktree && codeRootOf(root, task) === root) return kept;
  return writeEvidence(root, task);
}
