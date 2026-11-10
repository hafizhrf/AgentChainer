import type { CodexAccountUsage } from "@agentchainer/protocol";
import { type Frame, withAppServer } from "../backends/app-server.ts";
import type { Cli } from "../deploy/cli.ts";
import { log } from "../rpc.ts";

/**
 * The user's Codex account usage (CP-01), from Codex's own app-server: `account/usage/read` (daily tokens across the
 * whole ChatGPT account, every device and app) and `account/rateLimits/read` (the plan's quota windows). No model
 * calls; a short-lived `codex app-server` answers and exits. Only totals and percentages are kept: account ids and
 * credit details are dropped. An API-key login gets nothing from these, and the page says why.
 */
const CACHE_MS = 5 * 60_000;
let cached: { at: number; value: CodexAccountUsage } | null = null;

export async function codexAccountUsage(cli: Cli | null, now = Date.now()): Promise<CodexAccountUsage> {
  if (!cli) return { available: false, reason: "notInstalled" };
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = await read(cli).catch((err: unknown) => {
    log(`usage: codex account usage failed: ${err instanceof Error ? err.message : String(err)}`);
    return { available: false, reason: "failed" } as CodexAccountUsage;
  });
  cached = { at: now, value };
  return value;
}

/** Forgets the cached answer (tests). */
export function clearCodexAccountCache(): void {
  cached = null;
}

async function read(cli: Cli): Promise<CodexAccountUsage> {
  return withAppServer(cli, undefined, async (ask) => {
    const [usage, limits] = await Promise.all([
      ask("account/usage/read", null),
      ask("account/rateLimits/read", { excludeResetCreditDetails: true }),
    ]);
    return parseAccount(usage, limits);
  });
}

/** The two answers as the page shows them; an error (no ChatGPT login) makes the usage unavailable. */
export function parseAccount(usage: Frame, limits: Frame): CodexAccountUsage {
  if (usage.error || !usage.result) {
    const message = usage.error?.message ?? "";
    return { available: false, reason: /chatgpt|auth|login/i.test(message) ? "needsChatgpt" : "failed" };
  }
  const u = usage.result as {
    summary?: { lifetimeTokens?: number | null; peakDailyTokens?: number | null };
    dailyUsageBuckets?: { startDate?: string; tokens?: number }[] | null;
  };
  const l = (limits.result ?? {}) as {
    rateLimitsByLimitId?: Record<string, Snapshot> | null;
    rateLimits?: Snapshot | null;
  };
  const snapshots = Object.values(l.rateLimitsByLimitId ?? {}).length
    ? Object.values(l.rateLimitsByLimitId ?? {})
    : l.rateLimits
      ? [l.rateLimits]
      : [];
  const windows: CodexAccountUsage["limits"] = [];
  let plan: string | null = null;
  for (const s of snapshots) {
    plan ??= typeof s.planType === "string" ? s.planType : null;
    for (const [which, w] of [
      ["primary", s.primary],
      ["secondary", s.secondary],
    ] as const) {
      if (!w || typeof w.usedPercent !== "number") continue;
      windows.push({
        name: s.limitName ?? s.limitId ?? "codex",
        which,
        usedPercent: w.usedPercent,
        windowMins: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
        resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
      });
    }
  }
  return {
    available: true,
    plan,
    lifetimeTokens: u.summary?.lifetimeTokens ?? null,
    daily: (u.dailyUsageBuckets ?? [])
      .filter((b) => typeof b.startDate === "string" && typeof b.tokens === "number")
      .map((b) => ({ day: String(b.startDate).slice(0, 10), tokens: Number(b.tokens) })),
    limits: windows,
  };
}

type Window = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null } | null;
type Snapshot = {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: Window;
  secondary?: Window;
};
