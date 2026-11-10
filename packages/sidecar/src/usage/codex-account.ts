import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexAccountUsage } from "@agentchainer/protocol";
import type { Cli } from "../deploy/cli.ts";
import { log } from "../rpc.ts";

/**
 * The user's Codex account usage (CP-01), from Codex's own app-server: `account/usage/read` (daily tokens across the
 * whole ChatGPT account, every device and app) and `account/rateLimits/read` (the plan's quota windows). No model
 * calls; a short-lived `codex app-server` answers and exits. Only totals and percentages are kept: account ids and
 * credit details are dropped. An API-key login gets nothing from these, and the page says why.
 */
type Frame = { id?: number; result?: unknown; error?: { message?: string } };

const TIMEOUT_MS = 20_000;
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
  const child = spawn(cli.bin, [...cli.prefix, "app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const pending = new Map<number, (f: Frame) => void>();
  let next = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const f = JSON.parse(line) as Frame;
      if (typeof f.id === "number") pending.get(f.id)?.(f);
    } catch {
      // not a frame
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<Frame>((resolve, reject) => {
      const id = next++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS).unref();
    });
  const exited = new Promise<never>((_, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`codex app-server exited (${code})`)));
  });
  try {
    const ask = (method: string, params: unknown) => Promise.race([request(method, params), exited]);
    await ask("initialize", {
      clientInfo: { name: "agentchainer", title: "AgentChainer", version: "0" },
      capabilities: null,
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const [usage, limits] = await Promise.all([
      ask("account/usage/read", null),
      ask("account/rateLimits/read", { excludeResetCreditDetails: true }),
    ]);
    return parseAccount(usage, limits);
  } finally {
    child.kill();
  }
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
