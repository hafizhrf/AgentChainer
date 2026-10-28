import type { AgentEvent, Effort, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
import { PERMISSION_MODES } from "@agentchainer/protocol";
import { applyEvent, type Item } from "./transcript.ts";

/**
 * One live session per tab (M1-06/M1-08). Tabs are keyed by the SDK session id, which every notification carries,
 * so events from background tabs land in the right transcript.
 */
export type Tab = {
  sessionId: string;
  cwd: string;
  title: string;
  /** The model the CLI reports (full id), and the alias picked in the UI ("" = default). */
  model?: string;
  modelAlias: string;
  effort: Effort | null;
  /** The session's spend cap (`maxBudgetUsd`), fixed when it started. */
  budgetUsd: number | null;
  claudeCodeVersion?: string;
  /** Slash commands and skills for the composer's `/` palette. */
  slashCommands: string[];
  items: Item[];
  running: boolean;
  /** How the last turn ended (`success`, `error_max_budget_usd`, …); queued messages only go out after a success. */
  lastSubtype: string | null;
  /** The live session is gone (runtime restart, or the CLI exited). The tab stays so it can be resumed. */
  ended: boolean;
  mode: PermissionMode;
  /** Pending tool approvals, oldest first. */
  permissions: PermissionRequest[];
  cost: Cost;
};

type Tokens = { input: number; output: number };

/**
 * Cost estimates (ARCHITECTURE §5.3). The SDK reports running session totals, so a turn's cost and tokens are the
 * difference between two totals. `null` means unknown: a resumed session's first total also includes earlier turns.
 */
export type Cost = {
  totalUsd: number | null;
  lastUsd: number | null;
  lastMs: number;
  totalTokens: Tokens | null;
  lastTokens: Tokens | null;
};

export const asMode = (value: string | null | undefined): PermissionMode =>
  PERMISSION_MODES.find((m) => m === value) ?? "default";

export function newTab(
  sessionId: string,
  cwd: string,
  options: {
    title: string;
    mode: PermissionMode;
    items?: Item[];
    resumed?: boolean;
    modelAlias?: string;
    effort?: Effort | null;
    budgetUsd?: number | null;
  },
): Tab {
  return {
    sessionId,
    cwd,
    title: options.title,
    modelAlias: options.modelAlias ?? "",
    effort: options.effort ?? null,
    budgetUsd: options.budgetUsd ?? null,
    slashCommands: [],
    items: options.items ?? [],
    running: false,
    lastSubtype: null,
    ended: false,
    mode: options.mode,
    permissions: [],
    cost: {
      totalUsd: options.resumed ? null : 0,
      lastUsd: null,
      lastMs: 0,
      totalTokens: options.resumed ? null : { input: 0, output: 0 },
      lastTokens: null,
    },
  };
}

/** Applies one agent event to its tab. `now` is passed for live events (tool timing). */
export function tabEvent(tab: Tab, e: AgentEvent, now?: number): Tab {
  switch (e.type) {
    case "session.started":
      // Arrives at the start of every turn (spike S2), so this must stay idempotent.
      return {
        ...tab,
        model: e.model,
        claudeCodeVersion: e.claudeCodeVersion,
        mode: asMode(e.permissionMode),
        ...(e.slashCommands ? { slashCommands: e.slashCommands } : {}),
      };
    case "turn.completed": {
      const totalTokens = e.usage
        ? {
            input: e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheCreationTokens,
            output: e.usage.outputTokens,
          }
        : null;
      const prev = tab.cost.totalTokens;
      return {
        ...tab,
        running: false,
        lastSubtype: e.subtype,
        items: applyEvent(tab.items, e, now),
        cost: {
          totalUsd: e.totalCostUsd,
          lastUsd: tab.cost.totalUsd === null ? null : Math.max(0, e.totalCostUsd - tab.cost.totalUsd),
          lastMs: e.durationMs,
          totalTokens,
          lastTokens:
            totalTokens && prev
              ? {
                  input: Math.max(0, totalTokens.input - prev.input),
                  output: Math.max(0, totalTokens.output - prev.output),
                }
              : null,
        },
      };
    }
    case "error":
      return { ...tab, running: false, lastSubtype: "error", items: applyEvent(tab.items, e, now) };
    default:
      return { ...tab, items: applyEvent(tab.items, e, now) };
  }
}

export function updateTab(tabs: Tab[], sessionId: string, fn: (tab: Tab) => Tab): Tab[] {
  return tabs.map((t) => (t.sessionId === sessionId ? fn(t) : t));
}

/** "my-app" for "/Users/me/projects/my-app". */
export function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;
}

/** The budget warning (M1-32): at 80% of the cap, for sessions whose whole spend is known. */
export function budgetWarning(tab: Tab): string | null {
  if (tab.budgetUsd === null || tab.cost.totalUsd === null) return null;
  if (tab.lastSubtype === "error_max_budget_usd") {
    return `Budget cap of $${tab.budgetUsd.toFixed(2)} reached. Raise it in Settings and resume the session to continue.`;
  }
  const share = tab.cost.totalUsd / tab.budgetUsd;
  return share >= 0.8
    ? `About ${Math.round(share * 100)}% of this session's $${tab.budgetUsd.toFixed(2)} budget is used (estimate).`
    : null;
}
