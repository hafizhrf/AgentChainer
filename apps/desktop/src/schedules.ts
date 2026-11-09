import { type Cadence, nextRun, type Schedule, type Task } from "@agentchainer/protocol";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { approxUsd } from "./i18n/format.ts";
import { currentLocale, t } from "./i18n/index.ts";
import { localized } from "./i18n/shown.ts";

/**
 * Scheduled flows in the UI (M8-05, docs/design/scheduled-flows.md): what the person is told about scheduled runs, as
 * OS notifications, since nobody may be watching the app when one runs.
 */

/** Asked once, when the first schedule is saved; a refusal only means no OS notifications. */
export async function askToNotify(): Promise<void> {
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // Not in the app (a browser preview), or the OS has no notifications: the in-app state still shows everything.
  }
}

export async function notify(title: string, body: string): Promise<void> {
  try {
    if (await isPermissionGranted()) sendNotification({ title, body });
  } catch {
    // As above.
  }
}

/** How a run ended, in words; another state is named as it is. */
function ended(state: Task["state"]): string {
  switch (state) {
    case "done":
      return t("graph.schedules.done");
    case "failed":
      return t("graph.schedules.failed");
    case "unverified":
      return t("graph.schedules.unverified");
    case "cancelled":
      return t("graph.schedules.cancelled");
    case "accepted":
      return t("graph.schedules.accepted");
    default:
      return state;
  }
}

/** What to tell the person when a scheduled run ends: from `before` (the last state seen) to `task`. */
export function scheduledRunEnded(
  before: Task["state"] | undefined,
  task: Task,
): { title: string; body: string } | null {
  if (task.run?.trigger !== "schedule" || before !== "running" || task.state === "running") return null;
  const name = task.title ?? task.request;
  const cost = approxUsd(task.run.costUsd, 2);
  return {
    title: t("graph.schedules.runEnded", { how: ended(task.state) }),
    body: task.run.outcome
      ? t("graph.schedules.endedBodyOutcome", {
          name: name.slice(0, 80),
          outcome: localized(task.run.outcome, task.run.outcomeRef),
          cost,
        })
      : t("graph.schedules.endedBody", { name: name.slice(0, 80), cost }),
  };
}

/** A schedule's last run in words: "Started 02:00, late", "Skipped: the task was still running". */
export function lastRunText(s: Schedule, now = new Date()): string {
  const r = s.lastRun;
  if (!r) return t("graph.schedules.notRunYet");
  const when = whenText(new Date(r.at), now);
  if (r.state === "started")
    return r.late ? t("graph.schedules.ranLate", { when }) : t("graph.schedules.ran", { when });
  if (r.state === "skipped") return t("graph.schedules.skipped", { when });
  return t("graph.schedules.couldNotRun", { when, reason: r.reason ?? t("graph.schedules.unknownReason") });
}

/** "today 02:00", "tomorrow 02:00", "Fri 02:00", or a date further out. */
export function whenText(at: Date, now = new Date()): string {
  // Words and the time's separator follow the UI's language: "Fri 02:00", "Jum 02.00".
  const locale = currentLocale();
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff === 0) return t("graph.schedules.today", { time });
  if (diff === 1) return t("graph.schedules.tomorrow", { time });
  if (diff === -1) return t("graph.schedules.yesterday", { time });
  if (diff > 1 && diff < 7)
    return t("graph.schedules.dayTime", { day: at.toLocaleDateString(locale, { weekday: "short" }), time });
  return t("graph.schedules.dayTime", {
    day: at.toLocaleDateString(locale, { month: "short", day: "numeric" }),
    time,
  });
}

/** The next `n` times of a cadence after now, for the preview. */
export function nextTimes(cadence: Cadence, n: number, now = new Date()): Date[] {
  const out: Date[] = [];
  let at = now;
  for (let i = 0; i < n; i++) {
    at = nextRun(cadence, at);
    out.push(at);
  }
  return out;
}
