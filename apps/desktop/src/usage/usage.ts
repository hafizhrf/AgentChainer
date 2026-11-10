import type { UsageFamily, UsageReport } from "@agentchainer/protocol";

/** The families' names on the page: product names, never translated. */
export const FAMILY_NAMES: Record<UsageFamily, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  codex: "Codex",
  agy: "agy",
  other: "Other",
};

export type DayBar = { day: string; total: number; byFamily: Partial<Record<UsageFamily, number>> };

const parse = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};
const format = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * One bar per calendar day, days without spend included so the time axis stays even: the period's days up to the
 * report's date, or for all time from the first day with spend. At most 366 bars; a longer span keeps its last year.
 */
export function dailySeries(report: UsageReport): DayBar[] {
  const spent = new Map(report.byDay.map((d) => [d.day, d.costUsd]));
  const end = parse(format(new Date(report.generatedAt)));
  const firstSpent = report.byDay[0]?.day;
  let start =
    report.sinceDays !== null
      ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - report.sinceDays + 1)
      : firstSpent
        ? parse(firstSpent)
        : end;
  const earliest = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 365);
  if (start < earliest) start = earliest;
  const out: DayBar[] = [];
  for (let d = start; d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const day = format(d);
    const byFamily = spent.get(day) ?? {};
    out.push({ day, byFamily, total: Object.values(byFamily).reduce((a, b) => a + (b ?? 0), 0) });
  }
  return out;
}
