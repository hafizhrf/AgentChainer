import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { percentile } from "../tasks/metrics.ts";
import type { CaseRun } from "./run-case.ts";
import type { Variant } from "./suite.ts";

/**
 * The eval report (M7-02, docs/design/evals.md §5): per variant and case, passes out of N, cost, time and fix rounds;
 * each variant's delta against the first (the baseline) with a 95% interval; and the sha256 of every first-party file
 * a task run depends on, which the regression check compares with the PR's (§6).
 */

export type Interval = [number, number];

export type VariantSummary = {
  name: string;
  model: string;
  workflowsFrom: string | null;
  /** sha256 of each workflow file the variant put in place of the app's. */
  workflows: Record<string, string>;
  runs: number;
  passes: number;
  passRate: number | null;
  passInterval: Interval | null;
  costPerRun: number | null;
  /** Everything spent, failed runs included, over the passes. */
  costPerPass: number | null;
  durationP50Ms: number | null;
  fixRounds: number;
  errors: number;
  cases: { case: string; runs: number; passes: number; costUsd: number; durationMs: number; fixRounds: number }[];
};

export type Delta = {
  variant: string;
  baseline: string;
  passRate: { diff: number; interval: Interval } | null;
  costPerRun: { diff: number; interval: Interval | null } | null;
  /** What the numbers support, in words; with a small N that's usually "no clear difference". */
  verdict: string;
};

export type EvalReport = {
  version: 1;
  generatedAt: string;
  app: { commit: string; dirty: boolean };
  suite: { file: string; cases: string[] };
  n: number;
  maxUsd: number;
  spentUsd: number;
  /** Runs left out because the budget ran out. */
  skipped: number;
  /** sha256 of each file in catalog/workflows/ and agents/ at the app commit (the shipped library's inputs). */
  inputs: Record<string, string>;
  variants: VariantSummary[];
  deltas: Delta[];
  runs: CaseRun[];
};

const Z = 1.96;
export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** The Wilson score interval for k passes out of n. */
export function wilson(k: number, n: number): Interval | null {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / d;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Newcombe's interval for the difference of two pass rates, from their Wilson intervals. */
export function rateDiff(k1: number, n1: number, k2: number, n2: number): { diff: number; interval: Interval } | null {
  const w1 = wilson(k1, n1);
  const w2 = wilson(k2, n2);
  if (!w1 || !w2) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const diff = p1 - p2;
  return {
    diff,
    interval: [
      diff - Math.sqrt((p1 - w1[0]) ** 2 + (w2[1] - p2) ** 2),
      diff + Math.sqrt((w1[1] - p1) ** 2 + (p2 - w2[0]) ** 2),
    ],
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs: number[]) => xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1);

/** The difference of two means with a normal 95% interval (Welch's standard error); no interval under 2 samples. */
export function meanDiff(a: number[], b: number[]): { diff: number; interval: Interval | null } | null {
  if (!a.length || !b.length) return null;
  const diff = mean(a) - mean(b);
  if (a.length < 2 || b.length < 2) return { diff, interval: null };
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  return { diff, interval: [diff - Z * se, diff + Z * se] };
}

/**
 * A workflow's text as a run reads it: without its translations (`i18n`, X-13), which only change what the app shows.
 * So translating a workflow needs no new benchmark, while any change to its steps still does.
 */
export const withoutTranslations = (yaml: string) => yaml.replace(/^i18n:[^\n]*\n(?:(?:[ \t][^\n]*)?\n)*/m, "");

/** The first-party files a task run reads: the tier workflows and the role prompts. */
export function libraryInputs(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dir, ext] of [
    ["catalog/workflows", ".yaml"],
    ["agents", ".md"],
  ] as const) {
    for (const f of readdirSync(path.join(repoRoot, dir))
      .filter((n) => n.endsWith(ext))
      .sort()) {
      // Hashed with LF line ends, so a Windows checkout and CI agree.
      const text = readFileSync(path.join(repoRoot, dir, f), "utf8").replace(/\r\n/g, "\n");
      out[`${dir}/${f}`] = sha256(ext === ".yaml" ? withoutTranslations(text) : text);
    }
  }
  return out;
}

export function summarize(v: Variant, runs: CaseRun[], caseIds: string[]): VariantSummary {
  const mine = runs.filter((r) => r.variant === v.name);
  const passes = mine.filter((r) => r.passed).length;
  const spent = mine.reduce((a, r) => a + r.costUsd, 0);
  const durations = mine.map((r) => r.durationMs).sort((a, b) => a - b);
  return {
    name: v.name,
    model: v.model,
    workflowsFrom: v.workflowsFrom,
    workflows: Object.fromEntries(Object.entries(v.workflows).map(([f, text]) => [f, sha256(text)])),
    runs: mine.length,
    passes,
    passRate: mine.length ? passes / mine.length : null,
    passInterval: wilson(passes, mine.length),
    costPerRun: mine.length ? spent / mine.length : null,
    costPerPass: passes ? spent / passes : null,
    durationP50Ms: durations.length ? percentile(durations, 0.5) : null,
    fixRounds: mine.reduce((a, r) => a + r.fixRounds, 0),
    errors: mine.filter((r) => r.error).length,
    cases: caseIds.map((id) => {
      const rs = mine.filter((r) => r.case === id);
      return {
        case: id,
        runs: rs.length,
        passes: rs.filter((r) => r.passed).length,
        costUsd: rs.length ? mean(rs.map((r) => r.costUsd)) : 0,
        durationMs: rs.length ? mean(rs.map((r) => r.durationMs)) : 0,
        fixRounds: rs.reduce((a, r) => a + r.fixRounds, 0),
      };
    }),
  };
}

export function delta(v: VariantSummary, base: VariantSummary, runs: CaseRun[]): Delta {
  const costs = (name: string) => runs.filter((r) => r.variant === name).map((r) => r.costUsd);
  const passRate = rateDiff(v.passes, v.runs, base.passes, base.runs);
  const costPerRun = meanDiff(costs(v.name), costs(base.name));
  const words: string[] = [];
  if (!passRate) words.push("no runs to compare");
  else if (passRate.interval[0] > 0) words.push("passes more often");
  else if (passRate.interval[1] < 0) words.push("passes less often");
  else words.push("no clear difference in passes");
  if (costPerRun?.interval) {
    if (costPerRun.interval[1] < 0) words.push("costs less");
    else if (costPerRun.interval[0] > 0) words.push("costs more");
    else words.push("no clear difference in cost");
  }
  if (passRate && passRate.interval[0] <= 0 && passRate.interval[1] >= 0 && Math.min(v.runs, base.runs) < 20) {
    words.push(`with ${Math.min(v.runs, base.runs)} runs a side, a difference this size may be noise`);
  }
  return { variant: v.name, baseline: base.name, passRate, costPerRun, verdict: words.join("; ") };
}

const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
const signedPct = (r: number) => `${r > 0 ? "+" : ""}${Math.round(r * 100)}`;
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(3)}`);
const signedUsd = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(3)}`;
const secs = (ms: number | null) => (ms === null ? "—" : `${Math.round(ms / 1000)} s`);

/** The report as Markdown, for `report.md` and the PR body (the summary table is the M7-E1 evidence). */
export function renderMarkdown(r: EvalReport): string {
  const out: string[] = [
    "# Eval report",
    "",
    `App ${r.app.commit}${r.app.dirty ? " (with uncommitted changes)" : ""}, ${r.generatedAt.slice(0, 10)}. ` +
      `${r.suite.cases.length} cases × N=${r.n} from \`${r.suite.file}\`; ` +
      `spent ≈$${r.spentUsd.toFixed(2)} of a $${r.maxUsd.toFixed(2)} cap` +
      `${r.skipped ? `, ${r.skipped} runs skipped when the cap was reached` : ""}.`,
    "",
    "A run passes when every acceptance check exits 0, including the hidden ones the agent never saw.",
    "",
    "| Variant | Model | Workflows | Passed | 95% interval | Cost per run | Cost per pass | Median time | Fix rounds |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const v of r.variants) {
    out.push(
      `| ${v.name} | ${v.model} | ${v.workflowsFrom ?? "the app's"} | ${v.passes}/${v.runs} (${pct(v.passRate)}) | ` +
        `${v.passInterval ? `${pct(v.passInterval[0])}–${pct(v.passInterval[1])}` : "—"} | ${usd(v.costPerRun)} | ` +
        `${usd(v.costPerPass)} | ${secs(v.durationP50Ms)} | ${v.fixRounds} |`,
    );
  }
  if (r.deltas.length) {
    out.push("", `## Against ${r.deltas[0]?.baseline}`, "");
    out.push("| Variant | Pass rate (points) | Cost per run | Reading |", "|---|---|---|---|");
    for (const d of r.deltas) {
      const p = d.passRate
        ? `${signedPct(d.passRate.diff)} (${signedPct(d.passRate.interval[0])} to ${signedPct(d.passRate.interval[1])})`
        : "—";
      const c = d.costPerRun
        ? `${signedUsd(d.costPerRun.diff)}${d.costPerRun.interval ? ` (${signedUsd(d.costPerRun.interval[0])} to ${signedUsd(d.costPerRun.interval[1])})` : ""}`
        : "—";
      out.push(`| ${d.variant} | ${p} | ${c} | ${d.verdict} |`);
    }
  }
  out.push("", "## By case", "", `| Case | ${r.variants.map((v) => v.name).join(" | ")} |`);
  out.push(`|---|${r.variants.map(() => "---").join("|")}|`);
  for (const id of r.suite.cases) {
    const cells = r.variants.map((v) => {
      const c = v.cases.find((x) => x.case === id);
      return c?.runs ? `${c.passes}/${c.runs} · ${usd(c.costUsd)} · ${secs(c.durationMs)}` : "—";
    });
    out.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  const disagree = r.runs.filter((x) => x.passed && x.state !== "done");
  if (disagree.length) {
    out.push("", "## Runs that passed the checks but not by the task's own verdict", "");
    const groups = new Map<string, { runs: CaseRun[]; gates: Set<string> }>();
    for (const x of disagree) {
      const key = `${x.variant} / ${x.case}`;
      const g = groups.get(key) ?? { runs: [], gates: new Set() };
      g.runs.push(x);
      for (const gate of x.failedGates) g.gates.add(gate);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      const states = [...new Set(g.runs.map((x) => x.state))].join(", ");
      const gates = g.gates.size ? `; failed gates: ${[...g.gates].join(", ")}` : "";
      out.push(`- ${key}: ${g.runs.length} ${g.runs.length === 1 ? "run" : "runs"} ${states}${gates}`);
    }
  }
  const failed = r.runs.filter((x) => !x.passed);
  if (failed.length) {
    out.push("", "## Runs that didn't pass", "");
    for (const x of failed) {
      const checks = x.checks.map((k) => `${k.name} → ${k.exitCode}`).join(", ");
      out.push(`- ${x.variant} / ${x.case}: ${x.state}${x.error ? `, ${x.error}` : ""}${checks ? `; ${checks}` : ""}`);
    }
  }
  // M3-E2. Only in reports from runs that checked their evidence, so older reports render as they were committed.
  const checked = r.runs.filter((x) => x.evidence);
  if (checked.length) {
    const reruns = checked.flatMap((x) => (x.evidence?.rerun ?? []).map((g) => ({ ...g, run: x })));
    const off = reruns.filter((g) => g.recorded !== g.now);
    const unlike = checked.filter((x) => !x.evidence?.reportMatches);
    out.push(
      "",
      "## Evidence (M3-E2)",
      "",
      `- ${checked.length - unlike.length}/${checked.length} reports hold exactly their run's recorded gate runs.`,
      `- ${reruns.length - off.length}/${reruns.length} last-round gate commands, run again by hand, gave the recorded exit code.`,
    );
    for (const x of unlike) out.push(`- ${x.variant} / ${x.case}: the report's gate runs differ from the run's.`);
    for (const g of off) {
      out.push(`- ${g.run.variant} / ${g.run.case}: ${g.gate} recorded ${g.recorded ?? "none"}, again ${g.now}.`);
    }
  }
  out.push("", "## Inputs", "", "sha256 of the first-party files a task run reads, at the app commit:", "");
  for (const [f, h] of Object.entries(r.inputs)) out.push(`- \`${f}\` ${h.slice(0, 12)}`);
  return `${out.join("\n")}\n`;
}
