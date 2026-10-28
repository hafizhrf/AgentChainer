import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latencyStats } from "./stats.ts";

describe("latencyStats", () => {
  it("computes nearest-rank percentiles", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    assert.deepEqual(latencyStats(samples), { count: 100, p50: 50, p95: 95, max: 100, mean: 50.5 });
  });

  it("handles a single sample and an empty run", () => {
    assert.deepEqual(latencyStats([7]), { count: 1, p50: 7, p95: 7, max: 7, mean: 7 });
    assert.deepEqual(latencyStats([]), { count: 0, p50: 0, p95: 0, max: 0, mean: 0 });
  });
});
