import type { AgentEvent, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
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
  model?: string;
  claudeCodeVersion?: string;
  items: Item[];
  running: boolean;
  /** The live session is gone (runtime restart, or the CLI exited). The tab stays so it can be resumed. */
  ended: boolean;
  mode: PermissionMode;
  /** Pending tool approvals, oldest first. */
  permissions: PermissionRequest[];
  cost: Cost;
};

/**
 * Cost estimates (ARCHITECTURE §5.3). The SDK reports a running session total, so a turn's cost is the difference
 * between two totals. `null` means unknown: a resumed session's first total also includes turns from before.
 */
export type Cost = { totalUsd: number | null; lastUsd: number | null; lastMs: number };

export const asMode = (value: string | null | undefined): PermissionMode =>
  PERMISSION_MODES.find((m) => m === value) ?? "default";

export function newTab(
  sessionId: string,
  cwd: string,
  options: { title: string; mode: PermissionMode; items?: Item[]; resumed?: boolean },
): Tab {
  return {
    sessionId,
    cwd,
    title: options.title,
    items: options.items ?? [],
    running: false,
    ended: false,
    mode: options.mode,
    permissions: [],
    cost: { totalUsd: options.resumed ? null : 0, lastUsd: null, lastMs: 0 },
  };
}

/** Applies one agent event to its tab. */
export function tabEvent(tab: Tab, e: AgentEvent): Tab {
  switch (e.type) {
    case "session.started":
      // Arrives at the start of every turn (spike S2), so this must stay idempotent.
      return { ...tab, model: e.model, claudeCodeVersion: e.claudeCodeVersion, mode: asMode(e.permissionMode) };
    case "turn.completed":
      return {
        ...tab,
        running: false,
        items: applyEvent(tab.items, e),
        cost: {
          totalUsd: e.totalCostUsd,
          lastUsd: tab.cost.totalUsd === null ? null : Math.max(0, e.totalCostUsd - tab.cost.totalUsd),
          lastMs: e.durationMs,
        },
      };
    case "error":
      return { ...tab, running: false, items: applyEvent(tab.items, e) };
    default:
      return { ...tab, items: applyEvent(tab.items, e) };
  }
}

export function updateTab(tabs: Tab[], sessionId: string, fn: (tab: Tab) => Tab): Tab[] {
  return tabs.map((t) => (t.sessionId === sessionId ? fn(t) : t));
}

/** "my-app" for "/Users/me/projects/my-app". */
export function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;
}
