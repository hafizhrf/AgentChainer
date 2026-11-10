/**
 * Claude's API prices, to estimate what a stored session cost (CP-01). A session's history (the SDK's
 * `getSessionMessages`) keeps each response's model and tokens but no dollars, so the usage page prices the tokens,
 * the way task steps on Codex and agy are priced (backends/prices.ts). For a subscription login that's what the same
 * tokens would cost on the API, the same kind of number the Agent SDK reports while a session runs.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-10. Cache reads are 0.025x input on
 * Fable/Mythos 5.1 and 5.2, 0.05x on Opus 5.5 and Sonnet 5.5, 0.1x elsewhere; 5-minute cache writes are 1.25x and
 * one-hour ones 2x. Haiku 5.5 costs more for a request whose prompt is over 100,000 tokens.
 */

/** US dollars per million tokens. */
export type ClaudePrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

const price = (input: number, output: number, read: number): ClaudePrice => ({
  input,
  output,
  cacheRead: read,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
});

/** By model id prefix: an id is priced by the longest entry it equals or extends with a `-` (`claude-opus-4-5-20251101`). */
const PRICES: Record<string, ClaudePrice> = {
  "claude-fable-5-2": price(8, 40, 0.2),
  "claude-mythos-5-2": price(8, 40, 0.2),
  "claude-fable-5-1": price(10, 50, 0.25),
  "claude-mythos-5-1": price(10, 50, 0.25),
  "claude-fable-5": price(10, 50, 1),
  "claude-mythos-5": price(10, 50, 1),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-opus-4-8": price(5, 25, 0.5),
  "claude-opus-4-7": price(5, 25, 0.5),
  "claude-opus-4-6": price(5, 25, 0.5),
  "claude-opus-4-5": price(5, 25, 0.5),
  "claude-opus-4-1": price(15, 75, 1.5),
  "claude-opus-4": price(15, 75, 1.5),
  "claude-sonnet-5-5": price(2, 10, 0.1),
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-sonnet-4-6": price(3, 15, 0.3),
  "claude-sonnet-4-5": price(3, 15, 0.3),
  "claude-sonnet-4": price(3, 15, 0.3),
  "claude-haiku-5-5": price(0.1, 0.5, 0.01),
  "claude-haiku-4-5": price(1, 5, 0.1),
};

/** Haiku 5.5 above this prompt size, per request (input, cache reads and cache writes together). */
const HAIKU_55_LONG = { over: 100_000, price: price(0.5, 2.5, 0.05) };

/** One response's tokens, as the API reports them: `input` excludes cache reads and writes. */
export type ClaudeTokens = {
  input: number;
  output: number;
  cacheRead: number;
  /** All cache writes; `cacheWrite1h` is the part written to the one-hour cache, when the response says. */
  cacheWrite: number;
  cacheWrite1h?: number;
};

export function claudePriceOf(model: string): ClaudePrice | null {
  const key = Object.keys(PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`) || model.startsWith(`${k}[`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? (PRICES[key] ?? null) : null;
}

/** What one response would cost on the API, in dollars; null for a model with no price. */
export function claudeCostUsd(model: string, t: ClaudeTokens): number | null {
  let p = claudePriceOf(model);
  if (!p) return null;
  if (p === PRICES["claude-haiku-5-5"] && t.input + t.cacheRead + t.cacheWrite > HAIKU_55_LONG.over) {
    p = HAIKU_55_LONG.price;
  }
  const hour = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  const usd =
    t.input * p.input +
    t.output * p.output +
    t.cacheRead * p.cacheRead +
    (t.cacheWrite - hour) * p.cacheWrite5m +
    hour * p.cacheWrite1h;
  return usd / 1_000_000;
}
