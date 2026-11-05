import type { FleetItem } from "@agentchainer/protocol";
import { hours, minutes, seconds } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";

/** The fleet view's pure parts (M8-02): ordering and time labels. */

/** The workspace a session works for: a task step runs in `<workspace>/.agentchainer/worktrees/<task>`. */
export function workspaceOf(dir: string): string {
  return dir.replace(/[\\/]\.agentchainer[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/, "");
}

/** How long ago `iso` was, short: "12 s", "4 min", "2 h". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return seconds(s);
  if (s < 3600) return minutes(Math.floor(s / 60));
  return hours(Math.floor(s / 3600));
}

export const FLEET_STATUS: Record<FleetItem["status"], { label: string; order: number }> = {
  waiting: {
    get label() {
      return t("graph.fleet.statusWaiting");
    },
    order: 0,
  },
  working: {
    get label() {
      return t("graph.fleet.statusWorking");
    },
    order: 1,
  },
  idle: {
    get label() {
      return t("graph.fleet.statusIdle");
    },
    order: 2,
  },
  ended: {
    get label() {
      return t("graph.fleet.statusEnded");
    },
    order: 3,
  },
};

/** The fleet's rows by workspace, the ones needing the person first, then working, idle and ended. */
export function fleetGroups(items: FleetItem[]): { cwd: string; items: FleetItem[] }[] {
  const by = new Map<string, FleetItem[]>();
  for (const i of items) {
    const ws = workspaceOf(i.cwd);
    by.set(ws, [...(by.get(ws) ?? []), i]);
  }
  const rank = (list: FleetItem[]) => Math.min(...list.map((i) => FLEET_STATUS[i.status].order));
  return [...by]
    .map(([cwd, list]) => ({
      cwd,
      items: list.sort(
        (a, b) => FLEET_STATUS[a.status].order - FLEET_STATUS[b.status].order || b.since.localeCompare(a.since),
      ),
    }))
    .sort((a, b) => rank(a.items) - rank(b.items) || a.cwd.localeCompare(b.cwd));
}
