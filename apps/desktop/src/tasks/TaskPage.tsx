import {
  type AcceptanceCriterion,
  type GateRun,
  type PermissionMode,
  RpcErrorCode,
  type StepRun,
  type Task,
  type TaskContract,
  type TaskSummary,
  type Tier,
  type Triage,
} from "@agentchainer/protocol";
import {
  ArrowLeft,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardList,
  Loader2,
  MinusCircle,
  Play,
  Scale,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { MODE_NAMES, MODELS, modeOptions } from "../options.ts";
import { isRpcError } from "../rpc-client.ts";
import { request, subscribe } from "../sidecar.ts";
import { TranscriptView } from "../TranscriptView.tsx";
import { folderName } from "../tabs.ts";
import { ActionMenu } from "../ui/ActionMenu.tsx";
import { EditableList, StringList } from "../ui/EditableList.tsx";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";
import { Select } from "../ui/Select.tsx";
import {
  duration,
  fromHistory,
  gateRounds,
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
  checkLabel,
  checkOptions,
  contractChanged,
  DEFAULT_BUDGET_USD,
  TIER_HELP,
  TIERS,
  tidyContract,
} from "./taskForm.ts";

type Busy = "draft" | "retriage" | "approve" | "revise" | "run" | "resume" | null;

/** Profiles a run's write steps can ask in; plan mode doesn't fit a step that must implement. */
const RUN_MODES: Exclude<PermissionMode, "plan">[] = ["default", "acceptEdits", "auto"];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (n: number) => `≈$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/**
 * A task (M3, preview): the request, a contract Claude drafts from the repository (read-only), and a tier from triage,
 * approved together; then the run (M3-06): each step a Claude session shown in a timeline, the gates the app runs
 * itself, and fix rounds. Opens over Home or a session, like Workspace settings.
 */
export function TaskPage({
  cwd,
  model,
  mode,
  backLabel,
  confirm,
  onBack,
}: {
  cwd: string;
  model: string;
  /** The default permission profile, for a run's write steps. */
  mode: PermissionMode;
  backLabel: string;
  confirm: Confirm;
  onBack: () => void;
}) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [text, setText] = useState("");
  const [modelAlias, setModelAlias] = useState(model);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [edited, setEdited] = useState<TaskContract | null>(null);
  const [tier, setTier] = useState<Tier>("S");
  const [reason, setReason] = useState("");
  const [budget, setBudget] = useState("");
  const [runMode, setRunMode] = useState<Exclude<PermissionMode, "plan">>(mode === "plan" ? "default" : mode);
  const [stepItems, setStepItems] = useState<StepItems>({});
  const taskId = useRef<string | null>(null);
  taskId.current = task?.id ?? null;

  const loadList = useCallback(async () => {
    try {
      setTasks((await request("task.list", { cwd })).tasks);
    } catch (err) {
      setError(message(err));
    }
  }, [cwd]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // A run reports through notifications: the task as it changes, and its steps' session events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribes once per workspace; handlers only set state.
  useEffect(
    () =>
      subscribe((n) => {
        if (n.method === "task.updated" && n.params.cwd === cwd) {
          const updated = n.params.task;
          setTask((current) => (current?.id === updated.id ? updated : current));
          if (!taskId.current) void loadList();
        } else if (n.method === "agent.event" && n.params.task && n.params.task.id === taskId.current) {
          const { sessionId, event } = n.params;
          setStepItems((items) => withStepEvent(items, sessionId, event, Date.now()));
        }
      }),
    [cwd],
  );

  function show(t: Task) {
    setTask(t);
    setEdited(t.contract);
    setTier(t.triage?.chosen ?? "S");
    setReason(t.triage?.override?.reason ?? "");
    setBudget(t.triage ? String(t.triage.budgetUsd) : "");
  }

  /** Runs a task action and shows its result; on failure, shows the task as stored (a failed draft records its spend). */
  async function step(kind: Exclude<Busy, null>, id: string, action: () => Promise<Task>) {
    setBusy(kind);
    setError(null);
    try {
      show(await action());
    } catch (err) {
      setError(isRpcError(err, RpcErrorCode.cancelled) ? "Stopped. Nothing was changed." : message(err));
      await request("task.get", { cwd, id }).then(show, () => undefined);
    } finally {
      setBusy(null);
    }
  }

  const draft = (id: string) =>
    step("draft", id, () => request("task.draft", { cwd, id, ...(modelAlias ? { model: modelAlias } : {}) }));

  async function start() {
    setError(null);
    try {
      const created = await request("task.create", { cwd, request: text });
      setTask(created);
      setText("");
      await draft(created.id);
    } catch (err) {
      setError(message(err));
    }
  }

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
          budgetUsd: Number(budget),
        }),
      );
      if (andRun) await runTask(id);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function runTask(id: string) {
    setStepItems({});
    await step("run", id, () =>
      request("task.start", { cwd, id, permissionMode: runMode, ...(modelAlias ? { model: modelAlias } : {}) }),
    );
  }

  async function stop(t: Task) {
    const ok = await confirm({
      title: "Stop the run?",
      body: <p>The running step stops now. Files it already changed stay as they are; git and rewind still work.</p>,
      confirmLabel: "Stop",
      danger: true,
    });
    if (ok) await request("task.cancel", { cwd, id: t.id }).catch((err: unknown) => setError(message(err)));
  }

  async function open(id: string) {
    try {
      show(await request("task.get", { cwd, id }));
      setStepItems({});
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }

  async function discard(t: { id: string; request: string }) {
    const ok = await confirm({
      title: "Discard this task?",
      body: <p>Deletes its request, contract and triage from this workspace.</p>,
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    try {
      await request("task.delete", { cwd, id: t.id });
      if (task?.id === t.id) {
        setTask(null);
        setEdited(null);
      }
      await loadList();
    } catch (err) {
      setError(message(err));
    }
  }

  function back() {
    if (task) {
      setTask(null);
      setEdited(null);
      setError(null);
      void loadList();
    } else onBack();
  }

  const triage = task?.triage ?? null;
  const stale = Boolean(task?.contract && edited && contractChanged(edited, task.contract));
  /** The contract as the form holds it, for the footer's actions. */
  const form = edited ?? task?.contract ?? null;
  /** The page shows one stage at a time; a new stage starts at the top. */
  const stage = !task ? "request" : busy === "draft" ? "drafting" : !task.contract ? "empty" : task.state;
  const scroller = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the stage changes, not on every render.
  useEffect(() => scroller.current?.scrollTo({ top: 0 }), [stage]);
  const blocker =
    edited && triage
      ? approveBlocker({ edited, stale, tier, proposed: triage.proposed, reason, budget })
      : "Draft the contract first.";

  return (
    <div className="setup-page task-page">
      <header className="setup-header">
        <button type="button" className="ghost small" onClick={back} disabled={busy !== null}>
          <ArrowLeft size={14} />
          {task ? "All tasks" : backLabel}
        </button>
        <div className="setup-title">
          <h1>{task ? "Task" : "New task"}</h1>
          <span className="muted" title={cwd}>
            {folderName(cwd)}
          </span>
        </div>
        <span className="chip" title="A preview: S and M tasks run; reports and L and XL tasks arrive later.">
          Preview
        </span>
        <span className="grow" />
        {task && <StateBadge task={task} />}
      </header>
      {error && (
        <div className="banner" role="alert">
          <span className="grow">{error}</span>
          <IconButton label="Dismiss" onClick={() => setError(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}

      <div className="setup-scroll task-scroll" ref={scroller}>
        {!task && (
          <>
            <section className="card">
              <div className="card-title">
                <ClipboardList size={16} aria-hidden />
                <h2>What should be done?</h2>
              </div>
              <textarea
                // biome-ignore lint/a11y/noAutofocus: the page was opened to describe a task.
                autoFocus
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Describe the task as you would in chat…"
                aria-label="Task request"
              />
              <p className="field-help">
                Claude reads the project, without changing anything, and drafts a contract: the objective, what counts
                as done, and what's out of scope. Triage then proposes a tier. You edit and approve both.
              </p>
              <div className="card-footer">
                <div className="task-model">
                  <Select value={modelAlias} onChange={setModelAlias} options={MODELS} label="Model for the draft" />
                </div>
                <span className="grow" />
                <button type="button" disabled={!text.trim() || busy !== null} onClick={() => void start()}>
                  Draft contract
                </button>
              </div>
            </section>
            <TaskList tasks={tasks} onOpen={(id) => void open(id)} onDiscard={(t) => void discard(t)} />
          </>
        )}

        {task && busy === "draft" && (
          <section className="card task-drafting" aria-live="polite">
            <Loader2 size={18} className="spin" aria-hidden />
            <div className="grow">
              <strong>Claude is reading the project to draft the contract.</strong>
              <p className="muted">
                Read-only: it can't change files. Triage runs next. <Elapsed />
              </p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => void request("task.cancel", { cwd, id: task.id })}
            >
              Cancel
            </button>
          </section>
        )}

        {task && busy !== "draft" && !task.contract && (
          <section className="card">
            <Quote text={task.request} />
            <div className="card-footer">
              <div className="task-model">
                <Select value={modelAlias} onChange={setModelAlias} options={MODELS} label="Model for the draft" />
              </div>
              <span className="grow" />
              <button type="button" className="secondary" onClick={() => void discard(task)}>
                Discard
              </button>
              <button type="button" onClick={() => void draft(task.id)}>
                Draft contract
              </button>
            </div>
          </section>
        )}

        {task && busy !== "draft" && task.state === "draft" && edited && triage && (
          <div className="task-review">
            <ContractForm request={task.request} contract={edited} gates={task.availableGates} onChange={setEdited} />
            <TriageCard
              triage={triage}
              stale={stale}
              tier={tier}
              onTier={(t) => {
                setTier(t);
                setBudget(String(t === triage.chosen ? triage.budgetUsd : DEFAULT_BUDGET_USD[t]));
              }}
              reason={reason}
              onReason={setReason}
              budget={budget}
              onBudget={setBudget}
            />
          </div>
        )}

        {task?.run && task.state !== "draft" && task.state !== "ready" && (
          <RunView
            task={task}
            cwd={cwd}
            items={stepItems}
            onLoaded={(sessionId, items) => setStepItems((all) => ({ ...all, [sessionId]: items }))}
          />
        )}

        {task && task.state !== "draft" && task.contract && task.triage && (
          <ReadyView task={task} contract={task.contract} triage={task.triage} />
        )}
      </div>

      {task && form && busy !== "draft" && (
        <footer className="plan-footer">
          <span className="muted" title="Model spend on drafting and triage, an estimate">
            {usd(task.costUsd)} spent
          </span>
          <span className="grow" />
          {task.state === "draft" ? (
            <>
              {blocker && !stale && <span className="muted">{blocker}</span>}
              <button type="button" className="secondary" onClick={() => void discard(task)}>
                Discard
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
                  Run triage again
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy !== null || blocker !== null}
                  onClick={() => void approve(form, tier === "S", task.id)}
                >
                  {busy === "approve" || busy === "run" ? <Loader2 size={14} className="spin" /> : null}
                  {tier === "S" ? "Approve and run" : "Approve contract and tier"}
                </button>
              )}
            </>
          ) : task.state === "running" ? (
            <>
              <span className="muted">
                Run {usd(task.run?.costUsd ?? 0)} of ${task.triage?.budgetUsd}
              </span>
              <button type="button" className="danger" onClick={() => void stop(task)}>
                <Square size={14} />
                Stop
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy !== null}
                onClick={() => void step("revise", task.id, () => request("task.revise", { cwd, id: task.id }))}
              >
                Revise
              </button>
              {task.state === "interrupted" ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void step("resume", task.id, () => request("task.resume", { cwd, id: task.id }))}
                >
                  <Play size={14} />
                  Resume
                </button>
              ) : (
                <>
                  <div className="task-model">
                    <Select
                      value={runMode}
                      onChange={(v) => setRunMode(v as Exclude<PermissionMode, "plan">)}
                      options={modeOptions(RUN_MODES, true)}
                      label="Permission profile for the run's write steps"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={busy !== null || runBlocker(task) !== null}
                    title={runBlocker(task) ?? undefined}
                    onClick={() => void runTask(task.id)}
                  >
                    {busy === "run" ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                    {task.run ? "Run again" : "Run"}
                  </button>
                </>
              )}
            </>
          )}
        </footer>
      )}
    </div>
  );
}

function StateBadge({ task }: { task: Task }) {
  if (task.state === "draft") return <span className="badge">{task.contract ? "Draft" : "New"}</span>;
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
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span>{seconds} s</span>;
}

function Quote({ text }: { text: string }) {
  return (
    <blockquote className="task-request">
      <span className="field-label">Request</span>
      {text}
    </blockquote>
  );
}

function TaskList({
  tasks,
  onOpen,
  onDiscard,
}: {
  tasks: TaskSummary[];
  onOpen: (id: string) => void;
  onDiscard: (t: TaskSummary) => void;
}) {
  return (
    <section className="card">
      <div className="card-title">
        <h2>Tasks in this workspace</h2>
      </div>
      {tasks.length === 0 ? (
        <EmptyState>No tasks yet. They're kept in .agentchainer/tasks/, out of git.</EmptyState>
      ) : (
        <ul className="task-list">
          {tasks.map((t) => (
            <li key={t.id} className="task-row">
              <button type="button" className="task-row-main" onClick={() => onOpen(t.id)}>
                <span className="task-row-title">{t.request}</span>
                <span className="muted">
                  {new Date(t.createdAt).toLocaleString()} · {usd(t.costUsd)}
                </span>
              </button>
              {t.tier && <span className={`tier-badge tier-${t.tier}`}>{t.tier}</span>}
              <span className={`badge tone-${stateLabel(t.state).tone}`}>{stateLabel(t.state).label}</span>
              <ActionMenu
                label={`Actions for ${t.request}`}
                items={[{ label: "Discard", danger: true, onSelect: () => onDiscard(t) }]}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <section className="card task-contract" aria-label="Contract">
      <div className="card-title">
        <ClipboardList size={16} aria-hidden />
        <h2>Contract</h2>
        <span className="muted">Drafted by Claude. Edit anything before you approve.</span>
      </div>
      <Quote text={request} />
      {contract.openQuestions.length > 0 && (
        <div className="callout task-questions">
          <strong>
            <CircleHelp size={14} aria-hidden /> Open questions
          </strong>
          <p className="muted">Settle them by editing the contract, then remove them.</p>
          <StringList label="Open question" items={contract.openQuestions} onChange={(v) => set("openQuestions", v)} />
        </div>
      )}
      <Field label="Objective" help="The outcome in a sentence or two, not the steps.">
        <textarea rows={2} value={contract.objective} onChange={(e) => set("objective", e.target.value)} />
      </Field>
      <div className="task-field">
        <span className="field-label">Acceptance criteria</span>
        <span className="field-help">
          What counts as done, and how each is proved: a gate run, the reviewer, or you. Only gates with a detected
          command can prove anything.
        </span>
        <EditableList<AcceptanceCriterion>
          label="Criterion"
          items={contract.acceptanceCriteria}
          onChange={(v) => set("acceptanceCriteria", v)}
          addLabel="Add criterion"
          empty="No criteria yet: a task needs at least one."
          text={(c) => c.text}
          withText={(c, text) => ({ ...c, text })}
          blank={() => ({ id: "", text: "", check: "manual" })}
          extra={(c, setC) => (
            <Select
              compact
              value={c.check}
              onChange={(v) => setC({ ...c, check: v as AcceptanceCriterion["check"] })}
              options={options}
              label="How it's checked"
            />
          )}
        />
      </div>
      <div className="task-columns">
        <ListField
          label="Affected areas"
          help="Paths or globs Claude expects to change."
          mono
          items={contract.affectedAreas}
          onChange={(v) => set("affectedAreas", v)}
        />
        <ListField
          label="Constraints"
          help="Limits the work must respect."
          items={contract.constraints}
          onChange={(v) => set("constraints", v)}
        />
        <ListField
          label="Out of scope"
          help="Related work this task won't do."
          items={contract.outOfScope}
          onChange={(v) => set("outOfScope", v)}
        />
        <ListField
          label="Risks"
          help="What could go wrong. Feeds triage and the report."
          items={contract.risks}
          onChange={(v) => set("risks", v)}
        />
      </div>
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
    <div className="task-field">
      <span className="field-label">{label}</span>
      <span className="field-help">{help}</span>
      <StringList label={label} items={items} onChange={onChange} empty="None." {...(mono ? { mono } : {})} />
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
}: {
  triage: Triage;
  stale: boolean;
  tier: Tier;
  onTier: (t: Tier) => void;
  reason: string;
  onReason: (r: string) => void;
  budget: string;
  onBudget: (b: string) => void;
}) {
  return (
    <aside className="card task-triage" aria-label="Triage">
      <div className="card-title">
        <Scale size={16} aria-hidden />
        <h2>Triage</h2>
        <span className="grow" />
        <span className={`tier-badge tier-${triage.proposed}`} title="Proposed tier">
          {triage.proposed}
        </span>
      </div>
      {stale && (
        <p className="callout">The contract changed since this triage. Run triage again to update the proposal.</p>
      )}
      <div className="task-why">
        <span className="field-label">Why</span>
        <ul className="task-signals">
          {triage.signals.map((s) => (
            <li key={s.signal}>
              <span className="task-signal-name">{s.signal.replace("-", " ")}</span>
              <span className="grow">{s.detail}</span>
              {s.floor && (
                <span className="badge" title={`At least ${s.floor}`}>
                  ≥ {s.floor}
                </span>
              )}
            </li>
          ))}
          <li>
            <span className="task-signal-name">Claude (haiku)</span>
            {triage.model ? (
              <span className="grow">
                {triage.model.rationale} <span className="muted">({triage.model.confidence} confidence)</span>
              </span>
            ) : (
              <span className="grow muted">Unavailable: {triage.modelError}. The proposal is the floor.</span>
            )}
            {triage.model && <span className="badge">{triage.model.tier}</span>}
          </li>
        </ul>
        {triage.model && triage.floor !== "S" && triage.proposed !== triage.model.tier && (
          <p className="field-help">
            The signals set a floor of {triage.floor}, above Claude's {triage.model.tier}.
          </p>
        )}
      </div>
      <fieldset className="task-field">
        <legend className="field-label">Tier</legend>
        <div className="task-tiers">
          {TIERS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tier === t}
              className={`chip${tier === t ? " on" : ""}`}
              onClick={() => onTier(t)}
            >
              {t}
              {t === triage.proposed && <span className="muted"> · proposed</span>}
            </button>
          ))}
        </div>
        <span className="field-help">{TIER_HELP[tier]}</span>
      </fieldset>
      {tier !== triage.proposed && (
        <Field label={`Why ${tier} rather than ${triage.proposed}?`} help="Recorded with the task's evidence.">
          <textarea rows={2} value={reason} onChange={(e) => onReason(e.target.value)} />
        </Field>
      )}
      <Field
        label={tier === "XL" ? "Budget per sub-task (USD)" : "Budget (USD)"}
        help="The task stops when it's spent."
      >
        <input
          type="number"
          min={0.1}
          max={1000}
          step={0.5}
          value={budget}
          onChange={(e) => onBudget(e.target.value)}
        />
      </Field>
    </aside>
  );
}

function ReadyView({ task, contract, triage }: { task: Task; contract: TaskContract; triage: Triage }) {
  const lists: [string, string[]][] = [
    ["Affected areas", contract.affectedAreas],
    ["Constraints", contract.constraints],
    ["Out of scope", contract.outOfScope],
    ["Risks", contract.risks],
  ];
  return (
    <>
      <section className="card">
        <div className="card-title">
          <ClipboardList size={16} aria-hidden />
          <h2>Approved</h2>
          <span className="grow" />
          <span className={`tier-badge tier-${triage.chosen}`}>{triage.chosen}</span>
        </div>
        {task.state === "ready" && (
          <p className="callout">
            {RUNNABLE_TIERS.has(triage.chosen)
              ? "Run it from the footer: each step is a Claude session you can watch here, and the app runs the gates itself."
              : `${triage.chosen} tasks run in a later update; S and M tasks run now.`}{" "}
            The task is saved in <code>.agentchainer/tasks/{task.id}/</code>.
          </p>
        )}
        <Quote text={task.request} />
        <dl className="action-facts">
          <dt>Objective</dt>
          <dd>{contract.objective}</dd>
          <dt>Tier</dt>
          <dd>
            {triage.chosen} · {TIER_HELP[triage.chosen]}
            {triage.override && (
              <span className="muted">
                {" "}
                Proposed {triage.proposed}; changed because: {triage.override.reason}
              </span>
            )}
          </dd>
          <dt>Budget</dt>
          <dd>
            ${triage.budgetUsd}
            {triage.chosen === "XL" ? " per sub-task" : ""}
          </dd>
          <dt>Approved</dt>
          <dd>{contract.approvedAt ? new Date(contract.approvedAt).toLocaleString() : "—"}</dd>
        </dl>
      </section>
      <section className="card">
        <div className="card-title">
          <h2>Acceptance criteria</h2>
        </div>
        <ul className="task-criteria">
          {contract.acceptanceCriteria.map((c) => (
            <li key={c.id}>
              <span className="grow">{c.text}</span>
              <span className="badge">{checkLabel(c.check)}</span>
            </li>
          ))}
        </ul>
        <dl className="action-facts">
          {lists
            .filter(([, items]) => items.length)
            .map(([label, items]) => (
              <div key={label} className="task-fact">
                <dt>{label}</dt>
                <dd>{items.join(" · ")}</dd>
              </div>
            ))}
        </dl>
      </section>
    </>
  );
}

function StepIcon({ status }: { status: StepRun["status"] }) {
  if (status === "running") return <Loader2 size={15} className="spin" aria-label="Running" />;
  if (status === "done") return <CircleCheck size={15} className="ok" aria-label="Done" />;
  if (status === "failed") return <CircleX size={15} className="err" aria-label="Failed" />;
  return <MinusCircle size={15} className="muted" aria-label="Stopped" />;
}

/**
 * The run (M3-06): the outcome, a timeline of steps (each opens its session's transcript, or its gate runs), and every
 * gate run with its real exit code.
 */
function RunView({
  task,
  cwd,
  items,
  onLoaded,
}: {
  task: Task;
  cwd: string;
  items: StepItems;
  onLoaded: (sessionId: string, items: StepItems[string]) => void;
}) {
  const run = task.run;
  const [open, setOpen] = useState<string | null>(null);
  const [, tick] = useState(0);
  // Running steps' durations count up.
  useEffect(() => {
    if (task.state !== "running") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [task.state]);
  if (!run) return null;
  const { label, tone } = stateLabel(task.state);
  const running = run.steps.find((s) => s.status === "running");
  const shown = open ?? running?.id ?? null;

  async function toggle(entry: StepRun) {
    const next = shown === entry.id ? "" : entry.id;
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
      <section className="card task-run">
        <div className="card-title">
          <Play size={16} aria-hidden />
          <h2>Run</h2>
          <span className={`badge tone-${tone}`}>{label}</span>
          <span className="grow" />
          <span className="muted">
            {MODE_NAMES[run.permissionMode]} · {usd(run.costUsd)} of ${task.triage?.budgetUsd}
          </span>
        </div>
        {run.outcome && <p className={`callout tone-${tone}`}>{run.outcome}</p>}
        <ol className="task-steps">
          {run.steps.map((entry) => {
            const expanded = shown === entry.id;
            const gates = runsOfEntry(task, entry);
            const sessionItems = entry.sessionId ? items[entry.sessionId] : undefined;
            return (
              <li key={entry.id} className={`task-step ${entry.status}`}>
                <button
                  type="button"
                  className="task-step-head"
                  aria-expanded={expanded}
                  onClick={() => void toggle(entry)}
                >
                  <ChevronRight size={14} className="task-step-chevron" aria-hidden />
                  <StepIcon status={entry.status} />
                  <span className="task-step-label">{entry.label}</span>
                  {entry.role && <span className="muted">{entry.role}</span>}
                  <span className="grow muted task-step-note">{entry.note}</span>
                  <span className="muted">{duration(entry.startedAt, entry.endedAt)}</span>
                  {entry.kind !== "gates" && <span className="muted">{usd(entry.costUsd)}</span>}
                </button>
                {expanded &&
                  (entry.kind === "gates" ? (
                    <GateList runs={gates} />
                  ) : sessionItems?.length ? (
                    <div className="task-step-transcript transcript">
                      <TranscriptView cwd={cwd} items={sessionItems} />
                    </div>
                  ) : (
                    <p className="muted task-step-empty">
                      {entry.status === "running" ? "Waiting for the session's first words…" : "No transcript."}
                    </p>
                  ))}
              </li>
            );
          })}
        </ol>
      </section>
      <section className="card">
        <div className="card-title">
          <h2>Gates</h2>
          <span className="muted">Run by AgentChainer, with the real exit codes.</span>
        </div>
        {run.gates.length === 0 ? (
          <EmptyState>No gate has run yet.</EmptyState>
        ) : (
          gateRounds(run.gates).map((round) => (
            <div key={round[0]?.round} className="task-gate-round">
              <span className="field-label">Round {(round[0]?.round ?? 0) + 1}</span>
              <GateList runs={round} />
            </div>
          ))
        )}
        {run.notRun.length > 0 && (
          <p className="muted">Not run, no command detected: {run.notRun.join(", ")}. They don't count as passed.</p>
        )}
      </section>
    </>
  );
}

function GateList({ runs }: { runs: GateRun[] }) {
  if (!runs.length) return <p className="muted task-step-empty">No gates to run.</p>;
  return (
    <ul className="task-gates">
      {runs.map((g) => (
        <li key={`${g.kind}-${g.package}-${g.round}`}>
          <details>
            <summary>
              {passedGate(g) ? (
                <CircleCheck size={14} className="ok" aria-label="Passed" />
              ) : (
                <CircleX size={14} className="err" aria-label="Failed" />
              )}
              <span className="task-gate-kind">{g.kind}</span>
              <code>{g.command}</code>
              {g.package !== "." && <span className="muted">{g.package}</span>}
              <span className="grow" />
              <span className="muted">
                {g.timedOut ? "timed out" : `exit ${g.exitCode}`} · {(g.durationMs / 1000).toFixed(1)} s
              </span>
            </summary>
            {g.changed?.length ? (
              <p className="muted">
                {g.kind === "format" ? "Formatted" : "Reverted changes to"}: {g.changed.join(", ")}
              </p>
            ) : null}
            <pre className="task-gate-log">{g.tail || "(no output)"}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
