import type { ApprovalRecord, GateKind, GateRun, GuardBlock, Task } from "@agentchainer/protocol";
import type { Review } from "./orchestrator.ts";

/**
 * The evidence report (M3-09, planner.md §9): built only from what the run recorded, never from what Claude says about
 * itself, except where it's labeled as Claude's statement (a file's purpose, the implementer's notes). Gate results
 * are the commands' real exit codes; a gate that didn't run is said to have not run, never to have passed.
 */

export type FileChange = {
  path: string;
  status: "new" | "modified" | "deleted";
  /** null for binary files. */
  added: number | null;
  removed: number | null;
};

export type SecretsScan = { ran: false; why: string } | { ran: true; scanned: number; flagged: string[] };

export type EvidenceInput = {
  task: Task;
  files: FileChange[];
  /** The implementer's latest summary (`summary.md`). */
  summary: string | null;
  review: Review | null;
  secrets: SecretsScan;
  now: Date;
};

export type CriterionResult = {
  id: string;
  text: string;
  check: string;
  status: "proved" | "failed" | "not-run" | "met" | "not-met" | "unclear" | "manual";
  detail: string;
};

export type Evidence = {
  version: 1;
  generatedAt: string;
  task: {
    id: string;
    request: string;
    objective: string;
    tier: string;
    proposed: string;
    overrideReason?: string;
    budgetUsd: number;
    approvedAt?: string;
  };
  outcome: { state: Task["state"]; text: string; acceptance?: { reason: string; at: string } };
  files: (FileChange & { purpose: string | null })[];
  gates: { baseline: GateRun[]; runs: GateRun[]; notRun: GateKind[]; preexisting: string[]; fixedByTask: string[] };
  criteria: CriterionResult[];
  review: Review | null;
  /** Why there's no review, when there isn't one. */
  noReview: string | null;
  security: { guardBlocks: GuardBlock[]; approvals: ApprovalRecord[]; secrets: SecretsScan };
  risks: { contract: string[]; fromImplementer: string[]; manual: string[] };
  cost: { steps: { label: string; durationMs: number | null; costUsd: number }[]; runUsd: number; totalUsd: number };
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
    const m = /^`?([^`:\s][^`:]*?)`?\s*[:—–-]\s+(.+)$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1].trim().replace(/^\.\//, ""), m[2].trim());
  }
  return out;
}

function purposeOf(path: string, known: Map<string, string>): string | null {
  const exact = known.get(path);
  if (exact) return exact;
  for (const [p, text] of known) if (path.endsWith(`/${p}`) || p.endsWith(`/${path}`)) return text;
  return null;
}

/** Why a run has no review: its tier has none, the run ended first, or the answer couldn't be read. */
function reviewAbsence(task: Task): string {
  if (task.triage?.chosen === "S") return "Tier S has no independent review.";
  if (!task.run?.steps.some((s) => s.role === "independent-reviewer" && s.kind === "agent"))
    return "The independent review didn't run: the run ended before it.";
  return "The review's answer couldn't be read.";
}

function criterion(
  task: Task,
  review: Review | null,
  noReview: string | null,
  c: { id: string; text: string; check: string },
): CriterionResult {
  const base = { id: c.id, text: c.text, check: c.check };
  const run = task.run;
  if (c.check.startsWith("gate:")) {
    const kind = c.check.slice(5);
    const runs = run?.gates.filter((g) => g.kind === kind) ?? [];
    if (!runs.length) {
      return {
        ...base,
        status: "not-run",
        detail: run?.notRun.includes(kind as GateKind)
          ? `${kind} has no command in this workspace.`
          : `${kind} didn't run.`,
      };
    }
    const last = Math.max(...runs.map((g) => g.round));
    const latest = runs.filter((g) => g.round === last);
    const bad = latest.filter(failed);
    const before = bad.every((g) => run?.baseline.some((b) => failed(b) && gateKey(b) === gateKey(g)));
    return bad.length
      ? {
          ...base,
          status: "failed",
          detail: `${kind} failed in round ${last + 1} (${bad.map((g) => `exit ${g.exitCode ?? "none"}`).join(", ")}).${
            before ? ` It already failed before the task, so this criterion isn't proved either way.` : ""
          }`,
        }
      : { ...base, status: "proved", detail: `${kind} passed in round ${last + 1}, after the last change.` };
  }
  if (c.check === "review") {
    const judged = review?.criteria.find((r) => r.id === c.id);
    if (!judged) return { ...base, status: "not-run", detail: noReview ?? "The reviewer didn't judge it." };
    const status = judged.met === "yes" ? "met" : judged.met === "no" ? "not-met" : "unclear";
    return { ...base, status, detail: `Reviewer: ${judged.why}` };
  }
  return { ...base, status: "manual", detail: "Manual: not checked by AgentChainer." };
}

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function buildEvidence({ task, files, summary, review, secrets, now }: EvidenceInput): Evidence {
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
  return {
    version: 1,
    generatedAt: now.toISOString(),
    task: {
      id: task.id,
      request: task.request,
      objective: contract?.objective ?? "",
      tier: triage?.chosen ?? "",
      proposed: triage?.proposed ?? "",
      ...(triage?.override ? { overrideReason: triage.override.reason } : {}),
      budgetUsd: triage?.budgetUsd ?? 0,
      ...(contract?.approvedAt ? { approvedAt: contract.approvedAt } : {}),
    },
    outcome: {
      state: task.state,
      text: run?.outcome ?? "The task hasn't run.",
      ...(run?.acceptance ? { acceptance: run.acceptance } : {}),
    },
    files: files.map((f) => ({ ...f, purpose: purposeOf(f.path, known) })),
    gates: {
      baseline: run?.baseline ?? [],
      runs: run?.gates ?? [],
      notRun: run?.notRun ?? [],
      preexisting: preexisting.map(gateKey),
      fixedByTask,
    },
    criteria: (contract?.acceptanceCriteria ?? []).map((c) => criterion(task, review, noReview, c)),
    review,
    noReview,
    security: {
      guardBlocks: run?.guardBlocks ?? [],
      approvals: [...(run?.approvals ?? [])].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]),
      secrets,
    },
    risks: {
      contract: contract?.risks ?? [],
      fromImplementer: sectionLines(summary, "Notes"),
      manual: (contract?.acceptanceCriteria ?? []).filter((c) => c.check === "manual").map((c) => c.text),
    },
    cost: {
      steps: (run?.steps ?? []).map((s) => ({
        label: s.label,
        durationMs: s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : null,
        costUsd: s.costUsd,
      })),
      runUsd: run?.costUsd ?? 0,
      totalUsd: task.costUsd,
    },
  };
}

const STATE_TEXT: Partial<Record<Task["state"], string>> = {
  done: "Done",
  failed: "Failed",
  unverified: "Not verified",
  cancelled: "Stopped",
  accepted: "Accepted with risk",
  running: "Running",
  interrupted: "Interrupted",
};

const CRITERION_TEXT: Record<CriterionResult["status"], string> = {
  proved: "proved by a gate",
  failed: "gate failed",
  "not-run": "not checked",
  met: "met (reviewer)",
  "not-met": "not met (reviewer)",
  unclear: "unclear (reviewer)",
  manual: "manual",
};

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const usd = (n: number) => `≈$${n.toFixed(n < 0.1 ? 4 : 2)}`;
const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

function gateRow(g: GateRun, when: string): string {
  return `| ${when} | ${g.kind} | \`${cell(g.command)}\` | ${cell(g.package)} | ${g.timedOut ? "timed out" : `exit ${g.exitCode ?? "none"}`} | ${seconds(g.durationMs)} |`;
}

/** The report as markdown: what's exported and shown on the task page. */
export function renderEvidence(e: Evidence): string {
  const out: string[] = [];
  const add = (...lines: string[]) => out.push(...lines);
  add(`# Task evidence: ${e.task.objective || e.task.request}`, "");
  add(`- **Request:** ${e.task.request}`);
  add(
    `- **Tier:** ${e.task.tier}${e.task.tier !== e.task.proposed ? ` (proposed ${e.task.proposed}; changed because: ${e.task.overrideReason ?? "no reason"})` : ""}, budget $${e.task.budgetUsd}`,
  );
  if (e.task.approvedAt) add(`- **Contract approved:** ${e.task.approvedAt}`);
  add(`- **Outcome:** **${STATE_TEXT[e.outcome.state] ?? e.outcome.state}.** ${e.outcome.text}`);
  if (e.outcome.acceptance) {
    add(`- **Risk accepted** by the user at ${e.outcome.acceptance.at}: ${e.outcome.acceptance.reason}`);
  }
  add("", "## Changed files", "");
  if (!e.files.length) add("No files changed since the task started.");
  else {
    add("| File | Change | + | − | Purpose (from the implementer) |", "|---|---|---|---|---|");
    for (const f of e.files) {
      add(
        `| \`${cell(f.path)}\` | ${f.status} | ${f.added ?? "binary"} | ${f.removed ?? "binary"} | ${cell(f.purpose ?? "no explanation")} |`,
      );
    }
  }
  add("", "## Gates", "", "Run by AgentChainer, with the commands' real exit codes.", "");
  if (!e.gates.baseline.length && !e.gates.runs.length) add("No gate ran.");
  else {
    add("| When | Gate | Command | Package | Result | Time |", "|---|---|---|---|---|---|");
    for (const g of e.gates.baseline) add(gateRow(g, "before the task"));
    for (const g of e.gates.runs) add(gateRow(g, `round ${g.round + 1}`));
  }
  if (e.gates.notRun.length)
    add("", `Not run, no command detected: ${e.gates.notRun.join(", ")}. They don't count as passed.`);
  if (e.gates.preexisting.length) add("", `Already failing before the task: ${e.gates.preexisting.join(", ")}.`);
  if (e.gates.fixedByTask.length)
    add("", `Failing before the task and passing now: ${e.gates.fixedByTask.join(", ")}.`);
  const failures = [
    ...e.gates.baseline.filter(failed).map((g) => ({ g, when: "before the task" })),
    ...e.gates.runs.filter(failed).map((g) => ({ g, when: `round ${g.round + 1}` })),
  ];
  // Plain markdown, no HTML: the app renders the report without raw HTML. The fence outgrows any backticks in the log.
  for (const { g, when } of failures.slice(-4)) {
    const tail = g.tail || "(no output)";
    const fence = "`".repeat(Math.max(3, ...[...tail.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    add(
      "",
      `**${g.kind} log, ${when}** (\`${g.command}\`${g.package === "." ? "" : ` in ${g.package}`}):`,
      "",
      fence,
      tail,
      fence,
    );
  }
  add("", "## Acceptance criteria", "");
  for (const c of e.criteria) add(`- **${c.id}** ${c.text}: _${CRITERION_TEXT[c.status]}._ ${c.detail}`);
  if (!e.criteria.length) add("None.");
  add("", "## Review", "");
  if (!e.review) add(e.noReview ?? "No review.");
  else {
    add(`Verdict: **${e.review.verdict}**.`, "");
    for (const f of e.review.findings) add(`- ${f.severity}${f.file ? ` · \`${f.file}\`` : ""}: ${f.text}`);
    if (!e.review.findings.length) add("No findings.");
  }
  add("", "## Security notes", "");
  if (e.security.guardBlocks.length) {
    add("Blocked by the guard:");
    for (const b of e.security.guardBlocks) add(`- ${b.tool} \`${cell(b.target)}\`: ${b.reason}`);
  } else add("The guard blocked nothing.");
  add("");
  if (e.security.approvals.length) {
    add("Approvals Claude asked for, riskiest first:");
    for (const a of e.security.approvals) {
      add(
        `- ${a.risk} risk · ${a.tool} \`${cell(a.target)}\` (${a.label}): ${a.allowed ? (a.always ? "allowed, saved as a rule" : "allowed once") : "denied"}`,
      );
    }
  } else add("No approvals were asked for.");
  add("Calls your settings or the permission profile allowed without asking aren't listed.", "");
  add(
    e.security.secrets.ran
      ? e.security.secrets.flagged.length
        ? `Secrets scan (gitleaks): possible secrets in ${e.security.secrets.flagged.map((f) => `\`${f}\``).join(", ")}.`
        : `Secrets scan (gitleaks): nothing found in ${e.security.secrets.scanned} changed file${e.security.secrets.scanned === 1 ? "" : "s"}.`
      : `Secrets scan: not run (${e.security.secrets.why}).`,
  );
  add("", "## Remaining risks and manual steps", "");
  for (const r of e.risks.contract) add(`- From the contract: ${r}`);
  for (const r of e.risks.fromImplementer) add(`- Claude says: ${r}`);
  for (const m of e.risks.manual) add(`- Check by hand: ${m}`);
  if (!e.risks.contract.length && !e.risks.fromImplementer.length && !e.risks.manual.length) add("None noted.");
  add("", "## Cost and time", "", "| Step | Time | Cost |", "|---|---|---|");
  for (const s of e.cost.steps) add(`| ${cell(s.label)} | ${seconds(s.durationMs)} | ${usd(s.costUsd)} |`);
  add("", `Run ${usd(e.cost.runUsd)}; with drafting and triage ${usd(e.cost.totalUsd)}. Estimates.`, "");
  add(`_Generated by AgentChainer at ${e.generatedAt} from the task's records._`, "");
  return out.join("\n");
}
