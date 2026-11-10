import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateUsd, PRICES, priceOf } from "./prices.ts";

describe("estimated costs of steps on Codex and agy (M9-07)", () => {
  it("prices a model by its id, or by the longest id it extends (agy's effort suffixes)", () => {
    assert.equal(priceOf("gpt-6-luna")?.input, 0.1);
    assert.equal(priceOf("gemini-3.8-flash-low", new Date("2026-11-10"))?.output, 3.75);
    assert.equal(priceOf("claude-opus-4-6-thinking")?.output, 25);
    assert.equal(priceOf("gpt-6-lunar"), null);
    assert.equal(priceOf("gpt-oss-120b-medium"), null);
  });

  it("follows a dated price change", () => {
    assert.equal(priceOf("gemini-3.8-flash-high", new Date("2026-12-31T23:00:00Z"))?.input, 0.75);
    assert.equal(priceOf("gemini-3.8-flash-high", new Date("2027-01-01T00:00:00Z"))?.input, 1.5);
  });

  it("charges cached input at its own rate, or as input when the table has none", () => {
    // gpt-6-luna: 9,000 uncached × $0.10 + 1,000 cached × $0.01 + 500 out × $0.50, per million.
    const luna = estimateUsd("gpt-6-luna", { input: 10_000, cached: 1_000, output: 500 }) ?? 0;
    assert.ok(Math.abs(luna - (900 + 10 + 250) / 1_000_000) < 1e-12);
    const terra = estimateUsd("gpt-5.6-terra", { input: 1_000, cached: 1_000, output: 0 }) ?? 0;
    assert.ok(Math.abs(terra - 2_000 / 1_000_000) < 1e-12);
    assert.equal(estimateUsd("unpriced-model", { input: 1, cached: 0, output: 1 }), null);
  });

  it("says where every price came from", () => {
    for (const e of PRICES) {
      assert.match(e.source, /^https:\/\//, e.model);
      assert.ok(e.prices.length > 0 && e.prices.every((p, i) => i === e.prices.length - 1 || p.from), e.model);
    }
  });
});
