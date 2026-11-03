import { type Cadence, nextRun, type Schedule, type Task } from "@agentchainer/protocol";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

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

const ENDED: Partial<Record<Task["state"], string>> = {
  done: "done",
  failed: "failed",
  unverified: "ended unverified",
  cancelled: "was stopped",
  accepted: "done, risk accepted",
};

/** What to tell the person when a scheduled run ends: from `before` (the last state seen) to `task`. */
export function scheduledRunEnded(
  before: Task["state"] | undefined,
  task: Task,
): { title: string; body: string } | null {
  if (task.run?.trigger !== "schedule" || before !== "running" || task.state === "running") return null;
  const how = ENDED[task.state] ?? task.state;
  const name = task.title ?? task.request;
  return {
    title: `Scheduled run ${how}`,
    body: `${name.slice(0, 80)}${task.run.outcome ? `: ${task.run.outcome}` : ""} (≈$${task.run.costUsd.toFixed(2)})`,
  };
}

/** A schedule's last run in words: "Started 02:00, late", "Skipped: the task was still running". */
export function lastRunText(s: Schedule, now = new Date()): string {
  const r = s.lastRun;
  if (!r) return "Hasn't run yet";
  const when = whenText(new Date(r.at), now);
  if (r.state === "started") return `Ran ${when}${r.late ? ", late" : ""}`;
  if (r.state === "skipped") return `Skipped ${when}: the task was still running`;
  return `Couldn't run ${when}: ${r.reason ?? "unknown reason"}`;
}

/** "today 02:00", "tomorrow 02:00", "Fri 02:00", or a date further out. */
export function whenText(t: Date, now = new Date()): string {
  const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(t) - day(now)) / 86_400_000);
  if (diff === 0) return `today ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  if (diff === -1) return `yesterday ${time}`;
  if (diff > 1 && diff < 7) return `${t.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return `${t.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

/** The next `n` times of a cadence after now, for the preview. */
export function nextTimes(cadence: Cadence, n: number, now = new Date()): Date[] {
  const out: Date[] = [];
  let t = now;
  for (let i = 0; i < n; i++) {
    t = nextRun(cadence, t);
    out.push(t);
  }
  return out;
}
