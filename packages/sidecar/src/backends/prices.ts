/**
 * API prices of the models Codex and the Antigravity CLI run (M9-07, ADR-0012 §4), to estimate what a step on them
 * cost. Those CLIs report tokens, not dollars; on a subscription login there's no bill per token at all, so the
 * estimate is what the same tokens would cost on the provider's API. That's the same kind of number the Claude Agent
 * SDK reports for a Claude subscription, so the three add up, and the task's budget can stop a step that runs away.
 *
 * Re-check them when the CLIs are re-pinned. A model that isn't here gets no estimate: the step shows its tokens and
 * says its cost is unknown, rather than guess. Checked 2026-11-10.
 */

/** US dollars per million tokens. `cachedInput` missing: cached tokens cost as much as other input (an upper bound). */
export type Price = { input: number; cachedInput?: number; output: number };

type Entry = {
  /** Matches a model id that is this or starts with it and a `-` (agy's `gemini-3.8-flash-low`). */
  model: string;
  /** Newest first: each applies from its date (UTC, inclusive) until the next newer one starts. */
  prices: (Price & { from?: string })[];
  source: string;
};

export const PRICES: readonly Entry[] = [
  // OpenAI's pricing page refused automated reads; these are from the release notes and price trackers (verify).
  {
    model: "gpt-6-luna",
    prices: [{ input: 0.1, cachedInput: 0.01, output: 0.5 }],
    source: "https://felo.ai/tools/gpt-6-luna (verify against https://openai.com/api/pricing/)",
  },
  {
    model: "gpt-5.6-terra",
    prices: [{ input: 2, output: 12 }],
    source: "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/ (verify)",
  },
  {
    model: "gpt-5.6-luna",
    prices: [{ input: 0.2, output: 1.2 }],
    source: "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/ (verify)",
  },
  {
    model: "gemini-3.8-flash",
    prices: [
      { from: "2027-01-01", input: 1.5, cachedInput: 0.15, output: 7.5 },
      { input: 0.75, cachedInput: 0.075, output: 3.75 },
    ],
    source: "https://aistudio.google.com/docs/pricing",
  },
  // Claude models agy offers, at Anthropic's API prices (verify).
  {
    model: "claude-opus-4-6",
    prices: [{ input: 5, cachedInput: 0.5, output: 25 }],
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing (verify)",
  },
  {
    model: "claude-sonnet-4-6",
    prices: [{ input: 3, cachedInput: 0.3, output: 15 }],
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing (verify)",
  },
];

/** Tokens as Codex and agy count them: `input` includes the `cached` ones; `output` includes reasoning. */
export type Tokens = { input: number; cached: number; output: number };

/** The price of `model` on `at`, or null when the table doesn't have it. */
export function priceOf(model: string, at = new Date()): Price | null {
  const entry = PRICES.filter((e) => model === e.model || model.startsWith(`${e.model}-`)).sort(
    (a, b) => b.model.length - a.model.length,
  )[0];
  if (!entry) return null;
  const day = at.toISOString().slice(0, 10);
  return entry.prices.find((p) => !p.from || p.from <= day) ?? null;
}

/** What `tokens` would cost on the API, in dollars, or null for a model with no price. */
export function estimateUsd(model: string, tokens: Tokens, at = new Date()): number | null {
  const p = priceOf(model, at);
  if (!p) return null;
  const cached = Math.min(tokens.cached, tokens.input);
  const usd = (tokens.input - cached) * p.input + cached * (p.cachedInput ?? p.input) + tokens.output * p.output;
  return usd / 1_000_000;
}
