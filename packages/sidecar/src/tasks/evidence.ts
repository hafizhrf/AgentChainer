import {
  type ApprovalRecord,
  type DeployRecord,
  type GateKind,
  type GateRun,
  type GuardBlock,
  type MessageRef,
  type ResultKey,
  resultEnglish,
  resultRef,
  type StepRun,
  type Task,
  type TaskRun,
} from "@agentchainer/protocol";
import type { Review } from "./orchestrator.ts";
import { result } from "./result.ts";

/**
 * The evidence report (M3-09, planner.md §9): built only from what the run recorded, never from what Claude says about
 * itself, except where it's labeled as Claude's statement (a file's purpose, the implementer's notes). Gate results
 * are the commands' real exit codes; a gate that didn't run is said to have not run, never to have passed.
 *
 * Its prose is stored in English next to `MessageRef`s (X-13 part 2b): `evidence.md` and pull requests get the
 * English rendering, the task page the app's language (`renderEvidence`'s `render`).
 */

export type FileChange = {
  path: string;
  status: "new" | "modified" | "deleted";
  /** null for binary files. */
  added: number | null;
  removed: number | null;
};

/** `whyRef` shows why it didn't run in the app's language; reports from before have none. */
export type SecretsScan =
  | { ran: false; why: string; whyRef?: MessageRef }
  | { ran: true; scanned: number; flagged: string[] };

/** A scan that didn't run, from its result. */
export const notScanned = (why: { text: string; ref: MessageRef }): SecretsScan => ({
  ran: false,
  why: why.text,
  whyRef: why.ref,
});

/** An XL task's sub-task, as its own report sums it up (M3-07). */
export type SubtaskSummary = {
  number: number;
  title: string;
  tier: string | null;
  state: Task["state"];
  costUsd: number;
  outcome: string | null;
  outcomeRef?: MessageRef;
  /** Its own report, relative to the workspace. */
  report: string;
};

export type EvidenceInput = {
  task: Task;
  files: FileChange[];
  /** The implementer's latest summary (`summary.md`). */
  summary: string | null;
  review: Review | null;
  secrets: SecretsScan;
  /** An XL task's sub-tasks; none for other tiers. */
  subtasks?: SubtaskSummary[];
  /** The task's deploys (M6), newest first. */
  deploys?: DeployRecord[];
  /** An XL task's approvals and guard blocks, from its sub-tasks' steps, in place of its own run's. */
  records?: { approvals: EvidenceApproval[]; guardBlocks: GuardBlock[] };
  /** An XL task's implementers' notes, from its sub-tasks, in place of the summary's `## Notes`. */
  notes?: { text: string; ref: MessageRef }[];
  now: Date;
};

/** An approval as the report lists it: an XL task's are marked with their sub-task (`labelRef`). */
export type EvidenceApproval = ApprovalRecord & { labelRef?: MessageRef };

export type CriterionResult = {
  id: string;
  text: string;
  check: string;
  status: "proved" | "failed" | "not-run" | "met" | "not-met" | "unclear" | "manual";
  detail: string;
  detailRef?: MessageRef;
};

export type Evidence = {
  version: 1;
  /**
   * Set when the report's prose has `MessageRef`s next to the English (X-13 part 2b), so the app can show it in its
   * language. A report from before is shown as it was written.
   */
  refs?: true;
  generatedAt: string;
  task: {
    id: string;
    request: string;
    objective: string;
    tier: string;
    proposed: string;
    overrideReason?: string;
    /** Set when the sidecar gave the reason (a split's sub-tasks), not the person. */
    overrideReasonRef?: MessageRef;
    /** null: the person ran it with no budget. */
    budgetUsd: number | null;
    approvedAt?: string;
    /** The workflow the run used, and the project's file when it replaced the app's (M6-04). */
    workflow?: TaskRun["workflow"];
    /** The GitHub issue the task came from (CP-08). */
    issue?: { number: number; url: string };
  };
  outcome: { state: Task["state"]; text: string; ref?: MessageRef; acceptance?: { reason: string; at: string } };
  files: (FileChange & { purpose: string | null })[];
  subtasks: SubtaskSummary[];
  /** An XL run's merges of its sub-tasks into the task branch. */
  merges: { label: string; labelRef?: MessageRef; status: string; note: string | null; noteRef?: MessageRef }[];
  gates: { baseline: GateRun[]; runs: GateRun[]; notRun: GateKind[]; preexisting: string[]; fixedByTask: string[] };
  criteria: CriterionResult[];
  review: Review | null;
  /** Why there's no review, when there isn't one. */
  noReview: string | null;
  noReviewRef?: MessageRef;
  security: { guardBlocks: GuardBlock[]; approvals: EvidenceApproval[]; secrets: SecretsScan };
  risks: {
    contract: string[];
    fromImplementer: string[];
    /** `fromImplementer`'s refs, by index: an XL task's notes, each marked with its sub-task. */
    fromImplementerRefs?: MessageRef[];
    manual: string[];
  };
  cost: {
    steps: {
      label: string;
      labelRef?: MessageRef;
      durationMs: number | null;
      costUsd: number;
      /** Who ran an agent step (M9-07). */
      agent?: StepRun["agent"];
      model?: string;
      costKind?: StepRun["costKind"];
      tokens?: StepRun["tokens"];
    }[];
    runUsd: number;
    totalUsd: number;
  };
  /** The task's pull request (M5): its review, its Fix CI rounds and how a person merged it. */
  pr?: Task["pr"];
  /** "Fix as commented" rounds on the run (CP-05). */
  feedback?: TaskRun["feedback"];
  /** The Best-of-N this run was kept from (CP-06): every variant, and which one it is. */
  bestOf?: TaskRun["bestOf"];
  /** The task's deploys (M6). */
  deploys?: DeployRecord[];
};

const failed = (g: GateRun) => g.exitCode !== 0 || g.timedOut;
const gateKey = (g: GateRun) => (g.package === "." ? g.kind : `${g.kind} (${g.package})`);

/** The bullet lines of a `## <title>` section in a markdown text. */
export function sectionLines(text: string | null, title: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{1,3}\\s*${title}\\s*$`, "i").test(l.trim()));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break;
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/** Each file's purpose from the implementer's `## Changes` lines (`- path: what and why`), by path. */
export function purposes(summary: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of sectionLines(summary, "Changes")) {
    // A multi-folder task's other folders name their files `api:path` (M8-01).
    const m = /^`?((?:[\w.-]{2,}:)?[^`:\s][^`:]*?)`?\s*[:—–-]\s+(.+)$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1].trim().replace(/^\.\//, ""), m[2].trim());
  }
  return out;
}

function purposeOf(path: string, known: Map<string, string>): string | null {
  const exact = known.get(path);
  if (exact) return exact;
  for (const [p, text] of known) if (path.endsWith(`/${p}`) || p.endsWith(`/${path}`)) return text;
  // Another folder's file the implementer named without its folder (`api:routes.js` as `routes.js`).
  const bare = /^[\w.-]{2,}:(.+)$/.exec(path)?.[1];
  return bare ? purposeOf(bare, known) : null;
}

type Text = ReturnType<typeof result>;
type Params = Record<string, string | number | MessageRef>;

/** Why a run has no review: its tier has none, the run ended first, or the answer couldn't be read. */
function reviewAbsence(task: Task): Text {
  if (task.triage?.chosen === "S") return result("evidence.noReview.tierS");
  if (task.triage?.chosen === "XL") return result("evidence.noReview.xl");
  if (!task.run?.steps.some((s) => s.role === "independent-reviewer" && s.kind === "agent"))
    return result("evidence.noReview.didntRun");
  return result("evidence.noReview.unreadable");
}

const exitOf = (g: GateRun): MessageRef =>
  typeof g.exitCode === "number"
    ? resultRef("evidence.gate.exit", { code: g.exitCode })
    : resultRef("evidence.gate.exitNone");

/** Texts separated by commas, each still shown in the app's language. */
const listOf = (items: MessageRef[]): MessageRef =>
  items.reduceRight((rest, first) => resultRef("evidence.list.more", { first, rest }));

function criterion(
  task: Task,
  review: Review | null,
  noReview: Text | null,
  c: { id: string; text: string; check: string },
): CriterionResult {
  const judged = (status: CriterionResult["status"], detail: Text): CriterionResult => ({
    id: c.id,
    text: c.text,
    check: c.check,
    status,
    detail: detail.text,
    detailRef: detail.ref,
  });
  const run = task.run;
  if (c.check.startsWith("gate:")) {
    const kind = c.check.slice(5);
    const runs = run?.gates.filter((g) => g.kind === kind) ?? [];
    if (!runs.length) {
      return judged(
        "not-run",
        run?.notRun.includes(kind as GateKind)
          ? result("evidence.criterion.noCommand", { gate: kind })
          : result("evidence.criterion.didntRun", { gate: kind }),
      );
    }
    const last = Math.max(...runs.map((g) => g.round));
    const latest = runs.filter((g) => g.round === last);
    const bad = latest.filter(failed);
    if (!bad.length) return judged("proved", result("evidence.criterion.passed", { gate: kind, round: last + 1 }));
    const before = bad.every((g) => run?.baseline.some((b) => failed(b) && gateKey(b) === gateKey(g)));
    const params = { gate: kind, round: last + 1, exits: listOf(bad.map(exitOf)) };
    return judged(
      "failed",
      before ? result("evidence.criterion.failedBefore", params) : result("evidence.criterion.failed", params),
    );
  }
  if (c.check === "review") {
    const verdict = review?.criteria.find((r) => r.id === c.id);
    if (!verdict) return judged("not-run", noReview ?? result("evidence.criterion.notJudged"));
    const status = verdict.met === "yes" ? "met" : verdict.met === "no" ? "not-met" : "unclear";
    return judged(status, result("evidence.criterion.reviewer", { why: verdict.why }));
  }
  return judged("manual", result("evidence.criterion.manual"));
}

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function buildEvidence({
  task,
  files,
  summary,
  review,
  secrets,
  subtasks = [],
  deploys,
  records,
  notes,
  now,
}: EvidenceInput): Evidence {
  const noReview = review ? null : reviewAbsence(task);
  const run = task.run;
  const contract = task.contract;
  const triage = task.triage;
  const known = purposes(summary);
  const preexisting = (run?.baseline ?? []).filter(failed);
  const last = Math.max(-1, ...(run?.gates ?? []).map((g) => g.round));
  const latest = (run?.gates ?? []).filter((g) => g.round === last);
  const fixedByTask = preexisting
    .filter((b) => latest.some((g) => g.kind === b.kind && g.package === b.package && !failed(g)))
    .map(gateKey);
  const override = triage?.override;
  const outcome: { text: string; ref?: MessageRef } =
    run?.outcome === undefined
      ? result("evidence.outcome.notRun")
      : { text: run.outcome, ...(run.outcomeRef ? { ref: run.outcomeRef } : {}) };
  return {
    version: 1,
    refs: true,
    generatedAt: now.toISOString(),
    task: {
      id: task.id,
      request: task.request,
      objective: contract?.objective ?? "",
      tier: triage?.chosen ?? "",
      proposed: triage?.proposed ?? "",
      ...(override ? { overrideReason: override.reason } : {}),
      ...(override?.reasonRef ? { overrideReasonRef: override.reasonRef } : {}),
      budgetUsd: triage ? triage.budgetUsd : 0,
      ...(contract?.approvedAt ? { approvedAt: contract.approvedAt } : {}),
      ...(run ? { workflow: run.workflow } : {}),
      ...(task.issue ? { issue: { number: task.issue.number, url: task.issue.url } } : {}),
    },
    outcome: {
      state: task.state,
      ...outcome,
      ...(run?.acceptance ? { acceptance: run.acceptance } : {}),
    },
    files: files.map((f) => ({ ...f, purpose: purposeOf(f.path, known) })),
    subtasks,
    merges: (run?.steps ?? [])
      .filter((s) => s.kind === "merge")
      .map((s) => ({
        label: s.label,
        ...(s.labelRef ? { labelRef: s.labelRef } : {}),
        status: s.status,
        note: s.note ?? null,
        ...(s.noteRef ? { noteRef: s.noteRef } : {}),
      })),
    gates: {
      baseline: run?.baseline ?? [],
      runs: run?.gates ?? [],
      notRun: run?.notRun ?? [],
      preexisting: preexisting.map(gateKey),
      fixedByTask,
    },
    criteria: (contract?.acceptanceCriteria ?? []).map((c) => criterion(task, review, noReview, c)),
    review,
    noReview: noReview?.text ?? null,
    ...(noReview ? { noReviewRef: noReview.ref } : {}),
    security: {
      guardBlocks: run ? (records?.guardBlocks ?? run.guardBlocks) : [],
      approvals: [...(run ? (records?.approvals ?? run.approvals) : [])].sort(
        (a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk],
      ),
      secrets,
    },
    risks: {
      contract: contract?.risks ?? [],
      fromImplementer: notes ? notes.map((n) => n.text) : sectionLines(summary, "Notes"),
      ...(notes ? { fromImplementerRefs: notes.map((n) => n.ref) } : {}),
      manual: (contract?.acceptanceCriteria ?? []).filter((c) => c.check === "manual").map((c) => c.text),
    },
    cost: {
      steps: (run?.steps ?? []).map((s) => ({
        label: s.label,
        ...(s.labelRef ? { labelRef: s.labelRef } : {}),
        durationMs: s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : null,
        costUsd: s.costUsd,
        ...(s.agent ? { agent: s.agent } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.costKind ? { costKind: s.costKind } : {}),
        ...(s.tokens ? { tokens: s.tokens } : {}),
      })),
      runUsd: run?.costUsd ?? 0,
      totalUsd: task.costUsd,
    },
    ...(task.pr ? { pr: task.pr } : {}),
    ...(run?.feedback?.length ? { feedback: run.feedback } : {}),
    ...(run?.bestOf ? { bestOf: run.bestOf } : {}),
    ...(deploys?.length ? { deploys } : {}),
  };
}

/** The words for a recorded value, by the value; one this doesn't know is shown as it is. */
export const STATE_TEXT: Partial<Record<string, ResultKey>> = {
  done: "evidence.state.done",
  failed: "evidence.state.failed",
  unverified: "evidence.state.unverified",
  cancelled: "evidence.state.cancelled",
  accepted: "evidence.state.accepted",
  running: "evidence.state.running",
  interrupted: "evidence.state.interrupted",
  // An XL task's sub-tasks its run never reached.
  draft: "evidence.state.draft",
  ready: "evidence.state.ready",
};

const CRITERION_TEXT: Partial<Record<string, ResultKey>> = {
  proved: "evidence.criterionStatus.proved",
  failed: "evidence.criterionStatus.failed",
  "not-run": "evidence.criterionStatus.notRun",
  met: "evidence.criterionStatus.met",
  "not-met": "evidence.criterionStatus.notMet",
  unclear: "evidence.criterionStatus.unclear",
  manual: "evidence.criterionStatus.manual",
};

/** A step's status (a merge without a note), and a Fix CI round's. */
const STEP_TEXT: Partial<Record<string, ResultKey>> = {
  running: "evidence.step.running",
  done: "evidence.step.done",
  failed: "evidence.step.failed",
  cancelled: "evidence.step.cancelled",
};

const FILE_TEXT: Partial<Record<string, ResultKey>> = {
  new: "evidence.file.new",
  modified: "evidence.file.modified",
  deleted: "evidence.file.deleted",
};

const VERDICT_TEXT: Partial<Record<string, ResultKey>> = {
  approve: "evidence.verdict.approve",
  "changes-requested": "evidence.verdict.changesRequested",
  unreadable: "evidence.verdict.unreadable",
};

export const SEVERITY_TEXT: Partial<Record<string, ResultKey>> = {
  "must-fix": "evidence.severity.mustFix",
  "should-fix": "evidence.severity.shouldFix",
  note: "evidence.severity.note",
};

const RISK_TEXT: Partial<Record<string, ResultKey>> = {
  high: "evidence.risk.high",
  medium: "evidence.risk.medium",
  low: "evidence.risk.low",
};

/** A recorded value as words the app translates; one the map doesn't know as it is. */
export const named = (words: Partial<Record<string, ResultKey>>, value: string): MessageRef | string => {
  const key = words[value];
  return key ? resultRef(key) : value;
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
/** The agents' product names, which stay as they are in every language. */
const AGENT_NAMES = { claude: "Claude", codex: "Codex", agy: "Antigravity CLI" } as const;

const usd = (n: number) => `≈$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/**
 * The report as markdown: what's exported and shown on the task page. `render` writes each line and each text that
 * has a ref: English (the default) for `evidence.md` and pull requests, `resultText` for the task page in the app's
 * language. Texts without a ref (Claude's, the person's, a report's from before) are shown as they were stored.
 */
export function renderEvidence(e: Evidence, render: (ref: MessageRef) => string = resultEnglish): string {
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines);
  const r = (key: ResultKey, params?: Params) => render(resultRef(key, params));
  const text = (value: MessageRef | string) => (typeof value === "string" ? value : render(value));
  const shown = (stored: string, ref: MessageRef | undefined) => (ref ? render(ref) : stored);
  const seconds = (ms: number | null) =>
    ms === null ? "—" : r("evidence.time.seconds", { n: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
  const gateRow = (g: GateRun, when: string) =>
    `| ${when} | ${g.kind} | \`${cell(g.command)}\` | ${g.package === "." ? r("evidence.gate.root") : cell(g.package)} | ${g.timedOut ? r("evidence.gate.timedOut") : render(exitOf(g))} | ${seconds(g.durationMs)} |`;
  const round = (g: GateRun) => r("evidence.gate.round", { n: g.round + 1 });

  add(r("evidence.report.title", { title: e.task.objective || e.task.request }), "");
  add(r("evidence.report.request", { request: e.task.request }));
  if (e.task.issue) add(r("evidence.report.issue", { number: e.task.issue.number, url: e.task.issue.url }));
  const budget =
    e.task.budgetUsd === null
      ? resultRef("evidence.report.noBudget")
      : resultRef("evidence.report.budget", { usd: e.task.budgetUsd });
  add(
    e.task.tier !== e.task.proposed
      ? r("evidence.report.tierChanged", {
          tier: e.task.tier,
          proposed: e.task.proposed,
          reason: e.task.overrideReasonRef ?? e.task.overrideReason ?? resultRef("evidence.report.noReason"),
          budget,
        })
      : r("evidence.report.tier", { tier: e.task.tier, budget }),
  );
  if (e.task.approvedAt) add(r("evidence.report.approved", { at: e.task.approvedAt }));
  const w = e.task.workflow;
  if (w) {
    const params = { id: w.id, version: w.version, file: String(w.file), hash: String(w.hash) };
    add(
      w.source === "task"
        ? r("evidence.report.workflowTask", params)
        : w.source === "project"
          ? r("evidence.report.workflowProject", params)
          : r("evidence.report.workflowApp", params),
    );
  }
  add(
    r("evidence.report.outcome", {
      state: named(STATE_TEXT, e.outcome.state),
      text: e.outcome.ref ?? e.outcome.text,
    }),
  );
  if (e.outcome.acceptance) {
    add(r("evidence.report.riskAccepted", { at: e.outcome.acceptance.at, reason: e.outcome.acceptance.reason }));
  }
  if (e.subtasks.length) {
    add("", r("evidence.report.subtasks"), "", r("evidence.report.subtasksIntro"), "");
    add(r("evidence.report.subtasksTable"), "|---|---|---|---|---|---|");
    for (const t of e.subtasks) {
      const outcome = t.outcomeRef ? render(t.outcomeRef) : t.outcome;
      add(
        `| ${t.number} | ${cell(t.title)} | ${t.tier ?? "–"} | ${text(named(STATE_TEXT, t.state))}${outcome ? `: ${cell(outcome)}` : ""} | ${usd(t.costUsd)} | \`${cell(t.report)}\` |`,
      );
    }
    const failedMerges = e.merges.filter((m) => m.status !== "done");
    if (failedMerges.length) add("");
    for (const m of failedMerges) {
      const why = m.note === null ? text(named(STEP_TEXT, m.status)) : shown(m.note, m.noteRef);
      add(`- ${shown(m.label, m.labelRef)}: ${why}`);
    }
  }
  add("", r("evidence.report.changedFiles"), "");
  if (!e.files.length) add(r("evidence.report.noFiles"));
  else {
    add(r("evidence.report.filesTable"), "|---|---|---|---|---|");
    for (const f of e.files) {
      const binary = r("evidence.file.binary");
      add(
        `| \`${cell(f.path)}\` | ${text(named(FILE_TEXT, f.status))} | ${f.added ?? binary} | ${f.removed ?? binary} | ${cell(f.purpose ?? r("evidence.file.noPurpose"))} |`,
      );
    }
  }
  add("", r("evidence.report.gates"), "", r("evidence.report.gatesIntro"), "");
  if (!e.gates.baseline.length && !e.gates.runs.length) add(r("evidence.report.noGates"));
  else {
    add(r("evidence.report.gatesTable"), "|---|---|---|---|---|---|");
    for (const g of e.gates.baseline) add(gateRow(g, r("evidence.gate.before")));
    for (const g of e.gates.runs) add(gateRow(g, round(g)));
  }
  if (e.gates.notRun.length) add("", r("evidence.report.notRun", { gates: e.gates.notRun.join(", ") }));
  if (e.gates.preexisting.length) {
    add("", r("evidence.report.preexisting", { gates: e.gates.preexisting.join(", ") }));
  }
  if (e.gates.fixedByTask.length) {
    add("", r("evidence.report.fixedByTask", { gates: e.gates.fixedByTask.join(", ") }));
  }
  const failures = [
    ...e.gates.baseline.filter(failed).map((g) => ({ g, when: r("evidence.gate.before") })),
    ...e.gates.runs.filter(failed).map((g) => ({ g, when: round(g) })),
  ];
  // Plain markdown, no HTML: the app renders the report without raw HTML. The fence outgrows any backticks in the log.
  for (const { g, when } of failures.slice(-4)) {
    const tail = g.tail || r("evidence.gate.noOutput");
    const fence = "`".repeat(Math.max(3, ...[...tail.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const log = { gate: g.kind, when, command: g.command };
    add(
      "",
      g.package === "." ? r("evidence.report.log", log) : r("evidence.report.logIn", { ...log, package: g.package }),
      "",
      fence,
      tail,
      fence,
    );
  }
  add("", r("evidence.report.criteria"), "");
  for (const c of e.criteria) {
    add(
      r("evidence.report.criterion", {
        id: c.id,
        text: c.text,
        status: named(CRITERION_TEXT, c.status),
        detail: c.detailRef ?? c.detail,
      }),
    );
  }
  if (!e.criteria.length) add(r("evidence.report.none"));
  add("", r("evidence.report.review"), "");
  if (!e.review) add(e.noReview === null ? r("evidence.report.noReview") : shown(e.noReview, e.noReviewRef));
  else {
    add(r("evidence.report.verdict", { verdict: named(VERDICT_TEXT, e.review.verdict) }), "");
    for (const f of e.review.findings) {
      const severity = named(SEVERITY_TEXT, f.severity);
      add(
        f.file
          ? r("evidence.report.findingIn", { severity, file: f.file, text: f.text })
          : r("evidence.report.finding", { severity, text: f.text }),
      );
    }
    if (!e.review.findings.length) add(r("evidence.report.noFindings"));
  }
  add("", r("evidence.report.security"), "");
  if (e.security.guardBlocks.length) {
    add(r("evidence.report.guardBlocked"));
    for (const b of e.security.guardBlocks) add(`- ${b.tool} \`${cell(b.target)}\`: ${b.reason}`);
  } else add(r("evidence.report.guardNothing"));
  add("");
  if (e.security.approvals.length) {
    add(r("evidence.report.approvals"));
    for (const a of e.security.approvals) {
      add(
        r("evidence.report.approval", {
          risk: named(RISK_TEXT, a.risk),
          tool: a.tool,
          target: cell(a.target),
          label: a.labelRef ?? a.label,
          decision: !a.allowed
            ? resultRef("evidence.approval.denied")
            : a.always
              ? resultRef("evidence.approval.always")
              : resultRef("evidence.approval.once"),
        }),
      );
    }
  } else add(r("evidence.report.noApprovals"));
  add(r("evidence.report.notListed"), "");
  const secrets = e.security.secrets;
  add(
    !secrets.ran
      ? r("evidence.secrets.notRun", { why: secrets.whyRef ?? secrets.why })
      : secrets.flagged.length
        ? r("evidence.secrets.flagged", { files: secrets.flagged.map((f) => `\`${f}\``).join(", ") })
        : r("evidence.secrets.clean", { count: secrets.scanned }),
  );
  add("", r("evidence.report.risks"), "");
  for (const x of e.risks.contract) add(r("evidence.report.fromContract", { text: x }));
  for (const [i, x] of e.risks.fromImplementer.entries()) {
    add(r("evidence.report.claudeSays", { text: e.risks.fromImplementerRefs?.[i] ?? x }));
  }
  for (const m of e.risks.manual) add(r("evidence.report.checkByHand", { text: m }));
  if (!e.risks.contract.length && !e.risks.fromImplementer.length && !e.risks.manual.length) {
    add(r("evidence.report.noneNoted"));
  }
  const pr = e.pr;
  if (pr) {
    add("", r("evidence.pr.heading"), "");
    add(r("evidence.pr.link", { number: pr.number, url: pr.url, head: pr.head, base: pr.base }));
    if (pr.review) {
      add(
        r("evidence.pr.review", {
          by: resultRef(pr.review.source === "run" ? "evidence.pr.byRun" : "evidence.pr.byPr"),
          sha: pr.review.headSha.slice(0, 7),
          verdict: named(VERDICT_TEXT, pr.review.verdict),
          count: pr.review.mustFix,
        }),
      );
    }
    for (const [i, f] of (pr.fixes ?? []).entries()) {
      add(r("evidence.pr.fix", { n: i + 1, check: f.check, state: named(STEP_TEXT, f.state) }));
    }
    if (pr.merged) {
      const merged = { method: pr.merged.method, sha: pr.merged.sha.slice(0, 7), at: pr.merged.at };
      add(
        pr.merged.accepted
          ? r("evidence.pr.mergedAccepted", { ...merged, reason: pr.merged.accepted })
          : r("evidence.pr.merged", merged),
      );
    }
  }
  if (e.bestOf) {
    add("", r("evidence.bestOf.heading"), "");
    for (const v of e.bestOf.compared) {
      add(
        r(v.index === e.bestOf.chosen ? "evidence.bestOf.kept" : "evidence.bestOf.variant", {
          n: v.index,
          agent: v.model ? `${AGENT_NAMES[v.agent]} ${v.model}` : AGENT_NAMES[v.agent],
          state: named(STATE_TEXT, v.state),
          passed: v.gates.passed.length,
          failed: v.gates.failed.length,
          count: v.files,
          added: v.added,
          removed: v.removed,
          cost: usd(v.costUsd),
        }),
      );
    }
  }
  if (e.feedback?.length) {
    add("", r("evidence.feedback.heading"), "");
    for (const [i, f] of e.feedback.entries()) {
      add(
        r(f.source === "github" ? "evidence.feedback.roundGithub" : "evidence.feedback.round", {
          n: i + 1,
          count: f.comments,
          files: f.files.map((x) => `\`${x}\``).join(", "),
          state: named(STEP_TEXT, f.state),
        }),
      );
    }
  }
  if (e.deploys?.length) {
    add("", r("evidence.deploy.heading"), "");
    for (const d of e.deploys) {
      const where = { env: d.env, adapter: d.adapter, commit: d.commit.slice(0, 7) };
      add(
        d.status !== "done"
          ? r("evidence.deploy.failed", {
              ...where,
              error: d.errorRef ?? d.error ?? resultRef("evidence.deploy.noDetail"),
            })
          : d.smoke
            ? r("evidence.deploy.doneSmoke", {
                ...where,
                url: String(d.url),
                how: d.smoke.how,
                result: resultRef(d.smoke.ok ? "evidence.deploy.smokePassed" : "evidence.deploy.smokeFailed"),
                detail: d.smoke.detailRef ?? d.smoke.detail,
              })
            : r("evidence.deploy.done", { ...where, url: String(d.url) }),
      );
    }
  }
  add("", r("evidence.report.cost"), "", r("evidence.report.costTable"), "|---|---|---|---|");
  for (const s of e.cost.steps) {
    const ran = s.agent ? [AGENT_NAMES[s.agent], s.model].filter(Boolean).join(" · ") : "–";
    const tokens = s.tokens ? (s.tokens.input + s.tokens.output).toLocaleString("en-US") : "";
    const cost =
      s.costKind === "unknown"
        ? r("evidence.report.costUnknown", { tokens })
        : s.costKind === "estimate" && tokens
          ? r("evidence.report.costTokens", { cost: usd(s.costUsd), tokens })
          : usd(s.costUsd);
    add(`| ${cell(shown(s.label, s.labelRef))} | ${cell(ran)} | ${seconds(s.durationMs)} | ${cost} |`);
  }
  add("", r("evidence.report.costTotal", { run: usd(e.cost.runUsd), total: usd(e.cost.totalUsd) }), "");
  if (e.cost.steps.some((s) => s.costKind)) add(r("evidence.report.costEstimated"), "");
  add(r("evidence.report.generated", { at: e.generatedAt }), "");
  return out.join("\n");
}
