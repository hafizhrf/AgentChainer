import { t } from "./i18n/index.ts";
import type { Tab } from "./tabs.ts";

/**
 * A Team chat (M8-03, docs/design/supervisor.md): its tools, as the transcript names them, and its workers' place in
 * the sidebar.
 */

/** The cap a Team chat starts with when Settings sets none: it covers the supervisor and its workers together. */
export const TEAM_CAP_USD = 2;

const PREFIX = "mcp__agentchainer__";

/** A Team tool's readable name; one the app doesn't know yet keeps its own. */
function label(tool: string): string {
  switch (tool) {
    case "assign":
      return t("graph.team.assign");
    case "handoff":
      return t("graph.team.handoff");
    case "send_message":
      return t("graph.team.sendMessage");
    case "read_inbox":
      return t("graph.team.readInbox");
    case "list_workers":
      return t("graph.team.listWorkers");
    case "close_worker":
      return t("graph.team.closeWorker");
    default:
      return tool;
  }
}

/** A Team tool's call as a row: a readable name, and the worker it's about. Null for every other tool. */
export function teamTool(name: string, input: unknown): { label: string; detail: string; access?: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const tool = name.slice(PREFIX.length);
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const who = str(o.name) || str(o.worker);
  const what = str(o.prompt) || str(o.text);
  const detail = [who, what.length > 70 ? `${what.slice(0, 70)}…` : what].filter(Boolean).join(": ");
  const access = tool === "assign" || tool === "handoff" ? str(o.access) || "read" : "";
  return { label: label(tool), detail, ...(access ? { access } : {}) };
}

/** The sidebar's order: each supervisor followed by its workers; a worker whose supervisor's tab is gone stands alone. */
export function nestedTabs(tabs: Tab[]): { tab: Tab; child: boolean }[] {
  const ids = new Set(tabs.map((tab) => tab.sessionId));
  const out: { tab: Tab; child: boolean }[] = [];
  for (const tab of tabs) {
    if (tab.parentId && ids.has(tab.parentId)) continue;
    out.push({ tab, child: false });
    for (const c of tabs) if (c.parentId === tab.sessionId) out.push({ tab: c, child: true });
  }
  return out;
}

/** "$1,234.50": a Team's spend and cap. */
export const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$0.42", "$2", "$1.5K", "$10M": a Team's spend and cap where space is short. */
export function usdShort(n: number): string {
  const trim = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ""));
  if (n >= 1_000_000) return `$${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `$${trim(n / 1_000)}K`;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** "Team · $0.42 of $2.00", or that the cap stopped it. */
export function teamSpend(team: NonNullable<Tab["team"]>): string {
  return team.stopped
    ? t("graph.team.stopped", { cap: usd(team.capUsd) })
    : t("graph.team.spend", { spent: usd(team.spentUsd), cap: usd(team.capUsd) });
}
