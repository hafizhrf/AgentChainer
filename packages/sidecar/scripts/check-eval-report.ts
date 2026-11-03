// Eval report check (M7-03, docs/design/evals.md §6): fails when a tier workflow (catalog/workflows/) or a role prompt
// (agents/) differs from the files the committed report in test/evals/ was made with. No model calls; CI runs it.
// To fix a failure, run the benchmark and commit its report, e.g.:
//   node packages/sidecar/scripts/benchmark.ts --variant main:workflows-ref=origin/main --variant branch

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkReport } from "../src/evals/check.ts";
import { type EvalReport, libraryInputs } from "../src/evals/report.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const base = fileURLToPath(new URL("../test/evals/report", import.meta.url));
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null);

const json = read(`${base}.json`);
const report = json ? (JSON.parse(json) as EvalReport) : null;
const problems = checkReport(report, read(`${base}.md`), libraryInputs(repoRoot));
if (problems.length) {
  console.error(`The eval report is out of date:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  console.error(
    "\nRun the benchmark with the change, commit packages/sidecar/test/evals/report.json and report.md, and put the " +
      "report's summary in the PR body:\n  node packages/sidecar/scripts/benchmark.ts " +
      "--variant main:workflows-ref=origin/main --variant branch",
  );
  process.exit(1);
}
const v = report?.variants ?? [];
console.log(
  `The eval report covers today's workflows and role prompts (${report?.app.commit.slice(0, 7)}, ` +
    `${v.map((x) => `${x.name} ${x.passes}/${x.runs}`).join(", ")}).`,
);
