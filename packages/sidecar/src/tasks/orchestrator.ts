import type {
  ApprovalRecord,
  GateKind,
  GateRun,
  GuardBlock,
  StepRun,
  Task,
  TaskContract,
  TaskRun,
  TaskTag,
} from "@agentchainer/protocol";
import { z } from "zod";
import type { AgentStep, GatesStep, ParallelStep, Role, Workflow } from "./library.ts";
import { isGates, isParallel } from "./library.ts";

/**
 * The orchestrator (M3-06, planner.md §6): runs a task's workflow template step by step and records everything it
 * does in the task's run. Agent steps are Claude sessions; gates are the project's commands, run by the sidecar; a
 * failure goes back to the implementing session for a bounded number of fix rounds. The world (sessions, commands,
 * git) comes through a `Runner`, so the state machine is tested without models.
 */

export type AgentOutcome = {
  sessionId: string;
  ok: boolean;
  subtype: string;
  text: string;
  structured?: unknown;
  costUsd: number;
};

/** A step's tag without the workspace, which the runner adds. */
export type StepTag = Omit<TaskTag, "cwd">;

export type Runner = {
  /** Starts a step's session and runs its first turn. `tag` marks the session's events and approvals. */
  start(step: AgentStep, prompt: string, budgetUsd: number, tag: StepTag): Promise<AgentOutcome>;
  /** Another turn in a write step's session (a fix round, or continuing after a restart). */
  followUp(step: AgentStep, sessionId: string, prompt: string, budgetUsd: number, tag: StepTag): Promise<AgentOutcome>;
  gates(kinds: GateKind[], round: number): Promise<{ runs: GateRun[]; notRun: GateKind[] }>;
  /** The changes since the run's base, for the reviewer. */
  diff(): string;
  /** Stops what's running now: a session's turn or a gate. */
  stop(): void;
  /** The run ended: close what's still open. Resolves once the sessions' processes have exited. */
  close(): Promise<void>;
};

/** Hand-off files in the task folder (`plan.md`, `review.json`, `summary.md`). */
export type HandOff = { read(name: string): string | null; write(name: string, text: string): void };

/** Below this, a step isn't worth starting: the task's budget is used up. */
const MIN_STEP_BUDGET_USD = 0.05;
const MAX_DIFF_CHARS = 80_000;
/** Read steps of a parallel group running at once (planner.md §6). */
const MAX_PARALLEL = 3;

/** What each role's step is asked first; the inputs follow. */
const INTRO: Record<Role, string> = {
  implementer: "Implement this approved task.",
  architect: "Plan the implementation of this approved task.",
  "independent-reviewer": "Review this change against its contract.",
  "test-planner": "Plan the tests that prove this approved task's acceptance criteria.",
  "security-reviewer": "Review this approved task for security risks before it is implemented.",
  "docs-writer": "Update the documentation for this change.",
};

const ReviewSchema = z.object({
  verdict: z.enum(["approve", "changes-requested"]),
  findings: z.array(
    z.object({
      severity: z.enum(["must-fix", "should-fix", "note"]),
      file: z.string().optional(),
      text: z.string(),
    }),
  ),
  criteria: z.array(z.object({ id: z.string(), met: z.enum(["yes", "no", "unclear"]), why: z.string() })),
});
export type Review = z.infer<typeof ReviewSchema>;

/** The reviewer's structured output. */
export const REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "changes-requested"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["must-fix", "should-fix", "note"] },
          file: { type: "string" },
          text: { type: "string" },
        },
        required: ["severity", "text"],
        additionalProperties: false,
      },
    },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          met: { type: "string", enum: ["yes", "no", "unclear"] },
          why: { type: "string" },
        },
        required: ["id", "met", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "findings", "criteria"],
  additionalProperties: false,
};

/** The review from structured output, or from JSON in the answer's text; null when neither is a valid review. */
export function parseReview(structured: unknown, text: string): Review | null {
  const direct = ReviewSchema.safeParse(structured);
  if (direct.success) return direct.data;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = ReviewSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The contract as the steps read it. */
export function contractText(c: TaskContract): string {
  const list = (title: string, items: string[]) =>
    items.length ? [`### ${title}`, ...items.map((i) => `- ${i}`), ""] : [];
  return [
    "## Contract (approved by the user)",
    "",
    `Task: ${c.task}`,
    "",
    `Objective: ${c.objective}`,
    "",
    "### Acceptance criteria",
    ...c.acceptanceCriteria.map((a) => `- ${a.id}: ${a.text} (checked by ${a.check})`),
    "",
    ...list("Constraints", c.constraints),
    ...list("Out of scope", c.outOfScope),
    ...list("Risks", c.risks),
    ...list("Affected areas", c.affectedAreas),
  ].join("\n");
}

/** `before`: whether a failure was already there before the task, so the reviewer doesn't hold the change to it. */
function gatesText(runs: GateRun[], notRun: GateKind[], before: (run: GateRun) => boolean): string {
  if (!runs.length) return "No gates ran: the workspace has no commands for them.";
  return [
    ...runs.map(
      (r) =>
        `- ${r.kind} \`${r.command}\` (${r.package}): ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}${
          (r.exitCode !== 0 || r.timedOut) && before(r)
            ? " (already failing before the task: not this change's to fix unless the contract says so)"
            : ""
        }`,
    ),
    ...(notRun.length ? [`- not run, no command detected: ${notRun.join(", ")}`] : []),
  ].join("\n");
}

/** A planner's answer under its role's `##` section: its own headings go one level down; code blocks stay as they are. */
export function demote(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || marker.startsWith(fence))) fence = fence ? null : marker;
      return !fence && !marker && /^#{1,5} /.test(line) ? `#${line}` : line;
    })
    .join("\n");
}

export const failing = (runs: GateRun[]) => runs.filter((r) => r.exitCode !== 0 || r.timedOut);
export const kinds = (runs: GateRun[]) => [...new Set(runs.map((r) => r.kind))].join(", ");

/** Why a session's turn ended, for the timeline. */
function stopped(subtype: string): string {
  if (subtype === "error_max_budget_usd") return "its budget ran out";
  if (subtype === "error_max_turns") return "it used all its turns";
  return `it stopped (${subtype})`;
}

export type OrchestratorDeps = {
  workflow: Workflow;
  runner: Runner;
  files: HandOff;
  /** Persists the task and tells the UI; called on every change. */
  save: (task: Task) => void;
  now?: () => Date;
  /** Continue an interrupted run instead of starting at its position afresh. */
  resume?: boolean;
};

export class Orchestrator {
  private task: Task;
  private readonly workflow: Workflow;
  private readonly runner: Runner;
  private readonly files: HandOff;
  private readonly save: (task: Task) => void;
  private readonly now: () => Date;
  private cancelled = false;
  private resuming: boolean;

  constructor(task: Task, deps: OrchestratorDeps) {
    this.task = task;
    this.workflow = deps.workflow;
    this.runner = deps.runner;
    this.files = deps.files;
    this.save = deps.save;
    this.now = deps.now ?? (() => new Date());
    this.resuming = deps.resume ?? false;
  }

  get current(): Task {
    return this.task;
  }

  /** The run record; `run()` is what runs it. */
  private get rec(): TaskRun {
    if (!this.task.run) throw new Error("The task has no run.");
    return this.task.run;
  }

  private commit(change: (run: TaskRun) => Partial<TaskRun>, task: Partial<Task> = {}): void {
    const run = { ...this.rec, ...change(this.rec) };
    this.task = { ...this.task, ...task, run, updatedAt: this.now().toISOString() };
    this.save(this.task);
  }

  /** An approval a step asked for, and the answer: for the evidence's security notes (M3-09). */
  recordApproval(record: ApprovalRecord): void {
    this.commit((r) => ({ approvals: [...r.approvals, record] }));
  }

  /** A tool call the guard denied. */
  recordGuardBlock(block: GuardBlock): void {
    this.commit((r) => ({ guardBlocks: [...r.guardBlocks, block] }));
  }

  /** Stops the run: the running turn or gate is interrupted, and the run ends `cancelled`. */
  cancel(): void {
    this.cancelled = true;
    this.runner.stop();
  }

  async run(): Promise<Task> {
    try {
      // A resumed run: entries left running when the app stopped didn't finish.
      if (this.resuming) {
        this.commit((r) => ({
          steps: r.steps.map((s) =>
            s.status === "running" ? { ...s, status: "failed", endedAt: this.at(), note: "Interrupted" } : s,
          ),
        }));
      }
      await this.baseline();
      if (this.cancelled) return this.end("cancelled", "Stopped by the user. The working tree is left as it is.");
      for (let i = this.rec.position; i < this.workflow.steps.length; i++) {
        this.commit(() => ({ position: i }));
        const step = this.workflow.steps[i];
        if (!step) break;
        const ok = isGates(step)
          ? await this.gatesLoop(step)
          : isParallel(step)
            ? await this.parallelStep(step)
            : await this.agentStep(step);
        if (this.cancelled) return this.end("cancelled", "Stopped by the user. The working tree is left as it is.");
        if (!ok) return this.end("failed");
        this.resuming = false;
      }
      if (!this.rec.gates.length) {
        return this.end("unverified", "No gate ran: the workspace has no commands for them, so nothing proved it.");
      }
      // Done needs every gate's latest run to pass. New failures already ended the run in the gates loop, so what can
      // be left here failed before the task too.
      const old = failing(this.latestGates());
      if (old.length) {
        const were =
          new Set(old.map((g) => g.kind)).size === 1
            ? "was already failing before the task and still fails"
            : "were already failing before the task and still fail";
        return this.end("failed", `${kinds(old)} ${were}. Accept the risk if that's expected.`);
      }
      return this.end("done", "Every gate passed after the last change.");
    } catch (err) {
      if (this.cancelled) return this.end("cancelled", "Stopped by the user. The working tree is left as it is.");
      return this.end("failed", `Stopped on an error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Before the run counts as ended: XL removes a sub-task's worktree next, which needs its sessions gone.
      await this.runner.close();
    }
  }

  private at(): string {
    return this.now().toISOString();
  }

  private end(state: Task["state"], outcome?: string): Task {
    this.commit(
      (r) => ({
        endedAt: this.at(),
        outcome: outcome ?? r.outcome ?? "The run failed.",
        steps: r.steps.map((s) => (s.status === "running" ? { ...s, status: "cancelled", endedAt: this.at() } : s)),
      }),
      { state },
    );
    return this.task;
  }

  /** What's left of the task's budget for a step that wants `cap`; 0 when it's used up. */
  private budget(cap: number): number {
    const left = (this.task.triage?.budgetUsd ?? 0) - this.rec.costUsd;
    return left < MIN_STEP_BUDGET_USD ? 0 : Math.min(cap, left);
  }

  /** Adds a timeline entry: `implement`, then `implement-2`; `gates`, `gates-2`; `implement-fix-1`, … */
  private begin(entry: Omit<StepRun, "id" | "status" | "startedAt" | "costUsd">): string {
    const n = this.rec.steps.filter((s) => s.step === entry.step && s.kind === entry.kind).length + 1;
    const base = entry.kind === "fix" ? `${entry.step}-fix` : entry.step;
    const id = n === 1 && entry.kind !== "fix" ? base : `${base}-${n}`;
    this.commit((r) => ({
      steps: [...r.steps, { ...entry, id, status: "running", startedAt: this.at(), costUsd: 0 }],
    }));
    return id;
  }

  private finish(id: string, change: Partial<StepRun>, costUsd = 0): void {
    this.commit(
      (r) => ({
        costUsd: r.costUsd + costUsd,
        steps: r.steps.map((s) =>
          s.id === id ? { ...s, ...change, costUsd: s.costUsd + costUsd, endedAt: this.at() } : s,
        ),
      }),
      { costUsd: this.task.costUsd + costUsd },
    );
  }

  private tag(stepId: string, label: string, role?: string): StepTag {
    return { id: this.task.id, stepId, label, ...(role ? { role } : {}) };
  }

  /** The latest session of a template step (where its fixes go). */
  private sessionOf(step: string): string | undefined {
    return [...this.rec.steps].reverse().find((s) => s.step === step && s.sessionId)?.sessionId;
  }

  private prompt(step: AgentStep): string {
    const contract = this.task.contract;
    if (!contract) throw new Error("The task has no contract.");
    const parts = [INTRO[step.role]];
    for (const input of step.inputs) {
      if (input === "contract") parts.push(contractText(contract));
      if (input === "plan") parts.push(`## Plan (from the plan step)\n\n${this.files.read("plan.md") ?? "(no plan)"}`);
      if (input === "diff") {
        const diff = this.runner.diff();
        const capped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;
        parts.push(`## Diff since the task started\n\n\`\`\`diff\n${capped || "(no changes)"}\n\`\`\``);
      }
      if (input === "gates")
        parts.push(
          `## Gate results (run by AgentChainer)\n\n${gatesText(this.latestGates(), this.rec.notRun, (r) => this.preexisting(r))}`,
        );
    }
    return parts.filter(Boolean).join("\n\n");
  }

  /** The latest round of gate runs. */
  private latestGates(): GateRun[] {
    const last = Math.max(-1, ...this.rec.gates.map((g) => g.round));
    return this.rec.gates.filter((g) => g.round === last);
  }

  /** Runs one agent step's turn in its own timeline entry: its answer, or null when it stopped or couldn't start. */
  private async turnOf(step: AgentStep, group?: string): Promise<{ id: string; out: AgentOutcome } | null> {
    // A write step's session also takes its fix rounds, and the SDK caps a session as a whole: it gets what's left of
    // the task's budget. Read steps are fresh sessions with caps of their own.
    const budget = this.budget(step.access === "write" ? Number.POSITIVE_INFINITY : step.limits.maxBudgetUsd);
    if (!budget) {
      this.commit(() => ({ outcome: `The task's budget ran out before ${step.label.toLowerCase()}.` }));
      return null;
    }
    const previous = this.resuming && step.access === "write" ? this.sessionOf(step.id) : undefined;
    const id = this.begin({
      step: step.id,
      label: step.label,
      kind: "agent",
      role: step.role,
      ...(group ? { group } : {}),
    });
    const tag = this.tag(id, step.label, step.role);
    const out = previous
      ? await this.runner.followUp(
          step,
          previous,
          "The app stopped while you were working on this task. Check where you got to, then finish it and summarize.",
          budget,
          tag,
        )
      : await this.runner.start(step, this.prompt(step), budget, tag);
    if (this.cancelled) {
      this.finish(id, { status: "cancelled", sessionId: out.sessionId }, out.costUsd);
      return null;
    }
    if (!out.ok) {
      this.finish(
        id,
        { status: "failed", sessionId: out.sessionId, note: `Stopped: ${stopped(out.subtype)}.` },
        out.costUsd,
      );
      this.commit(() => ({ outcome: `${step.label} stopped: ${stopped(out.subtype)}.` }));
      return null;
    }
    this.finish(id, { status: "done", sessionId: out.sessionId }, out.costUsd);
    // The implementer's latest summary: what each file's change is for, in the evidence.
    if (step.access === "write") this.files.write("summary.md", out.text);
    return { id, out };
  }

  private async agentStep(step: AgentStep): Promise<boolean> {
    const turn = await this.turnOf(step);
    if (!turn) return false;
    const { out } = turn;
    if (step.output === "plan") this.files.write("plan.md", out.text);
    if (step.output !== "review") return true;
    const review = parseReview(out.structured, out.text);
    this.files.write("review.json", `${JSON.stringify(review ?? { unreadable: out.text }, null, 2)}\n`);
    const mustFix = review?.findings.filter((f) => f.severity === "must-fix") ?? [];
    this.commit((r) => ({
      steps: r.steps.map((s) =>
        s.id === turn.id
          ? {
              ...s,
              note: !review
                ? "The review couldn't be read; it's kept as text."
                : mustFix.length
                  ? `${mustFix.length} must-fix finding${mustFix.length === 1 ? "" : "s"}.`
                  : `No must-fix findings (${review.verdict}).`,
            }
          : s,
      ),
    }));
    if (!mustFix.length || !step.fix || step.fix.maxRounds < 1) return true;
    const findings = mustFix.map((f) => `- ${f.file ? `${f.file}: ` : ""}${f.text}`).join("\n");
    const fixed = await this.fix(
      step.fix,
      `An independent reviewer found must-fix problems in your change. Fix them, then summarize again.\n\n${findings}`,
      "review findings",
    );
    if (!fixed) return false;
    // The fix changed code, so every gate runs again.
    const gates = this.workflow.steps.find(isGates);
    return gates ? this.gatesLoop(gates) : true;
  }

  /** Read-only steps at the same time, a few at once; their answers become `plan.md`, one section each. */
  private async parallelStep(step: ParallelStep): Promise<boolean> {
    const members = step.parallel;
    const answers: (AgentOutcome | null)[] = members.map(() => null);
    let next = 0;
    const worker = async () => {
      while (next < members.length && !this.cancelled) {
        const i = next++;
        const member = members[i];
        if (member) answers[i] = (await this.turnOf(member, step.label))?.out ?? null;
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, members.length) }, worker));
    if (this.cancelled || answers.some((a) => !a)) return false;
    this.files.write(
      "plan.md",
      members.map((m, i) => `## ${m.label} (${m.role})\n\n${demote(answers[i]?.text ?? "")}`).join("\n\n"),
    );
    return true;
  }

  /** The gates once before the first step: what already fails isn't the task's doing, and isn't its to fix. */
  private async baseline(): Promise<void> {
    const gates = this.workflow.steps.find(isGates);
    if (!gates || this.rec.steps.some((s) => s.kind === "baseline" && s.status !== "running")) return;
    const id = this.begin({ step: "baseline", label: "Gates before the task", kind: "baseline" });
    const { runs, notRun } = await this.runner.gates(gates.gates, 0);
    this.commit(() => ({ baseline: runs, notRun }));
    if (this.cancelled) {
      this.finish(id, { status: "cancelled" });
      return;
    }
    const failed = failing(runs);
    this.finish(id, {
      status: failed.length ? "failed" : "done",
      note: !runs.length ? "No gates to run." : failed.length ? `Already failing: ${kinds(failed)}.` : "All passed.",
    });
  }

  private async fix(spec: { step: string; maxBudgetUsd: number }, prompt: string, what: string): Promise<boolean> {
    const target = this.workflow.steps.find((s) => s.id === spec.step);
    const sessionId = this.sessionOf(spec.step);
    if (!target || isGates(target) || isParallel(target) || !sessionId) {
      this.commit(() => ({ outcome: `No session to send the ${what} to.` }));
      return false;
    }
    const budget = this.budget(spec.maxBudgetUsd);
    if (!budget) {
      this.commit(() => ({ outcome: `The task's budget ran out before fixing the ${what}.` }));
      return false;
    }
    const id = this.begin({ step: target.id, label: `Fix: ${what}`, kind: "fix", role: target.role });
    const out = await this.runner.followUp(
      target,
      sessionId,
      prompt,
      budget,
      this.tag(id, `Fix: ${what}`, target.role),
    );
    if (this.cancelled || !out.ok) {
      const note = this.cancelled ? undefined : `Stopped: ${stopped(out.subtype)}.`;
      this.finish(
        id,
        { status: this.cancelled ? "cancelled" : "failed", sessionId: out.sessionId, ...(note ? { note } : {}) },
        out.costUsd,
      );
      if (!this.cancelled) this.commit(() => ({ outcome: `Fixing the ${what} stopped: ${stopped(out.subtype)}.` }));
      return false;
    }
    this.finish(id, { status: "done", sessionId: out.sessionId }, out.costUsd);
    this.files.write("summary.md", out.text);
    return true;
  }

  /** Whether the same gate (kind and package) already failed before the task. */
  private preexisting(run: GateRun): boolean {
    return this.rec.baseline.some(
      (b) => b.kind === run.kind && b.package === run.package && (b.exitCode !== 0 || b.timedOut),
    );
  }

  private async gatesLoop(step: GatesStep): Promise<boolean> {
    for (;;) {
      const round = Math.max(-1, ...this.rec.gates.map((g) => g.round)) + 1;
      const id = this.begin({
        step: step.id,
        label: round === 0 ? step.label : `${step.label}, round ${round + 1}`,
        kind: "gates",
      });
      const { runs, notRun } = await this.runner.gates(step.gates, round);
      if (this.cancelled) {
        this.commit((r) => ({ gates: [...r.gates, ...runs], notRun }));
        this.finish(id, { status: "cancelled" });
        return false;
      }
      const failed = failing(runs);
      // Failures the task didn't cause go back to no one: they don't use fix rounds.
      const fresh = failed.filter((f) => !this.preexisting(f));
      const old = failed.filter((f) => this.preexisting(f));
      this.commit((r) => ({ gates: [...r.gates, ...runs], notRun }));
      this.finish(id, {
        status: failed.length ? "failed" : "done",
        note: !runs.length
          ? "No gates to run."
          : failed.length
            ? `Failed: ${kinds(failed)}${old.length ? ` (${kinds(old)} already before the task)` : ""}.`
            : "All passed.",
      });
      // Only failures from before the task: no fix round, and the run goes on, since a review still adds evidence. It
      // can't end Done (see run()).
      if (!fresh.length) return true;
      if (this.rec.fixRounds >= step.fix.maxRounds) {
        const rounds = `${step.fix.maxRounds} fix round${step.fix.maxRounds === 1 ? "" : "s"}`;
        const before = old.length ? ` ${kinds(old)} already failed before the task.` : "";
        this.commit(() => ({ outcome: `${kinds(fresh)} still failing after ${rounds}.${before}` }));
        return false;
      }
      this.commit((r) => ({ fixRounds: r.fixRounds + 1 }));
      const alreadyFailing = old.length
        ? `\n\nAlready failing before the task, so not part of this fix unless the contract asks for it: ${kinds(old)}.`
        : "";
      const detail = fresh
        .map(
          (f) =>
            `### ${f.kind}: \`${f.command}\` in ${f.package} ${f.timedOut ? "timed out" : `exited ${f.exitCode}`}\n\n\`\`\`\n${f.tail}\n\`\`\``,
        )
        .join("\n\n");
      const fixed = await this.fix(
        step.fix,
        `AgentChainer ran the project's gates after your change, and these failed. Fix the cause in the code, not the checks, then summarize again.\n\n${detail}${alreadyFailing}`,
        `failing ${kinds(fresh)}`,
      );
      if (!fixed) return false;
    }
  }
}

/** A fresh run record for `task`, measured from `base`. */
export function newRun(
  workflow: Pick<Workflow, "id" | "version">,
  opts: { permissionMode: TaskRun["permissionMode"]; model?: string; base: string | null; untrackedAtStart: string[] },
  now: Date,
): TaskRun {
  return {
    workflow: { id: workflow.id, version: workflow.version },
    permissionMode: opts.permissionMode,
    ...(opts.model ? { model: opts.model } : {}),
    base: opts.base,
    untrackedAtStart: opts.untrackedAtStart,
    startedAt: now.toISOString(),
    position: 0,
    fixRounds: 0,
    steps: [],
    gates: [],
    notRun: [],
    baseline: [],
    approvals: [],
    guardBlocks: [],
    costUsd: 0,
  };
}
