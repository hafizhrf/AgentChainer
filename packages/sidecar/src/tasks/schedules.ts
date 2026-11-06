import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Cadence, nextRun, type Schedule, ScheduleSchema } from "@agentchainer/protocol";
import { z } from "zod";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";

/** Shared with the UI, which previews the next run times. */
export { cadenceText, nextRun } from "@agentchainer/protocol";

/**
 * Scheduled flows (M8-05, docs/design/scheduled-flows.md): an approved task run again on a cadence, while the app is
 * open. Schedules live with their workspace in `.agentchainer/schedules.json` (git ignores it); the sidecar checks
 * the watched workspaces' schedules once a minute, which also catches up after sleep or a closed app: a time already
 * past runs once, then the next one is after now.
 */

const FILE = "schedules.json";
/** More behind than this, a run counts as late. */
export const LATE_MS = 2 * 60_000;
export const CHECK_MS = 60_000;

const FileSchema = z.object({ schedules: z.array(ScheduleSchema.omit({ cwd: true })) });

export function loadSchedules(root: string): Schedule[] {
  const file = path.join(root, AC_DIR, FILE);
  if (!existsSync(file)) return [];
  try {
    return FileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).schedules.map((s) => ({ ...s, cwd: root }));
  } catch {
    // A file the app can't read runs nothing; saving writes a good one again.
    return [];
  }
}

function writeSchedules(root: string, schedules: Schedule[]): void {
  ensureIgnored(root, FILE);
  const dir = path.join(root, AC_DIR);
  mkdirSync(dir, { recursive: true });
  const body = { schedules: schedules.map(({ cwd: _cwd, ...s }) => s) };
  const file = path.join(dir, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(temp, file);
}

/** What the Scheduler needs of the app: starting a task's run, and telling the UI. */
/**
 * Thrown by a host when the task's last run is still going: the scheduled run is skipped, not failed. A type, not the
 * message's words, which follow the app's language (X-13).
 */
export class AlreadyRunning extends Error {}

export type SchedulerHost = {
  /**
   * Starts the task's run as a scheduled one; throws with a reason when it can't (not approved, XL, already running).
   * `check` only says whether it could, without starting it.
   */
  start(cwd: string, taskId: string, check?: boolean): void;
  /** The task's title, for lists; throws when there's no such task. */
  title(cwd: string, taskId: string): string;
  changed(schedule: Schedule): void;
  deleted(cwd: string, id: string): void;
  now?: () => Date;
};

export class Scheduler {
  private readonly host: SchedulerHost;
  private readonly watched = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(host: SchedulerHost) {
    this.host = host;
  }

  private now(): Date {
    return this.host.now?.() ?? new Date();
  }

  /** Arms these workspaces' schedules (replacing the last list), runs any that are due, and starts the checks. */
  watch(cwds: string[]): Schedule[] {
    this.watched.clear();
    for (const c of cwds) if (existsSync(c)) this.watched.add(c);
    this.tick();
    this.timer ??= setInterval(() => this.tick(), CHECK_MS);
    this.timer.unref?.();
    return this.list();
  }

  list(cwd?: string): Schedule[] {
    const roots = cwd ? [cwd] : [...this.watched];
    return roots.flatMap((r) => loadSchedules(r));
  }

  /** Creates or edits a schedule; the task must be one a schedule can run now. Its next time starts from now. */
  save(cwd: string, input: { id?: string; taskId: string; cadence: Cadence; enabled: boolean }): Schedule {
    const all = loadSchedules(cwd);
    const title = this.host.title(cwd, input.taskId);
    // Refused here rather than at its time: an XL task, a draft, a task with no approved contract.
    this.host.start(cwd, input.taskId, true);
    const old = input.id ? all.find((s) => s.id === input.id) : undefined;
    if (input.id && !old) throw new Error(`There is no schedule ${input.id}.`);
    const schedule: Schedule = {
      id: old?.id ?? randomUUID().slice(0, 8),
      cwd,
      taskId: input.taskId,
      title,
      cadence: input.cadence,
      enabled: input.enabled,
      createdAt: old?.createdAt ?? this.now().toISOString(),
      nextAt: nextRun(input.cadence, this.now()).toISOString(),
      ...(old?.lastRun ? { lastRun: old.lastRun } : {}),
    };
    writeSchedules(cwd, [...all.filter((s) => s.id !== schedule.id), schedule]);
    this.watched.add(cwd);
    this.host.changed(schedule);
    return schedule;
  }

  delete(cwd: string, id: string): void {
    const all = loadSchedules(cwd);
    if (!all.some((s) => s.id === id)) throw new Error(`There is no schedule ${id}.`);
    writeSchedules(
      cwd,
      all.filter((s) => s.id !== id),
    );
    this.host.deleted(cwd, id);
  }

  /** Runs it now; its next time stays as it was. */
  runNow(cwd: string, id: string): Schedule {
    const s = loadSchedules(cwd).find((x) => x.id === id);
    if (!s) throw new Error(`There is no schedule ${id}.`);
    return this.fire(s, false, s.nextAt);
  }

  /** Every watched schedule that's enabled and due runs once; its next time is then after now. */
  tick(): void {
    const now = this.now();
    for (const root of this.watched) {
      for (const s of loadSchedules(root)) {
        if (!s.enabled || new Date(s.nextAt) > now) continue;
        const late = now.getTime() - new Date(s.nextAt).getTime() > LATE_MS;
        this.fire(s, late, nextRun(s.cadence, now).toISOString());
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private fire(s: Schedule, late: boolean, nextAt: string): Schedule {
    const at = this.now().toISOString();
    let lastRun: Schedule["lastRun"];
    try {
      this.host.start(s.cwd, s.taskId);
      lastRun = { at, state: "started", late };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      lastRun = { at, state: err instanceof AlreadyRunning ? "skipped" : "failed-to-start", late, reason };
    }
    const next: Schedule = { ...s, nextAt, lastRun };
    const all = loadSchedules(s.cwd);
    writeSchedules(
      s.cwd,
      all.map((x) => (x.id === s.id ? next : x)),
    );
    this.host.changed(next);
    return next;
  }
}
