import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UsageReport } from "@agentchainer/protocol";
import { dailySeries } from "./usage.ts";

const report = (sinceDays: number | null, byDay: UsageReport["byDay"]): UsageReport =>
  ({ generatedAt: new Date(2026, 10, 10, 12).toISOString(), sinceDays, byDay }) as unknown as UsageReport;

describe("the usage chart's days (CP-01)", () => {
  it("has a bar for every day of the period, empty days included", () => {
    const bars = dailySeries(report(7, [{ day: "2026-11-08", costUsd: { opus: 1.5, haiku: 0.25 } }]));
    assert.deepEqual(
      bars.map((b) => b.day),
      ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"],
    );
    assert.equal(bars[4]?.total, 1.75);
    assert.equal(bars[0]?.total, 0);
  });

  it("starts all time at the first day with spend, and keeps at most a year", () => {
    assert.equal(dailySeries(report(null, [{ day: "2026-11-01", costUsd: { codex: 1 } }]))[0]?.day, "2026-11-01");
    const long = dailySeries(report(null, [{ day: "2024-01-01", costUsd: { opus: 1 } }]));
    assert.equal(long.length, 366);
    assert.equal(long.at(-1)?.day, "2026-11-10");
  });
});
