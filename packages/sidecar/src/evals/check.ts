import { type EvalReport, renderMarkdown } from "./report.ts";

/**
 * The regression check (M7-03, docs/design/evals.md §6), without model calls: the committed report must have been made
 * with today's first-party files. A changed, added or removed workflow or role prompt needs a new report, so a PR
 * that changes one carries its benchmark result. Returns what's wrong; nothing means the report is current.
 */
export function checkReport(
  report: EvalReport | null,
  markdown: string | null,
  inputs: Record<string, string>,
): string[] {
  if (!report) return ["There's no eval report. Run the benchmark and commit test/evals/report.json and .md."];
  const problems: string[] = [];
  for (const [file, hash] of Object.entries(inputs)) {
    const was = report.inputs[file];
    if (!was) problems.push(`${file} is new since the report.`);
    else if (was !== hash) problems.push(`${file} changed since the report.`);
  }
  for (const file of Object.keys(report.inputs)) {
    if (!(file in inputs)) problems.push(`${file} was removed since the report.`);
  }
  if (!report.runs.length) problems.push("The report has no runs.");
  if (markdown !== renderMarkdown(report)) problems.push("report.md isn't the one report.json renders to.");
  return problems;
}
