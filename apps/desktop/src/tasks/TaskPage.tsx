import {
  type AcceptanceCriterion,
  type AgentRoles,
  type GateRun,
  type PermissionMode,
  type PermissionRequest,
  RpcErrorCode,
  redactSecrets,
  type StepRun,
  type Task,
  type TaskContract,
  type Tier,
  type Triage,
} from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  CalendarClock,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardList,
  ExternalLink,
  FileText,
  GitMerge,
  GitPullRequest,
  ListTree,
  Loader2,
  MinusCircle,
  PanelRight,
  Play,
  Scale,
  Square,
  X,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { type Confirm, Modal } from "../Dialog.tsx";
import { approxUsd, dateTime, seconds as secondsText } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { localized } from "../i18n/shown.ts";
import { Markdown } from "../Markdown.tsx";
import { MODE_NAMES, modelChoices, modeOptions } from "../options.ts";
import type { PermissionAnswer } from "../PermissionDialog.tsx";
import { QuestionCard } from "../QuestionCard.tsx";
import { isRpcError } from "../rpc-client.ts";
import { request, subscribe } from "../sidecar.ts";
import { TranscriptView } from "../TranscriptView.tsx";
import { folderName } from "../tabs.ts";
import type { Item } from "../transcript.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { EditableList, StringList } from "../ui/EditableList.tsx";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";
import { Select } from "../ui/Select.tsx";
import { type AgentClis, AgentPickers, type AgentRole } from "./AgentPickers.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { CreatePrDialog } from "./CreatePr.tsx";
import { DeployCard } from "./DeployCard.tsx";
import { FlowPanel } from "./FlowPanel.tsx";
import { LessonsCard } from "./LessonsCard.tsx";
import { MergeGates } from "./MergeGates.tsx";
import { PrChecks } from "./PrChecks.tsx";
import { ProjectWorkflowNote } from "./ProjectWorkflowNote.tsx";
import {
  canAcceptRisk,
  canContinue,
  childRunBlocker,
  dependsLabel,
  duration,
  failedBefore,
  fromHistory,
  gateKey,
  gateRounds,
  isXl,
  newer,
  passedGate,
  RUNNABLE_TIERS,
  runBlocker,
  runsOfEntry,
  type StepItems,
  stateLabel,
  withStepEvent,
} from "./run.ts";
import {
  approveBlocker,
  budgetText,
  budgetValue,
  checkLabel,
  checkOptions,
  contractChanged,
  DEFAULT_BUDGET_USD,
  NO_BUDGET,
  signalLabel,
  TIER_HELP,
  TIERS,
  tidyContract,
} from "./taskForm.ts";

type Busy =
  | "draft"
  | "retriage"
  | "approve"
  | "revise"
  | "run"
  | "resume"
  | "accept"
  | "split"
  | "approveAll"
  | "continue"
  | null;

/** Profiles a run's write steps can ask in; plan mode doesn't fit a step that must implement. */
const RUN_MODES: Exclude<PermissionMode, "plan">[] = ["default", "acceptEdits", "auto"];

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (n: number) => approxUsd(n, n < 0.1 ? 4 : 2);

/** One entry of a task's thread, in order: a drafting (its events) or the person's reply to the contract. */
type ThreadEntry = { kind: "draft"; sessionId: string } | { kind: "reply"; text: string; at: number };

/**
 * A task as a thread (UX-13, docs/design/chat-and-tasks.md §5), in its own tab: the request, drafting as it reads the
 * project, the contract and the triage as cards that a reply refines, approve on the card; then the run (M3-06), its
 * evidence (M3-09) and its outcome (M3-10). The right panel holds the task's facts and the workspace's files.
 */
export function TaskPage({
  cwd,
  taskId,
  model,
  mode,
  hidden,
  autoDraft,
  confirm,
  onOpenFile,
  onClose,
  onChange,
  approvals,
  onAnswerApproval,
  onStopFromApproval,
  onSchedule,
}: {
  cwd: string;
  taskId: string;
  model: string;
  /** The default permission profile, for a run's write steps. */
  mode: PermissionMode;
  hidden: boolean;
  /** A task just made from the composer: drafting starts as soon as it's loaded. */
  autoDraft: boolean;
  confirm: Confirm;
  /** Opens a file (an absolute path) in the editor from settings. */
  onOpenFile: (file: string) => Promise<unknown>;
  onClose: () => void;
  /** The shown task as it changes, for its tab in the sidebar; `ids` are the tasks whose approvals it shows. */
  onChange?: (task: Task, busy: boolean, ids: string[]) => void;
  /** Task steps' approvals and questions waiting in this workspace (UX-13); the thread shows its own. */
  approvals: PermissionRequest[];
  onAnswerApproval: (request: PermissionRequest, answer: PermissionAnswer) => void;
  onStopFromApproval: (request: PermissionRequest) => void;
  /** Schedules the task to run again (M8-05). */
  onSchedule?: (task: Task) => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [modelAlias, setModelAlias] = useState(model);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [edited, setEdited] = useState<TaskContract | null>(null);
  const [editing, setEditing] = useState(false);
  const [tier, setTier] = useState<Tier>("S");
  const [reason, setReason] = useState("");
  const [budget, setBudget] = useState("");
  /** The agent per role the person picked (M9-06); a role left out runs on Claude. */
  const [agents, setAgents] = useState<AgentRoles>({});
  /** The other agents' CLIs on this computer, for the pickers; null until they've been checked. */
  const [clis, setClis] = useState<AgentClis | null>(null);
  useEffect(() => {
    void request("agents.available", {}).then(setClis, () => setClis(null));
    // The pickers start from the workspace's defaults (M9-06); a role picked here overrides its default.
    void request("workspace.agents", { cwd }).then(setAgents, () => undefined);
  }, [cwd]);
  const [runMode, setRunMode] = useState<Exclude<PermissionMode, "plan">>(mode === "plan" ? "default" : mode);
  const [stepItems, setStepItems] = useState<StepItems>({});
  /**
   * Each running step's session, from its events: a step records its session only when its turn ends, so this is
   * what shows its transcript live (UX-13).
   */
  const [liveSessions, setLiveSessions] = useState<Record<string, string>>({});
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [accepting, setAccepting] = useState(false);
  const [acceptReason, setAcceptReason] = useState("");
  const [sideOpen, setSideOpen] = useState(true);
  const [sideTab, setSideTab] = useState<"task" | "flow">("task");
  /** A step to show in the thread, from the Flow tab: the run opens it, and the thread scrolls to it. */
  const [focus, setFocus] = useState<{ id: string; at: number } | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  /** An XL task's sub-tasks, and a sub-task's XL task, as they are now. */
  const [children, setChildren] = useState<Record<string, Task>>({});
  const [parentTask, setParentTask] = useState<Task | null>(null);
  const shownId = useRef<string | null>(null);
  shownId.current = task?.id ?? null;
  const drafted = useRef(false);

  // A run and a drafting report through notifications: the task as it changes, and its sessions' events.
  useEffect(
    () =>
      subscribe((n) => {
        if (n.method === "task.updated" && n.params.cwd === cwd) {
          const updated = n.params.task;
          setTask((current) => (current?.id === updated.id ? newer(current, updated, "notification") : current));
          setChildren((all) => {
            const known = all[updated.id];
            return known ? { ...all, [updated.id]: newer(known, updated, "notification") } : all;
          });
          setParentTask((p) => (p?.id === updated.id ? newer(p, updated, "notification") : p));
        } else if (n.method === "agent.event" && n.params.task && n.params.task.id === shownId.current) {
          const { sessionId, event, task: tag } = n.params;
          if (tag.stepId === "draft") {
            setThread((all) =>
              all.some((e) => e.kind === "draft" && e.sessionId === sessionId)
                ? all
                : [...all, { kind: "draft", sessionId }],
            );
          } else setLiveSessions((all) => (all[tag.stepId] === sessionId ? all : { ...all, [tag.stepId]: sessionId }));
          setStepItems((items) => withStepEvent(items, sessionId, event, Date.now()));
        }
      }),
    [cwd],
  );

  const subtaskIds = task?.subtasks?.join(",") ?? "";
  const loadChildren = useCallback(
    async (ids: string) => {
      if (!ids) return setChildren({});
      try {
        const list = await Promise.all(ids.split(",").map((id) => request("task.get", { cwd, id })));
        setChildren(Object.fromEntries(list.map((t) => [t.id, t])));
      } catch (err) {
        setError(errorText(err));
      }
    },
    [cwd],
  );
  useEffect(() => {
    void loadChildren(subtaskIds);
  }, [loadChildren, subtaskIds]);

  const parentId = task?.parent?.id ?? null;
  useEffect(() => {
    if (!parentId) return setParentTask(null);
    let live = true;
    request("task.get", { cwd, id: parentId }).then(
      (t) => live && setParentTask(t),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [cwd, parentId]);

  /** This task and its sub-tasks: the approvals the thread shows as cards. */
  const ownIds = [task?.id ?? "", ...(task?.subtasks ?? [])].join(",");
  useEffect(() => {
    if (task) onChange?.(task, busy !== null, ownIds.split(",").filter(Boolean));
  }, [task, busy, onChange, ownIds]);
  const waiting = approvals.filter((a) => a.task && ownIds.split(",").includes(a.task.id));
  const runningStep = task?.state === "running" ? task.run?.steps.find((s) => s.status === "running") : undefined;

  /** The person's message to the running step (UX-13): it joins the step's turn, as in a chat. */
  async function message(text: string) {
    if (!task) return;
    try {
      await request("task.message", { cwd, id: task.id, text });
    } catch (err) {
      setError(errorText(err));
    }
  }

  function show(t: Task) {
    setTask((current) => newer(current, t, "reply"));
    setEdited(t.contract);
    setTier(t.triage?.chosen ?? "S");
    setReason(localized(t.triage?.override?.reason, t.triage?.override?.reasonRef) ?? "");
    setBudget(t.triage ? (t.triage.budgetUsd === null ? NO_BUDGET : String(t.triage.budgetUsd)) : "");
  }

  /** Runs a task action and shows its result; on failure, shows the task as stored (a failed draft records its spend). */
  async function step(kind: Exclude<Busy, null>, id: string, action: () => Promise<Task>) {
    setBusy(kind);
    setError(null);
    try {
      show(await action());
    } catch (err) {
      setError(isRpcError(err, RpcErrorCode.cancelled) ? t("tasks.page.stoppedNothingChanged") : errorText(err));
      await request("task.get", { cwd, id }).then(show, () => undefined);
    } finally {
      setBusy(null);
    }
  }

  const draft = (id: string) =>
    step("draft", id, () => request("task.draft", { cwd, id, ...(modelAlias ? { model: modelAlias } : {}) }));

  /** The person's reply to the draft: drafting runs again with it and the current contract (UX-13). */
  async function reply(text: string) {
    if (!task) return;
    setThread((all) => [...all, { kind: "reply", text, at: Date.now() }]);
    setEditing(false);
    await step("draft", task.id, () =>
      request("task.redraft", { cwd, id: task.id, feedback: text, ...(modelAlias ? { model: modelAlias } : {}) }),
    );
  }

  // The thread opens on the task; a new one drafts at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per task tab.
  useEffect(() => {
    let live = true;
    request("task.get", { cwd, id: taskId }).then(
      (t) => {
        if (!live) return;
        show(t);
        if (autoDraft && !drafted.current && t.state === "draft" && !t.contract) {
          drafted.current = true;
          void draft(t.id);
        }
      },
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [cwd, taskId]);

  /** Approves the contract and the tier, and starts the run right away for an S task (planner.md §15). */
  async function approve(contract: TaskContract, andRun: boolean, id: string) {
    setBusy("approve");
    setError(null);
    try {
      show(
        await request("task.approve", {
          cwd,
          id,
          contract: tidyContract(contract),
          tier,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          budgetUsd: budgetValue(budget),
        }),
      );
      setEditing(false);
      if (andRun) await runTask(id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function runTask(id: string) {
    setStepItems({});
    await step("run", id, () =>
      request("task.start", {
        cwd,
        id,
        permissionMode: runMode,
        ...(modelAlias ? { model: modelAlias } : {}),
        ...(Object.keys(agents).length ? { agents } : {}),
      }),
    );
  }

  async function stop(running: Task) {
    const ok = await confirm({
      title: t("tasks.page.stopTitle"),
      body: <p>{t("tasks.page.stopBody")}</p>,
      confirmLabel: t("tasks.page.stop"),
      danger: true,
    });
    if (ok) await request("task.cancel", { cwd, id: running.id }).catch((err: unknown) => setError(errorText(err)));
  }

  async function acceptRisk(id: string) {
    setAccepting(false);
    await step("accept", id, () => request("task.acceptRisk", { cwd, id, reason: acceptReason.trim() }));
  }

  const split = (id: string) =>
    step("split", id, () => request("task.split", { cwd, id, ...(modelAlias ? { model: modelAlias } : {}) }));

  async function approveAll(id: string) {
    await step("approveAll", id, () => request("task.approveSubtasks", { cwd, id }));
    await loadChildren(subtaskIds);
  }

  async function continueRun(id: string) {
    setStepItems({});
    await step("continue", id, () => request("task.continue", { cwd, id }));
  }

  /** Shows another task in this tab: an XL task's sub-task, or back to the XL task. */
  async function open(id: string) {
    try {
      show(await request("task.get", { cwd, id }));
      setStepItems({});
      setThread([]);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function discard(target: { id: string; request: string }) {
    const ok = await confirm({
      title: t("tasks.page.discardTitle"),
      body: <p>{t("tasks.page.discardBody")}</p>,
      confirmLabel: t("tasks.page.discard"),
      danger: true,
    });
    if (!ok) return;
    try {
      await request("task.delete", { cwd, id: target.id });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const triage = task?.triage ?? null;
  const stale = Boolean(task?.contract && edited && contractChanged(edited, task.contract));
  /** The contract as the card holds it. */
  const form = edited ?? task?.contract ?? null;
  const blocker =
    edited && triage
      ? approveBlocker({ edited, stale, tier, proposed: triage.proposed, reason, budget })
      : t("tasks.page.draftFirst");
  const drafting = busy === "draft";
  const lastDraft = [...thread].reverse().find((e) => e.kind === "draft");
  const bottom = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the thread as it grows.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread.length, task?.state, task?.contract, drafting]);

  if (!task) {
    return (
      <div className="task-thread" hidden={hidden}>
        <div className="task-thread-main">
          {error ? <p className="warn">{error}</p> : <p className="muted task-loading">{t("tasks.page.opening")}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="task-thread" hidden={hidden}>
      <div className="task-thread-main">
        <header className="task-thread-header">
          {task.parent && (
            <button
              type="button"
              className="ghost small"
              onClick={() => task.parent && void open(task.parent.id)}
              disabled={busy !== null}
            >
              <ArrowLeft size={14} />
              {t("tasks.page.backToXl")}
            </button>
          )}
          <ClipboardList size={16} aria-hidden />
          <div className="task-thread-title">
            <h1 title={task.request}>
              {task.parent
                ? t("tasks.page.subtaskTitle", { n: task.parent.index + 1, title: task.title ?? task.request })
                : (task.title ?? task.request)}
            </h1>
            <span className="muted" title={cwd}>
              {t("tasks.page.spent", {
                folders: [folderName(cwd), ...(task.folders ?? []).map((f) => f.name)].join(" + "),
                cost: usd(task.costUsd),
              })}
            </span>
          </div>
          <span className="grow" />
          <StateBadge task={task} />
          <IconButton
            label={sideOpen ? t("tasks.page.hidePanel") : t("tasks.page.showPanel")}
            onClick={() => setSideOpen((v) => !v)}
          >
            <PanelRight size={15} />
          </IconButton>
          <IconButton label={t("tasks.page.closeTab")} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        {error && (
          <div className="banner" role="alert">
            <span className="grow">{error}</span>
            <IconButton label={t("tasks.page.dismiss")} onClick={() => setError(null)}>
              <X size={14} />
            </IconButton>
          </div>
        )}

        <div className="task-thread-scroll" ref={threadRef}>
          <div className="thread">
            <div className="msg user task-request-msg">
              {task.chatContext && <span className="chip">{t("tasks.page.fromChat")}</span>}
              <p>{task.request}</p>
            </div>

            {thread.map((e) =>
              e.kind === "reply" ? (
                <div key={`r-${e.at}`} className="msg user">
                  <p>{e.text}</p>
                </div>
              ) : (
                <DraftBlock
                  key={e.sessionId}
                  items={stepItems[e.sessionId] ?? []}
                  live={drafting && e === lastDraft}
                  cwd={cwd}
                />
              ),
            )}
            {drafting && !lastDraft && (
              <div className="draft-block live">
                <Loader2 size={14} className="spin" aria-hidden /> {t("tasks.page.readingToDraft")} <Elapsed />
              </div>
            )}
            {drafting && (
              <div className="thread-row">
                <button
                  type="button"
                  className="secondary small"
                  onClick={() => void request("task.cancel", { cwd, id: task.id })}
                >
                  {t("tasks.page.stopDrafting")}
                </button>
              </div>
            )}

            {!drafting && task.state === "draft" && !task.contract && (
              <section className="card thread-card">
                <p>{t("tasks.page.notDrafted")}</p>
                <div className="card-footer">
                  <div className="task-model">
                    <Select
                      value={modelAlias}
                      onChange={setModelAlias}
                      options={modelChoices(undefined, modelAlias)}
                      label={t("tasks.page.draftModel")}
                    />
                  </div>
                  <span className="grow" />
                  <button type="button" className="secondary" onClick={() => void discard(task)}>
                    {t("tasks.page.discard")}
                  </button>
                  <button type="button" onClick={() => void draft(task.id)}>
                    {t("tasks.page.draftContract")}
                  </button>
                </div>
              </section>
            )}

            {!drafting && task.state === "draft" && edited && triage && form && (
              <>
                <ContractCard
                  request={task.request}
                  contract={edited}
                  gates={task.availableGates}
                  editing={editing}
                  onEdit={setEditing}
                  onChange={setEdited}
                />
                <TriageCard
                  triage={triage}
                  stale={stale}
                  tier={tier}
                  onTier={(next) => {
                    setTier(next);
                    setBudget((b) =>
                      b === NO_BUDGET && next !== "XL"
                        ? b
                        : String(
                            next === triage.chosen && triage.budgetUsd !== null
                              ? triage.budgetUsd
                              : DEFAULT_BUDGET_USD[next],
                          ),
                    );
                  }}
                  reason={reason}
                  onReason={setReason}
                  budget={budget}
                  onBudget={setBudget}
                  agents={agents}
                  onAgents={setAgents}
                  clis={clis}
                  {...(task.parent ? { tiers: TIERS.filter((x) => x !== "XL") } : {})}
                />
                <div className="thread-actions">
                  {blocker && !stale && <span className="muted">{blocker}</span>}
                  <span className="grow" />
                  <button type="button" className="secondary" onClick={() => void discard(task)}>
                    {t("tasks.page.discard")}
                  </button>
                  {stale ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void step("retriage", task.id, () =>
                          request("task.retriage", { cwd, id: task.id, contract: tidyContract(form) }),
                        )
                      }
                    >
                      {busy === "retriage" && <Loader2 size={14} className="spin" />}
                      {t("tasks.page.retriage")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null || blocker !== null}
                      onClick={() => void approve(form, tier === "S" && !task.parent, task.id)}
                    >
                      {busy === "approve" || busy === "run" ? <Loader2 size={14} className="spin" /> : null}
                      {/* A sub-task runs from its XL task, never on approval. */}
                      {tier === "S" && !task.parent ? t("tasks.page.approveAndRun") : t("tasks.page.approveContract")}
                    </button>
                  )}
                </div>
              </>
            )}

            {task.state !== "draft" && task.contract && task.triage && (
              <ContractView key={task.id} task={task} contract={task.contract} triage={task.triage} />
            )}

            {busy === "split" && (
              <section className="card task-drafting" aria-live="polite">
                <Loader2 size={18} className="spin" aria-hidden />
                <div className="grow">
                  <strong>{t("tasks.page.readingToSplit")}</strong>
                  <p className="muted">
                    {t("tasks.page.splitReadOnly")} <Elapsed />
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void request("task.cancel", { cwd, id: task.id })}
                >
                  {t("tasks.page.cancel")}
                </button>
              </section>
            )}

            {task.run && task.state !== "draft" && task.state !== "ready" && (
              <RunView
                task={task}
                cwd={cwd}
                items={stepItems}
                live={liveSessions}
                focus={focus}
                onLoaded={(sessionId, items) => setStepItems((all) => ({ ...all, [sessionId]: items }))}
                onOpenTask={(id) => void open(id)}
              />
            )}

            {task.worktree && !task.parent && task.state !== "running" && (
              <ResultCard task={task} cwd={cwd} confirm={confirm} onChanged={(t) => show(t)} onError={setError} />
            )}

            {task.worktree &&
              !task.worktree.removed &&
              !task.parent &&
              (task.state === "done" || task.state === "accepted") && (
                <DeployCard task={task} cwd={cwd} onChanged={() => void open(task.id)} />
              )}

            {task.subtasks?.length ? (
              <SubtasksCard
                task={task}
                cwd={cwd}
                subtasks={task.subtasks.flatMap((id) => (children[id] ? [children[id]] : []))}
                busy={busy}
                onOpen={(id) => void open(id)}
                onApproveAll={() => void approveAll(task.id)}
                onSplitAgain={() => void split(task.id)}
              />
            ) : null}

            {task.run && task.state !== "draft" && task.state !== "ready" && task.state !== "running" && (
              <EvidenceCard
                task={task}
                cwd={cwd}
                onOpenFile={(file) =>
                  onOpenFile(file).catch((err: unknown) =>
                    setError(t("tasks.page.openReportFailed", { error: errorText(err) })),
                  )
                }
              />
            )}
            {/* Lessons for CLAUDE.md from the run's records (M8-06): only on request, each one approved. */}
            {task.run && task.state !== "draft" && task.state !== "ready" && task.state !== "running" && (
              <LessonsCard task={task} cwd={cwd} />
            )}
            {waiting.map((a) =>
              a.toolName === "AskUserQuestion" ? (
                <QuestionCard key={a.requestId} request={a} onAnswer={(r) => onAnswerApproval(a, r)} />
              ) : (
                <ApprovalCard
                  key={a.requestId}
                  request={a}
                  cwd={a.task?.cwd ?? cwd}
                  onAnswer={(r) => onAnswerApproval(a, r)}
                  onStopTask={() => onStopFromApproval(a)}
                />
              ),
            )}
            <div ref={bottom} />
          </div>
        </div>

        {task.state === "running" && !isXl(task) && (
          <TaskComposer
            disabled={!runningStep || (runningStep.kind !== "agent" && runningStep.kind !== "fix")}
            busy={false}
            placeholder={
              runningStep && (runningStep.kind === "agent" || runningStep.kind === "fix")
                ? t("tasks.page.messageStep", { step: localized(runningStep.label, runningStep.labelRef) })
                : t("tasks.page.stepTakesNoMessages")
            }
            hint={t("tasks.page.messageStepHint")}
            onSend={(text) => void message(text)}
          />
        )}
        {task.state === "draft" ? (
          <TaskComposer
            disabled={busy !== null || !task.contract}
            busy={drafting}
            modelAlias={modelAlias}
            onModel={setModelAlias}
            onSend={(text) => void reply(text)}
          />
        ) : (
          <footer className="plan-footer">
            {task.state === "running" ? (
              <>
                <span className="muted">
                  {isXl(task)
                    ? t("tasks.page.runCostXl", {
                        cost: usd(task.run?.costUsd ?? 0),
                        budget: budgetText(task.triage?.budgetUsd, true),
                      })
                    : task.triage?.budgetUsd === null
                      ? t("tasks.page.runCostNoBudget", { cost: usd(task.run?.costUsd ?? 0) })
                      : t("tasks.page.runCostOf", {
                          cost: usd(task.run?.costUsd ?? 0),
                          budget: budgetText(task.triage?.budgetUsd),
                        })}
                </span>
                <span className="grow" />
                <button type="button" className="danger" onClick={() => void stop(task)}>
                  <Square size={14} />
                  {t("tasks.page.stop")}
                </button>
              </>
            ) : (
              <>
                <span className="grow" />
                {canAcceptRisk(task) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => {
                      setAcceptReason("");
                      setAccepting(true);
                    }}
                  >
                    {busy === "accept" && <Loader2 size={14} className="spin" />}
                    {t("tasks.page.acceptRisk")}
                  </button>
                )}
                {/* Once split, an XL task's contract is what its sub-tasks were made from: it stays. */}
                {!(isXl(task) && task.subtasks?.length) && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => void step("revise", task.id, () => request("task.revise", { cwd, id: task.id }))}
                  >
                    {t("tasks.page.revise")}
                  </button>
                )}
                {task.state === "interrupted" ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void step("resume", task.id, () => request("task.resume", { cwd, id: task.id }))}
                  >
                    <Play size={14} />
                    {t("tasks.page.resume")}
                  </button>
                ) : canContinue(task) ? (
                  <button type="button" disabled={busy !== null} onClick={() => void continueRun(task.id)}>
                    {busy === "continue" ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                    {t("tasks.page.continue")}
                  </button>
                ) : isXl(task) && task.state === "ready" && !task.subtasks?.length ? (
                  <>
                    <div className="task-model">
                      <Select
                        value={modelAlias}
                        onChange={setModelAlias}
                        options={modelChoices(undefined, modelAlias)}
                        label={t("tasks.page.splitModel")}
                      />
                    </div>
                    <button type="button" disabled={busy !== null} onClick={() => void split(task.id)}>
                      {busy === "split" && <Loader2 size={14} className="spin" />}
                      {t("tasks.page.split")}
                    </button>
                  </>
                ) : isXl(task) && task.state !== "ready" ? null : (
                  <>
                    <ProjectWorkflowNote cwd={cwd} tier={task.triage?.chosen} />
                    <RunButton
                      label={task.run ? t("tasks.page.runAgain") : t("tasks.page.run")}
                      blocker={
                        task.parent
                          ? childRunBlocker(task, parentTask)
                          : runBlocker(
                              task,
                              (task.subtasks ?? []).flatMap((id) => (children[id] ? [children[id]] : [])),
                            )
                      }
                      busy={busy}
                      runMode={runMode}
                      onRunMode={setRunMode}
                      onRun={() => void runTask(task.id)}
                    />
                    {/* An approved task of its own can run on a schedule (M8-05); an XL run needs its split approved. */}
                    {onSchedule && task.contract?.approvedAt && !task.parent && task.triage?.chosen !== "XL" && (
                      <button
                        type="button"
                        className="secondary"
                        title={t("tasks.page.scheduleHint")}
                        onClick={() => onSchedule(task)}
                      >
                        <CalendarClock size={14} />
                        {t("tasks.page.schedule")}
                      </button>
                    )}
                  </>
                )}
              </>
            )}
          </footer>
        )}
      </div>

      {sideOpen && (
        <aside className={`task-side${sideTab === "flow" ? " wide" : ""}`} aria-label={t("tasks.page.task")}>
          <fieldset className="segmented side-tabs">
            <legend className="sr-only">{t("tasks.page.panel")}</legend>
            {(["task", "flow"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={sideTab === k}
                className={sideTab === k ? "active" : undefined}
                onClick={() => setSideTab(k)}
              >
                {k === "task" ? t("tasks.page.task") : t("tasks.page.flow")}
              </button>
            ))}
          </fieldset>
          {sideTab === "task" ? (
            <TaskFacts task={task} cwd={cwd} onOpenTask={(id) => void open(id)} />
          ) : (
            <FlowPanel
              task={task}
              cwd={cwd}
              subtasks={(task.subtasks ?? []).flatMap((id) => (children[id] ? [children[id]] : []))}
              onOpenTask={(id) => void open(id)}
              onTask={show}
              onJump={(id) => {
                setFocus({ id, at: Date.now() });
                requestAnimationFrame(() =>
                  threadRef.current
                    ?.querySelector(`[data-step="${CSS.escape(id)}"]`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" }),
                );
              }}
            />
          )}
        </aside>
      )}

      <Modal
        open={accepting}
        onOpenChange={setAccepting}
        title={t("tasks.page.acceptTitle")}
        description={task.state === "unverified" ? t("tasks.page.acceptUnverified") : t("tasks.page.acceptFailed")}
        actions={
          <>
            <button type="button" className="secondary" onClick={() => setAccepting(false)}>
              {t("tasks.page.cancel")}
            </button>
            <button
              type="button"
              disabled={!acceptReason.trim() || busy !== null}
              onClick={() => void acceptRisk(task.id)}
            >
              {t("tasks.page.acceptWithRisk")}
            </button>
          </>
        }
      >
        <p>
          <Rich k="tasks.page.acceptBody" tags={{ strong: (s) => <strong>{s}</strong> }} />
        </p>
        <Field label={t("tasks.page.acceptReason")}>
          <textarea
            rows={3}
            value={acceptReason}
            onChange={(e) => setAcceptReason(e.target.value)}
            placeholder={t("tasks.page.acceptReasonPlaceholder")}
            maxLength={2000}
          />
        </Field>
      </Modal>
    </div>
  );
}

/** One drafting in the thread: what it read, live while it runs, then folded to a line. */
function DraftBlock({ items, live, cwd }: { items: Item[]; live: boolean; cwd: string }) {
  const tools = items.filter((i) => i.kind === "tool").length;
  return (
    <details className={`draft-block${live ? " live" : ""}`} open={live}>
      <summary>
        {live ? <Loader2 size={14} className="spin" aria-hidden /> : <CircleCheck size={14} aria-hidden />}
        {live ? t("tasks.draftBlock.drafting") : t("tasks.draftBlock.drafted")}
        <span className="muted"> · {t("tasks.draftBlock.toolCalls", { count: tools })}</span>
      </summary>
      <TranscriptView cwd={cwd} items={items} onOpenFile={() => undefined} />
    </details>
  );
}

/**
 * The draft contract as a card (UX-13): read as a document, edited in place with "Edit". A reply in the composer
 * drafts it again instead.
 */
function ContractCard({
  request,
  contract,
  gates,
  editing,
  onEdit,
  onChange,
}: {
  request: string;
  contract: TaskContract;
  gates: Task["availableGates"];
  editing: boolean;
  onEdit: (on: boolean) => void;
  onChange: (c: TaskContract) => void;
}) {
  const lists: [string, string[]][] = [
    [t("tasks.contract.constraints"), contract.constraints],
    [t("tasks.contract.outOfScope"), contract.outOfScope],
    [t("tasks.contract.risks"), contract.risks],
    [t("tasks.contract.openQuestions"), contract.openQuestions],
  ];
  return (
    <section className="card thread-card contract-card">
      <div className="card-title">
        <ClipboardList size={16} aria-hidden />
        <h2>{t("tasks.contract.title")}</h2>
        <span className="muted">{t("tasks.contractCard.draft")}</span>
        <span className="grow" />
        <button type="button" className="ghost small" onClick={() => onEdit(!editing)}>
          {editing ? t("tasks.contractCard.doneEditing") : t("tasks.contractCard.edit")}
        </button>
      </div>
      {editing ? (
        <ContractForm request={request} contract={contract} gates={gates} onChange={onChange} />
      ) : (
        <>
          <p className="contract-objective">
            {contract.objective || <span className="muted">{t("tasks.contractCard.noObjective")}</span>}
          </p>
          <h3 className="contract-heading">{t("tasks.contractCard.doneWhen")}</h3>
          <ul className="contract-criteria">
            {contract.acceptanceCriteria.map((c) => (
              <li key={c.id} className="contract-criterion">
                <span>{c.text}</span>
                <span className="badge">{checkLabel(c.check)}</span>
              </li>
            ))}
          </ul>
          {lists
            .filter(([, items]) => items.length > 0)
            .map(([label, items]) => (
              <div key={label}>
                <h3 className="contract-heading">{label}</h3>
                <ul className="contract-list">
                  {items.map((x) => (
                    <li key={x} className="contract-item">
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          {contract.affectedAreas.length > 0 && (
            <>
              <h3 className="contract-heading">{t("tasks.contract.affectedAreas")}</h3>
              <p className="contract-areas">
                {contract.affectedAreas.map((a) => (
                  <code key={a}>{a}</code>
                ))}
              </p>
            </>
          )}
          <p className="muted contract-hint">{t("tasks.contractCard.hint")}</p>
        </>
      )}
    </section>
  );
}

/** The task's facts for the right panel: state, tier, budget, spend, worktree and overlapping tasks. */
function TaskFacts({ task, cwd, onOpenTask }: { task: Task; cwd: string; onOpenTask: (id: string) => void }) {
  const { label } =
    task.state === "draft"
      ? { label: task.contract ? t("tasks.state.draft") : t("tasks.state.new") }
      : stateLabel(task.state);
  return (
    <div className="task-facts-panel">
      <h2>{t("tasks.facts.title")}</h2>
      <dl className="task-facts">
        <dt>{t("tasks.facts.state")}</dt>
        <dd>{label}</dd>
        <dt>{t("tasks.contract.tier")}</dt>
        <dd>
          {task.triage
            ? t("tasks.contract.tierValue", { tier: task.triage.chosen, help: TIER_HELP[task.triage.chosen] })
            : t("tasks.facts.afterDrafting")}
        </dd>
        {task.triage && (
          <>
            <dt>{t("tasks.contract.budget")}</dt>
            <dd>{budgetText(task.triage.budgetUsd, task.triage.chosen === "XL")}</dd>
          </>
        )}
        <dt>{t("tasks.facts.spent")}</dt>
        <dd>{usd(task.costUsd)}</dd>
        {task.worktree && (
          <>
            <dt>{t("tasks.facts.branch")}</dt>
            <dd>
              <code>{task.worktree.branch}</code>
              {task.worktree.removed ? ` ${t("tasks.facts.worktreeRemoved")}` : ""}
            </dd>
          </>
        )}
        <dt>{t("tasks.facts.savedIn")}</dt>
        <dd>
          <code>{`.agentchainer/tasks/${task.id}/`}</code>
        </dd>
      </dl>
      <Overlaps task={task} cwd={cwd} onOpenTask={onOpenTask} />
    </div>
  );
}

/** The task thread's composer: while it's a draft, a reply drafts the contract again with it (UX-13). */
function TaskComposer({
  disabled,
  busy,
  modelAlias,
  onModel,
  placeholder,
  hint,
  onSend,
}: {
  disabled: boolean;
  busy: boolean;
  /** The drafting model, while the task is a draft. */
  modelAlias?: string;
  onModel?: (alias: string) => void;
  placeholder?: string;
  hint?: string;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    setText("");
    onSend(trimmed);
  };
  return (
    <div className="composer task-composer">
      <div className="composer-box" data-mode="plan">
        <textarea
          rows={2}
          value={text}
          aria-label={onModel ? t("tasks.composer.replyLabel") : t("tasks.composer.messageLabel")}
          placeholder={busy ? t("tasks.composer.drafting") : (placeholder ?? t("tasks.composer.replyPlaceholder"))}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-toolbar">
          {onModel && (
            <Select
              compact
              label={t("tasks.page.draftModel")}
              value={modelAlias ?? ""}
              options={modelChoices(undefined, modelAlias)}
              onChange={onModel}
            />
          )}
          <span className="grow" />
          <span className="composer-hint">{hint ?? t("tasks.composer.replyHint")}</span>
          <button
            type="button"
            className="icon round"
            disabled={disabled || !text.trim()}
            onClick={send}
            aria-label={onModel ? t("tasks.composer.sendReply") : t("tasks.composer.sendMessage")}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function StateBadge({ task }: { task: Task }) {
  if (task.state === "draft") {
    return <span className="badge">{task.contract ? t("tasks.state.draft") : t("tasks.state.new")}</span>;
  }
  const { label, tone } = stateLabel(task.state);
  return (
    <span className={`badge tone-${tone}`}>
      {label} · {task.triage?.chosen}
    </span>
  );
}

function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span>{secondsText(seconds)}</span>;
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="task-request">
      <span className="field-label">{t("tasks.quote.request")}</span>
      {text}
    </blockquote>
  );
}

function ContractForm({
  request,
  contract,
  gates,
  onChange,
}: {
  request: string;
  contract: TaskContract;
  gates: Task["availableGates"];
  onChange: (c: TaskContract) => void;
}) {
  const set = <K extends keyof TaskContract>(key: K, value: TaskContract[K]) => onChange({ ...contract, [key]: value });
  const options = checkOptions(gates);
  return (
    <section className="card task-contract" aria-label={t("tasks.contract.title")}>
      <div className="card-title">
        <ClipboardList size={16} aria-hidden />
        <h2>{t("tasks.contract.title")}</h2>
        <span className="muted">{t("tasks.contractForm.subtitle")}</span>
      </div>
      <Quote text={request} />
      {contract.openQuestions.length > 0 && (
        <div className="callout task-questions">
          <strong>
            <CircleHelp size={14} aria-hidden /> {t("tasks.contract.openQuestions")}
          </strong>
          <p className="muted">{t("tasks.contractForm.settleQuestions")}</p>
          <StringList
            label={t("tasks.contractForm.openQuestion")}
            items={contract.openQuestions}
            onChange={(v) => set("openQuestions", v)}
            multiline
          />
        </div>
      )}
      <Field label={t("tasks.contract.objective")} help={t("tasks.contractForm.objectiveHelp")}>
        <textarea rows={2} value={contract.objective} onChange={(e) => set("objective", e.target.value)} />
      </Field>
      <div className="task-field">
        <span className="field-label">{t("tasks.contract.acceptanceCriteria")}</span>
        <span className="field-help">{t("tasks.contractForm.criteriaHelp")}</span>
        <EditableList<AcceptanceCriterion>
          label={t("tasks.contractForm.criterion")}
          items={contract.acceptanceCriteria}
          onChange={(v) => set("acceptanceCriteria", v)}
          addLabel={t("tasks.contractForm.addCriterion")}
          empty={t("tasks.contractForm.noCriteria")}
          multiline
          text={(c) => c.text}
          withText={(c, text) => ({ ...c, text })}
          blank={() => ({ id: "", text: "", check: "manual" })}
          extra={(c, setC) => (
            <Select
              compact
              value={c.check}
              onChange={(v) => setC({ ...c, check: v as AcceptanceCriterion["check"] })}
              options={options}
              label={t("tasks.contractForm.howChecked")}
            />
          )}
        />
      </div>
      <ListField
        label={t("tasks.contract.affectedAreas")}
        help={t("tasks.contractForm.affectedAreasHelp")}
        mono
        items={contract.affectedAreas}
        onChange={(v) => set("affectedAreas", v)}
      />
      <ListField
        label={t("tasks.contract.constraints")}
        help={t("tasks.contractForm.constraintsHelp")}
        items={contract.constraints}
        onChange={(v) => set("constraints", v)}
      />
      <ListField
        label={t("tasks.contract.outOfScope")}
        help={t("tasks.contractForm.outOfScopeHelp")}
        items={contract.outOfScope}
        onChange={(v) => set("outOfScope", v)}
      />
      <ListField
        label={t("tasks.contract.risks")}
        help={t("tasks.contractForm.risksHelp")}
        items={contract.risks}
        onChange={(v) => set("risks", v)}
      />
    </section>
  );
}

function ListField({
  label,
  help,
  items,
  onChange,
  mono,
}: {
  label: string;
  help: string;
  items: string[];
  onChange: (items: string[]) => void;
  mono?: boolean;
}) {
  return (
    <div className={`task-field${mono ? " task-paths" : ""}`}>
      <span className="field-label">{label}</span>
      <span className="field-help">{help}</span>
      {/* Paths are short and stay on one line; sentences wrap. */}
      <StringList
        label={label}
        items={items}
        onChange={onChange}
        empty={t("tasks.contractForm.none")}
        {...(mono ? { mono } : { multiline: true })}
      />
    </div>
  );
}

function TriageCard({
  triage,
  stale,
  tier,
  onTier,
  reason,
  onReason,
  budget,
  onBudget,
  agents,
  onAgents,
  clis,
  tiers = TIERS,
}: {
  triage: Triage;
  stale: boolean;
  tier: Tier;
  onTier: (t: Tier) => void;
  reason: string;
  onReason: (r: string) => void;
  budget: string;
  onBudget: (b: string) => void;
  agents?: AgentRoles;
  onAgents?: (a: AgentRoles) => void;
  clis?: AgentClis | null;
  /** The tiers on offer: a sub-task runs as S, M or L. */
  tiers?: readonly Tier[];
}) {
  return (
    <aside className="card task-triage" aria-label={t("tasks.triage.title")}>
      <div className="card-title">
        <Scale size={16} aria-hidden />
        <h2>{t("tasks.triage.title")}</h2>
        <span className="grow" />
        <span className={`tier-badge tier-${triage.proposed}`} title={t("tasks.triage.proposedTier")}>
          {triage.proposed}
        </span>
      </div>
      {stale && <p className="callout">{t("tasks.triage.stale")}</p>}
      <div className="task-why">
        <span className="field-label">{t("tasks.triage.why")}</span>
        <ul className="task-signals">
          {triage.signals.map((s) => (
            <li key={s.signal}>
              <div className="task-signal-head">
                <span className="task-signal-name">{signalLabel(s.signal)}</span>
                {s.floor && (
                  <span className="badge" title={t("tasks.triage.atLeast", { tier: s.floor })}>
                    {`≥ ${s.floor}`}
                  </span>
                )}
              </div>
              <span>{localized(s.detail, s.detailRef)}</span>
            </li>
          ))}
          <li>
            <div className="task-signal-head">
              <span className="task-signal-name">{t("tasks.triage.model")}</span>
              {triage.model && <span className="badge">{triage.model.tier}</span>}
            </div>
            {triage.model ? (
              <span>
                {localized(triage.model.rationale, triage.model.rationaleRef)}{" "}
                <span className="muted">
                  {triage.model.confidence === "high"
                    ? t("tasks.triage.confidenceHigh")
                    : triage.model.confidence === "medium"
                      ? t("tasks.triage.confidenceMedium")
                      : t("tasks.triage.confidenceLow")}
                </span>
              </span>
            ) : (
              <span className="muted">
                {t("tasks.triage.unavailable", { error: localized(triage.modelError, triage.modelErrorRef) ?? "" })}
              </span>
            )}
          </li>
        </ul>
        {triage.model && triage.floor !== "S" && triage.proposed !== triage.model.tier && (
          <p className="field-help">{t("tasks.triage.floorAbove", { floor: triage.floor, tier: triage.model.tier })}</p>
        )}
      </div>
      <fieldset className="task-field">
        <legend className="field-label">{t("tasks.contract.tier")}</legend>
        <div className="task-tiers">
          {tiers.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={tier === option}
              className={`chip${tier === option ? " on" : ""}`}
              onClick={() => onTier(option)}
            >
              {option}
              {option === triage.proposed && (
                <span className="muted">
                  {" · "}
                  {t("tasks.triage.proposed")}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="field-help">{TIER_HELP[tier]}</span>
      </fieldset>
      {tier !== triage.proposed && (
        <Field
          label={t("tasks.triage.whyOverride", { tier, proposed: triage.proposed })}
          help={t("tasks.triage.whyOverrideHelp")}
        >
          <textarea rows={2} value={reason} onChange={(e) => onReason(e.target.value)} />
        </Field>
      )}
      <Field
        label={tier === "XL" ? t("tasks.triage.budgetPerSubtask") : t("tasks.triage.budget")}
        help={budget === NO_BUDGET ? t("tasks.triage.noBudgetHelp") : t("tasks.triage.budgetHelp")}
      >
        <input
          type="number"
          min={0.1}
          max={1000}
          step={0.5}
          value={budget === NO_BUDGET ? "" : budget}
          placeholder={budget === NO_BUDGET ? t("tasks.triage.noBudget") : undefined}
          disabled={budget === NO_BUDGET}
          onChange={(e) => onBudget(e.target.value)}
        />
      </Field>
      {tier !== "XL" && (
        <label className="check no-budget">
          <input
            type="checkbox"
            checked={budget === NO_BUDGET}
            onChange={(e) => onBudget(e.target.checked ? NO_BUDGET : String(DEFAULT_BUDGET_USD[tier]))}
          />
          {t("tasks.triage.noBudget")}
        </label>
      )}
      {agents && onAgents && clis && (
        <AgentPickers
          roles={ROLES_BY_TIER[tier]}
          agents={agents}
          onAgents={onAgents}
          clis={clis}
          help={t("tasks.agents.help")}
        />
      )}
    </aside>
  );
}

/** The roles a tier's steps take (M9-06): S implements; M and L also plan and review. XL's sub-tasks choose their own. */
const ROLES_BY_TIER: Record<Tier, AgentRole[]> = {
  S: ["implement"],
  M: ["plan", "implement", "review"],
  L: ["plan", "implement", "review"],
  XL: [],
};

/**
 * The approved contract, read-only: the request, the facts on one label column, the criteria with how each is checked,
 * and the lists as bullets. Once the task has run, it folds to its objective so the run comes first.
 */
function ContractView({ task, contract, triage }: { task: Task; contract: TaskContract; triage: Triage }) {
  const [open, setOpen] = useState(!task.run);
  const lists: [string, string[]][] = [
    [t("tasks.contract.constraints"), contract.constraints],
    [t("tasks.contract.outOfScope"), contract.outOfScope],
    [t("tasks.contract.risks"), contract.risks],
  ];
  return (
    <section className="card task-contract-view">
      <div className="card-title">
        <ClipboardList size={16} aria-hidden />
        <h2>{t("tasks.contract.title")}</h2>
        {contract.approvedAt && (
          <span className="muted">{t("tasks.contractView.approved", { date: dateTime(contract.approvedAt) })}</span>
        )}
        <span className="grow" />
        <span className={`tier-badge tier-${triage.chosen}`} title={TIER_HELP[triage.chosen]}>
          {triage.chosen}
        </span>
        {task.run && (
          <button type="button" className="ghost small task-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronRight size={14} aria-hidden />
            {open ? t("tasks.contractView.hide") : t("tasks.contractView.show")}
          </button>
        )}
      </div>
      {task.state === "ready" && task.parent && <p className="callout">{t("tasks.contractView.runsFromXl")}</p>}
      {task.state === "ready" && !task.parent && (
        <p className="callout">
          {triage.chosen === "XL"
            ? t("tasks.contractView.readyXl")
            : RUNNABLE_TIERS.has(triage.chosen)
              ? t("tasks.contractView.readyRun")
              : t("tasks.blocker.laterUpdate", { tier: triage.chosen })}{" "}
          <Rich
            k="tasks.contractView.savedIn"
            params={{ path: `.agentchainer/tasks/${task.id}/` }}
            tags={{ code: (s) => <code>{s}</code> }}
          />
        </p>
      )}
      {!open ? (
        <p className="task-contract-summary">{contract.objective}</p>
      ) : (
        <>
          <Quote text={task.request} />
          <dl className="task-facts">
            <dt>{t("tasks.contract.objective")}</dt>
            <dd>{contract.objective}</dd>
            <dt>{t("tasks.contract.tier")}</dt>
            <dd>
              {t("tasks.contract.tierValue", { tier: triage.chosen, help: TIER_HELP[triage.chosen] })}
              {triage.override && (
                <span className="muted">
                  {" "}
                  {t("tasks.contractView.overridden", {
                    tier: triage.proposed,
                    reason: localized(triage.override.reason, triage.override.reasonRef),
                  })}
                </span>
              )}
            </dd>
            <dt>{t("tasks.contract.budget")}</dt>
            <dd>{budgetText(triage.budgetUsd, triage.chosen === "XL")}</dd>
          </dl>
          <div className="task-field">
            <span className="field-label">{t("tasks.contract.acceptanceCriteria")}</span>
            <ul className="task-criteria">
              {contract.acceptanceCriteria.map((c) => (
                <li key={c.id}>
                  <span>{c.text}</span>
                  <span className="badge">{checkLabel(c.check)}</span>
                </li>
              ))}
            </ul>
          </div>
          <dl className="task-facts">
            {contract.affectedAreas.length > 0 && (
              <div className="task-fact">
                <dt>{t("tasks.contract.affectedAreas")}</dt>
                <dd>
                  <ul className="task-paths-list">
                    {contract.affectedAreas.map((a) => (
                      <li key={a}>
                        <code>{a}</code>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            {lists
              .filter(([, items]) => items.length)
              .map(([label, items]) => (
                <div key={label} className="task-fact">
                  <dt>{label}</dt>
                  <dd>
                    <ul>
                      {items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ))}
          </dl>
        </>
      )}
    </section>
  );
}

function StepIcon({ status }: { status: StepRun["status"] }) {
  if (status === "running") return <Loader2 size={15} className="spin" aria-label={t("tasks.step.running")} />;
  if (status === "done") return <CircleCheck size={15} className="ok" aria-label={t("tasks.step.done")} />;
  if (status === "failed") return <CircleX size={15} className="err" aria-label={t("tasks.step.failed")} />;
  return <MinusCircle size={15} className="muted" aria-label={t("tasks.step.stopped")} />;
}

/**
 * The run (M3-06): the outcome, a timeline of steps (each opens its session's transcript, or its gate runs), and every
 * gate run with its real exit code.
 */
function RunView({
  task,
  cwd,
  items,
  live,
  focus,
  onLoaded,
  onOpenTask,
}: {
  task: Task;
  cwd: string;
  items: StepItems;
  /** Running steps' sessions, by step id, until each step records its own. */
  live: Record<string, string>;
  /** A step picked on the Flow tab: it opens. */
  focus: { id: string; at: number } | null;
  onLoaded: (sessionId: string, items: StepItems[string]) => void;
  /** Opens a sub-task's page, from an XL run's timeline. */
  onOpenTask: (id: string) => void;
}) {
  const run = task.run;
  const [open, setOpen] = useState<string | null>(null);
  const [, tick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens the step picked on the Flow tab, each time it's picked.
  useEffect(() => {
    const entry = focus && task.run?.steps.find((s) => s.id === focus.id);
    if (entry) void toggle(entry, true);
  }, [focus]);
  // Running steps' durations count up.
  useEffect(() => {
    if (task.state !== "running") return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [task.state]);
  if (!run) return null;
  const { label, tone } = stateLabel(task.state);
  const running = run.steps.find((s) => s.status === "running");
  const shown = open ?? running?.id ?? null;
  const before = failedBefore(task);

  async function toggle(entry: StepRun, keepOpen = false) {
    const next = shown === entry.id && !keepOpen ? "" : entry.id;
    setOpen(next);
    const sessionId = entry.sessionId;
    if (next && sessionId && !items[sessionId] && entry.status !== "running") {
      try {
        onLoaded(sessionId, fromHistory((await request("session.history", { cwd, sessionId })).events));
      } catch {
        onLoaded(sessionId, []);
      }
    }
  }

  return (
    <>
      <div className="run-divider">
        <Play size={14} aria-hidden />
        <span>{t("tasks.run.title")}</span>
        <span className={`badge tone-${tone}`}>{label}</span>
        <span className="grow" />
        <span className="muted">
          {isXl(task)
            ? t("tasks.run.costXl", { mode: MODE_NAMES[run.permissionMode], cost: usd(run.costUsd) })
            : task.triage?.budgetUsd === null
              ? t("tasks.run.costNoBudget", { mode: MODE_NAMES[run.permissionMode], cost: usd(run.costUsd) })
              : t("tasks.run.costOf", {
                  mode: MODE_NAMES[run.permissionMode],
                  cost: usd(run.costUsd),
                  budget: budgetText(task.triage?.budgetUsd),
                })}
        </span>
      </div>
      {run.steps.map((entry) => {
        const expanded = shown === entry.id;
        const gates = runsOfEntry(task, entry);
        const sessionId = entry.sessionId ?? live[entry.id];
        const sessionItems = sessionId ? items[sessionId] : undefined;
        return (
          <section key={entry.id} className={`step-block task-step ${entry.status}`} data-step={entry.id}>
            <button
              type="button"
              className="task-step-head step-head"
              aria-expanded={expanded}
              onClick={() => void toggle(entry)}
            >
              <ChevronRight size={14} className="task-step-chevron" aria-hidden />
              <StepIcon status={entry.status} />
              <span className="task-step-label">{localized(entry.label, entry.labelRef)}</span>
              {entry.role && <span className="chip step-role">{entry.role}</span>}
              {entry.group && (
                <span
                  className="badge"
                  title={t("tasks.run.parallelHint", { group: localized(entry.group, entry.groupRef) })}
                >
                  {t("tasks.run.parallel")}
                </span>
              )}
              <span className="grow muted task-step-note">{localized(entry.note, entry.noteRef)}</span>
              <span className="muted">{duration(entry.startedAt, entry.endedAt)}</span>
              {(entry.kind === "agent" || entry.kind === "fix" || entry.kind === "subtask") && (
                <span className="muted">{usd(entry.costUsd)}</span>
              )}
            </button>
            {expanded && (
              <div className="step-body">
                {entry.kind === "gates" || entry.kind === "baseline" ? (
                  <GateList runs={gates} before={entry.kind === "gates" ? before : undefined} />
                ) : entry.kind === "subtask" && entry.taskId ? (
                  <div className="task-step-empty task-step-actions">
                    <span className="muted grow">
                      {localized(entry.note, entry.noteRef) ?? t("tasks.run.subtaskNote")}
                    </span>
                    <button type="button" className="secondary small" onClick={() => onOpenTask(entry.taskId ?? "")}>
                      {t("tasks.run.openSubtask")}
                    </button>
                  </div>
                ) : entry.kind === "setup" || entry.kind === "merge" ? (
                  <p className="muted task-step-empty">
                    {localized(entry.note, entry.noteRef) ?? t("tasks.run.working")}
                  </p>
                ) : sessionItems?.length ? (
                  <TranscriptView cwd={cwd} items={sessionItems} />
                ) : (
                  <p className="muted task-step-empty">
                    {entry.status === "running" ? t("tasks.run.waiting") : t("tasks.run.noTranscript")}
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
      {run.outcome && <p className={`callout tone-${tone} run-outcome`}>{localized(run.outcome, run.outcomeRef)}</p>}
      {run.acceptance && (
        <p className="callout">
          <strong>{t("tasks.run.riskAccepted")}</strong> {dateTime(run.acceptance.at)}: {run.acceptance.reason}
        </p>
      )}
      <section className="card">
        <div className="card-title">
          <h2>{t("tasks.run.gates")}</h2>
          <span className="muted">{t("tasks.run.gatesSubtitle")}</span>
        </div>
        {run.gates.length === 0 && run.baseline.length === 0 ? (
          <EmptyState>{t("tasks.run.noGates")}</EmptyState>
        ) : (
          <>
            {run.baseline.length > 0 && (
              <div className="task-gate-round">
                <span className="field-label">{t("tasks.run.beforeTask")}</span>
                <GateList runs={run.baseline} />
              </div>
            )}
            {gateRounds(run.gates).map((round) => (
              <div key={round[0]?.round} className="task-gate-round">
                <span className="field-label">{t("tasks.run.round", { n: (round[0]?.round ?? 0) + 1 })}</span>
                <GateList runs={round} before={before} />
              </div>
            ))}
          </>
        )}
        {run.notRun.length > 0 && <p className="muted">{t("tasks.run.notRun", { gates: run.notRun.join(", ") })}</p>}
      </section>
    </>
  );
}

/** `before`: the gates that failed before the task, marked in later rounds. */
function GateList({ runs, before }: { runs: GateRun[]; before?: ReadonlySet<string> }) {
  if (!runs.length) return <p className="muted task-step-empty">{t("tasks.gateList.empty")}</p>;
  return (
    <ul className="task-gates">
      {runs.map((g) => (
        <li key={`${g.folder ?? ""}-${g.kind}-${g.package}-${g.round}`}>
          <details>
            <summary>
              {passedGate(g) ? (
                <CircleCheck size={14} className="ok" aria-label={t("tasks.gateList.passed")} />
              ) : (
                <CircleX size={14} className="err" aria-label={t("tasks.gateList.failed")} />
              )}
              {g.folder && <span className="chip">{g.folder}</span>}
              <span className="task-gate-kind">{g.kind}</span>
              <code>{g.command}</code>
              {g.package !== "." && g.package !== g.folder && <span className="muted">{g.package}</span>}
              {before?.has(gateKey(g)) && (
                <span className="badge">
                  {passedGate(g) ? t("tasks.gateList.fixedBefore") : t("tasks.gateList.failedBefore")}
                </span>
              )}
              <span className="grow" />
              <span className="muted">
                {g.timedOut ? t("tasks.gateList.timedOut") : t("tasks.gateList.exit", { code: String(g.exitCode) })} ·{" "}
                {secondsText((g.durationMs / 1000).toFixed(1))}
              </span>
            </summary>
            {g.changed?.length ? (
              <p className="muted">
                {g.kind === "format"
                  ? t("tasks.gateList.formatted", { files: g.changed.join(", ") })
                  : t("tasks.gateList.reverted", { files: g.changed.join(", ") })}
              </p>
            ) : null}
            <pre className="task-gate-log">{redactSecrets(g.tail) || t("tasks.gateList.noOutput")}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

/**
 * The evidence report (M3-09), built by the sidecar from what the run recorded: changed files, real gate runs,
 * criteria, review, approvals and guard blocks, risks and cost. Copy gives the markdown; the file is in the task folder.
 */
function EvidenceCard({
  task,
  cwd,
  onOpenFile,
}: {
  task: Task;
  cwd: string;
  onOpenFile: (file: string) => Promise<unknown>;
}) {
  const [report, setReport] = useState<{ markdown: string; path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetched again whenever the task changes (an acceptance, a new run).
  useEffect(() => {
    let live = true;
    setError(null);
    request("task.evidence", { cwd, id: task.id }).then(
      (r) => live && setReport(r),
      (err: unknown) => live && setError(errorText(err)),
    );
    return () => {
      live = false;
    };
  }, [cwd, task.id, task.updatedAt]);
  return (
    <section className="card task-evidence">
      <div className="card-title">
        <FileText size={16} aria-hidden />
        <h2>{t("tasks.evidence.title")}</h2>
        <span className="muted">{t("tasks.evidence.subtitle")}</span>
        <span className="grow" />
        {report && <CopyButton text={report.markdown} label={t("tasks.evidence.copy")} />}
        {report && (
          <button type="button" className="ghost small" onClick={() => void onOpenFile(report.path)}>
            <ExternalLink size={13} />
            {t("tasks.evidence.openInEditor")}
          </button>
        )}
      </div>
      {error ? (
        <p className="muted">{t("tasks.evidence.failed", { error })}</p>
      ) : !report ? (
        <p className="muted">
          <Loader2 size={14} className="spin" aria-hidden /> {t("tasks.evidence.building")}
        </p>
      ) : (
        <>
          {open && (
            <div className="task-evidence-body">
              <Markdown text={report.markdown} />
            </div>
          )}
          <div className="card-footer">
            <button
              type="button"
              className="ghost small task-evidence-toggle"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <ChevronRight size={14} aria-hidden />
              {open ? t("tasks.evidence.hide") : t("tasks.evidence.show")}
            </button>
            <span className="grow" />
            <span className="muted" title={report.path}>
              {`.agentchainer/tasks/${task.id}/evidence.md`}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

/** The run's permission profile and the Run button, with why it can't run when it can't. */
function RunButton({
  label,
  blocker,
  busy,
  runMode,
  onRunMode,
  onRun,
}: {
  label: string;
  blocker: string | null;
  busy: Busy;
  runMode: Exclude<PermissionMode, "plan">;
  onRunMode: (mode: Exclude<PermissionMode, "plan">) => void;
  onRun: () => void;
}) {
  return (
    <>
      {blocker && <span className="muted">{blocker}</span>}
      <div className="task-model">
        <Select
          value={runMode}
          onChange={(v) => onRunMode(v as Exclude<PermissionMode, "plan">)}
          options={modeOptions(RUN_MODES, true)}
          label={t("tasks.runButton.profile")}
        />
      </div>
      <button type="button" disabled={busy !== null || blocker !== null} onClick={onRun}>
        {busy === "run" ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
        {label}
      </button>
    </>
  );
}

/**
 * An XL task's sub-tasks (M3-07): each opens its own page, where its contract and tier are edited and approved like any
 * task's. Before the run, the card says where the task branch starts and what each worktree runs first.
 */
function SubtasksCard({
  task,
  cwd,
  subtasks,
  busy,
  onOpen,
  onApproveAll,
  onSplitAgain,
}: {
  task: Task;
  cwd: string;
  subtasks: Task[];
  busy: Busy;
  onOpen: (id: string) => void;
  onApproveAll: () => void;
  onSplitAgain: () => void;
}) {
  const order = task.subtasks ?? [];
  const drafts = subtasks.filter((c) => c.state === "draft").length;
  const ran = subtasks.some((c) => c.run || (c.state !== "draft" && c.state !== "ready"));
  const [setup, setSetup] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (task.state !== "ready") return;
    let live = true;
    request("workspace.scan", { cwd }).then(
      ({ profile }) =>
        live && setSetup(profile.packages.find((p) => p.commands.install)?.commands.install?.run ?? null),
      () => undefined,
    );
    request("workspace.files", { cwd }).then(
      (f) => live && setDirty(f.files.some((x) => x.status !== undefined && x.status !== "untracked")),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [cwd, task.state]);
  return (
    <section className="card">
      <div className="card-title">
        <ListTree size={16} aria-hidden />
        <h2>{t("tasks.subtasks.title")}</h2>
        <span className="muted">{t("tasks.subtasks.subtitle")}</span>
        <span className="grow" />
        {task.state === "ready" && !ran && (
          <button type="button" className="ghost small" disabled={busy !== null} onClick={onSplitAgain}>
            {t("tasks.subtasks.splitAgain")}
          </button>
        )}
        {drafts > 0 && (
          <button type="button" className="secondary small" disabled={busy !== null} onClick={onApproveAll}>
            {busy === "approveAll" && <Loader2 size={14} className="spin" />}
            {t("tasks.subtasks.approveAll")}
          </button>
        )}
      </div>
      {task.state === "ready" && (
        <p className="callout">
          {drafts ? t("tasks.subtasks.openToEdit") : t("tasks.subtasks.allApproved")}{" "}
          {dirty ? t("tasks.subtasks.branchStartsDirty") : t("tasks.subtasks.branchStarts")}
          {setup && (
            <>
              {" "}
              <Rich
                k="tasks.subtasks.setupFirst"
                params={{ command: setup }}
                tags={{ code: (s) => <code>{s}</code> }}
              />
            </>
          )}
        </p>
      )}
      <ol className="task-subtasks">
        {order.map((id, i) => {
          const c = subtasks.find((x) => x.id === id);
          if (!c) {
            return (
              <li key={id} className="muted">
                {t("tasks.subtasks.loading")}
              </li>
            );
          }
          const { label, tone } = stateLabel(c.state);
          const deps = dependsLabel(c, order);
          return (
            <li key={id}>
              <button type="button" className="task-subtask" onClick={() => onOpen(id)}>
                <span className="task-subtask-n">{i + 1}</span>
                <span className="task-subtask-title">{c.title ?? c.request}</span>
                {deps && <span className="muted">{deps}</span>}
                <span className="grow" />
                {c.triage && <span className={`tier-badge tier-${c.triage.chosen}`}>{c.triage.chosen}</span>}
                <span className={`badge tone-${tone}`}>{label}</span>
                {c.run && <span className="muted">{usd(c.run.costUsd)}</span>}
                <ChevronRight size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Other tasks whose live branches change the same files as this one (M5-01). Nothing is blocked; merging both may
 * conflict. Read again whenever the task changes.
 */
function Overlaps({ task, cwd, onOpenTask }: { task: Task; cwd: string; onOpenTask: (id: string) => void }) {
  const [overlaps, setOverlaps] = useState<{ taskId: string; title: string; files: string[] }[]>([]);
  const live = !!task.worktree && !task.worktree.removed && !task.mergedInto && !task.parent;
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the task changes.
  useEffect(() => {
    if (!live) return setOverlaps([]);
    let current = true;
    request("task.overlaps", { cwd, id: task.id }).then(
      (r) => current && setOverlaps(r.overlaps),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [cwd, task.id, task.updatedAt, live]);
  if (!overlaps.length) return null;
  return (
    <div className="callout task-overlaps" role="status">
      <AlertTriangle size={15} aria-hidden />
      <div>
        {overlaps.map((o) => (
          <p key={o.taskId}>
            <Rich
              k="tasks.overlaps.alsoChanges"
              params={{ title: o.title, files: o.files.join(", ") }}
              tags={{
                task: (s) => (
                  <button type="button" className="link" onClick={() => onOpenTask(o.taskId)}>
                    {s}
                  </button>
                ),
              }}
            />
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * A run's result on its own branch (M5-01; XL since M3-07): the user's branch changes only when they merge it. What
 * the run left uncommitted is committed on the task's branch first. Clean up removes the worktrees (the branches
 * stay).
 */
function ResultCard({
  task,
  cwd,
  confirm,
  onChanged,
  onError,
}: {
  task: Task;
  cwd: string;
  confirm: Confirm;
  onChanged: (task: Task) => void;
  onError: (message: string) => void;
}) {
  const wt = task.worktree;
  const [status, setStatus] = useState<{ branch: string | null; dirty: boolean } | null>(null);
  const [busy, setBusy] = useState<"merge" | "cleanup" | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [creatingPr, setCreatingPr] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the task changes.
  useEffect(() => {
    let live = true;
    request("workspace.files", { cwd }).then(
      (f) =>
        live &&
        setStatus({ branch: f.branch, dirty: f.files.some((x) => x.status !== undefined && x.status !== "untracked") }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [cwd, task.updatedAt]);
  if (!wt) return null;
  const finished = task.state === "done" || task.state === "accepted";
  const mergeBlock = !finished
    ? t("tasks.result.mergeNotFinished")
    : status?.dirty
      ? t("tasks.result.mergeDirty")
      : null;

  async function act(kind: "merge" | "cleanup", action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
      onChanged(await request("task.get", { cwd, id: task.id }));
    } catch (err) {
      onError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function cleanUp() {
    const ok = await confirm({
      title: isXl(task) ? t("tasks.result.removeTitleXl") : t("tasks.result.removeTitle"),
      body: (
        <p>
          <Rich
            k="tasks.result.removeBody"
            params={{ path: ".agentchainer/worktrees/" }}
            tags={{ code: (s) => <code>{s}</code> }}
          />
        </p>
      ),
      confirmLabel: isXl(task) ? t("tasks.result.removeConfirmXl") : t("tasks.result.removeConfirm"),
    });
    if (ok)
      await act("cleanup", () =>
        request("task.cleanup", { cwd, id: task.id, deleteBranches: false }).then(() => undefined),
      );
  }

  return (
    <section className="card">
      <div className="card-title">
        <GitMerge size={16} aria-hidden />
        <h2>{t("tasks.result.title")}</h2>
        <span className="muted">{t("tasks.result.subtitle")}</span>
      </div>
      <dl className="task-facts">
        <dt>{t("tasks.result.branch")}</dt>
        <dd>
          <code>{wt.branch}</code>
        </dd>
        <dt>{t("tasks.result.merged")}</dt>
        <dd>
          {task.mergedInto
            ? t("tasks.result.mergedInto", { branch: task.mergedInto.branch, date: dateTime(task.mergedInto.at) })
            : t("tasks.result.notYet")}
        </dd>
        <dt>{isXl(task) ? t("tasks.result.worktreesXl") : t("tasks.result.worktree")}</dt>
        <dd>{wt.removed ? t("tasks.result.removed") : <code>{".agentchainer/worktrees/"}</code>}</dd>
        <dt>{t("tasks.result.pullRequest")}</dt>
        <dd>
          {task.pr ? (
            <button type="button" className="link" onClick={() => void openUrl(task.pr?.url ?? "")}>
              {t(task.pr.draft ? "tasks.result.prIntoDraft" : "tasks.result.prInto", {
                number: task.pr.number,
                base: task.pr.base,
              })}
            </button>
          ) : (
            t("tasks.result.none")
          )}
        </dd>
        {(task.folders ?? []).map((f) =>
          f.pr ? (
            <Fragment key={f.name}>
              <dt>{t("tasks.result.inFolder", { folder: f.name })}</dt>
              <dd>
                <button type="button" className="link" onClick={() => void openUrl(f.pr?.url ?? "")}>
                  {t("tasks.result.prIntoDraft", { number: f.pr.number, base: f.pr.base })}
                </button>
              </dd>
            </Fragment>
          ) : null,
        )}
      </dl>
      {task.pr && <PrChecks task={task} cwd={cwd} onChanged={onChanged} />}
      {task.pr && <MergeGates task={task} cwd={cwd} onChanged={onChanged} />}
      {conflicts.length > 0 && (
        <p className="callout">{t("tasks.result.conflicts", { files: conflicts.join(", ") })}</p>
      )}
      <div className="card-footer">
        {mergeBlock && !task.mergedInto && !task.pr && <span className="muted">{mergeBlock}</span>}
        <span className="grow" />
        {!wt.removed && !task.pr && finished && !task.mergedInto && (
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => setCreatingPr(true)}>
            <GitPullRequest size={14} />
            {t("tasks.result.createPr")}
          </button>
        )}
        {!wt.removed && (
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void cleanUp()}>
            {busy === "cleanup" && <Loader2 size={14} className="spin" />}
            {t("tasks.result.cleanUp")}
          </button>
        )}
        {!task.mergedInto && !task.pr && (
          <button
            type="button"
            disabled={busy !== null || mergeBlock !== null}
            onClick={() =>
              void act("merge", async () => {
                const r = await request("task.mergeResult", { cwd, id: task.id });
                setConflicts(r.conflicts);
              })
            }
          >
            {busy === "merge" ? <Loader2 size={14} className="spin" /> : <GitMerge size={14} />}
            {t("tasks.result.mergeInto", { branch: status?.branch ?? t("tasks.result.yourBranch") })}
          </button>
        )}
      </div>
      <CreatePrDialog
        open={creatingPr}
        task={task}
        cwd={cwd}
        onOpenChange={setCreatingPr}
        onCreated={(t) => onChanged(t)}
      />
    </section>
  );
}
