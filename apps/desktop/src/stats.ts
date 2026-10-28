/** Summary of latency samples in ms (spike S2 self-test). Percentiles use the nearest-rank method. */
export function latencyStats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const mean = sorted.length ? sorted.reduce((sum, x) => sum + x, 0) / sorted.length : 0;
  return {
    count: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted.at(-1) ?? 0,
    mean: Math.round(mean * 10) / 10,
  };
}
