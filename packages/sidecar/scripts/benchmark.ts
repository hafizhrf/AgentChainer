// Eval benchmark (M7-02, docs/design/evals.md §5): runs every case of the suite for each variant, with real model calls
// through the sidecar, on fresh copies of fixtures/, and writes a report with each variant's delta against the first.
// Approvals are answered yes, as in live-task.ts; it runs with your own `claude` login.
//
// Usage: node scripts/benchmark.ts [--variant <spec>]… [-n 3] [--max-usd 3] [--cases id,id] [--suite <file>]
//          [--out <path without extension>] [--dry-run]
//   --variant name[:model=<m>,workflows=<dir>,workflows-ref=<rev>]  repeatable; the first is the baseline. Default: one
//       variant "app" with the app's workflows on haiku. For a workflow change: --variant main:workflows-ref=origin/main
//       --variant branch
//   -n         runs per case and variant (single runs are noisy)
//   --max-usd  the cap for the whole benchmark ($3 a variant by default): a run is cancelled once it would pass it,
//              and later runs are skipped
//   --dry-run  checks the suite and the variants and prints the plan; no model calls
//   cost: an S case on haiku is a few cents a run; N=3 over the suite is about $1 a variant.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { removeFixtureCopies } from "../src/detect/fixture-copy.ts";
import { SidecarClient } from "../src/evals/client.ts";
import { delta, type EvalReport, libraryInputs, renderMarkdown, summarize } from "../src/evals/report.ts";
import { type CaseRun, runCase } from "../src/evals/run-case.ts";
import { parseVariant, readSuite } from "../src/evals/suite.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const repoRoot = here("../../../");
const { values } = parseArgs({
  options: {
    variant: { type: "string", multiple: true },
    n: { type: "string", short: "n", default: "3" },
    "max-usd": { type: "string" },
    cases: { type: "string" },
    suite: { type: "string", default: here("../test/evals/suite.json") },
    out: { type: "string", default: here("../test/evals/report") },
    "dry-run": { type: "boolean", default: false },
  },
});

const n = Number(values.n);
if (!Number.isInteger(n) || n < 1) throw new Error("-n takes a whole number of runs, 1 or more");
const suite = readSuite(values.suite);
const only = values.cases?.split(",");
const unknown = only?.filter((id) => !suite.cases.some((c) => c.id === id)) ?? [];
if (unknown.length) throw new Error(`no case ${unknown.join(", ")} in the suite`);
const cases = suite.cases.filter((c) => !only || only.includes(c.id));
const variants = (values.variant ?? ["app"]).map((s) => parseVariant(s, repoRoot));
if (new Set(variants.map((v) => v.name)).size !== variants.length) throw new Error("give each variant its own name");
const maxUsd = Number(values["max-usd"] ?? 3 * variants.length);
if (!(maxUsd > 0)) throw new Error("--max-usd takes a positive amount");

const plan = Array.from({ length: n }, () => cases.flatMap((c) => variants.map((v) => ({ c, v })))).flat();
console.log(`${cases.length} cases × ${variants.length} variants × N=${n} = ${plan.length} runs, cap $${maxUsd}`);
for (const v of variants) {
  console.log(`  ${v.name}: ${v.model}, workflows ${v.workflowsFrom ?? "the app's"}`);
}
if (values["dry-run"]) process.exit(0);

const git = (...args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const client = new SidecarClient();
const runs: CaseRun[] = [];
let spent = 0;
let skipped = 0;
try {
  await client.request("system.hello", { protocolVersion: 2 });
  for (const [i, { c, v }] of plan.entries()) {
    if (spent >= maxUsd) {
      skipped = plan.length - i;
      console.log(`cap of $${maxUsd} reached: ${skipped} runs skipped`);
      break;
    }
    const row = await runCase(client, c, v, {
      hiddenRoot: here("../test/evals/hidden"),
      cancelAbove: maxUsd - spent,
      log: console.log,
    });
    spent += row.costUsd;
    runs.push(row);
    const checks = row.checks.map((k) => `${k.name} ${k.exitCode}`).join(", ");
    const gates = row.failedGates.length ? `; failed gates: ${row.failedGates.join(", ")}` : "";
    console.log(
      `${row.passed ? "✓" : "✗"} ${String(i + 1).padStart(3)}/${plan.length} ${v.name} ${c.id}: ${row.state}, ` +
        `$${row.costUsd.toFixed(3)}, ${Math.round(row.durationMs / 1000)} s${checks ? ` (${checks})` : ""}` +
        `${gates}${row.error ? ` — ${row.error}` : ""}`,
    );
  }
} finally {
  await client.close();
  removeFixtureCopies();
}

const ids = cases.map((c) => c.id);
const summaries = variants.map((v) => summarize(v, runs, ids));
const [base, ...others] = summaries;
const report: EvalReport = {
  version: 1,
  generatedAt: new Date().toISOString(),
  app: { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--untracked-files=no") !== "" },
  suite: { file: path.relative(repoRoot, values.suite).replaceAll("\\", "/"), cases: ids },
  n,
  maxUsd,
  spentUsd: spent,
  skipped,
  inputs: libraryInputs(repoRoot),
  variants: summaries,
  deltas: base ? others.map((v) => delta(v, base, runs)) : [],
  runs,
};
writeFileSync(`${values.out}.json`, `${JSON.stringify(report, null, 2)}\n`);
const markdown = renderMarkdown(report);
writeFileSync(`${values.out}.md`, markdown);
console.log(`\n${markdown}\nWrote ${values.out}.json and .md`);
