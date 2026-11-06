import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { Schedule } from "@agentchainer/protocol";
import { AlreadyRunning, cadenceText, LATE_MS, loadSchedules, nextRun, Scheduler } from "./schedules.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ac-schedules-"));
  dirs.push(d);
  return d;
};

/** A local time, as the person sees it. */
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
const hhmm = (t: Date) =>
  `${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;

describe("schedule times (M8-05)", () => {
  it("runs every N hours on the hour, counted from midnight", () => {
    assert.equal(hhmm(nextRun({ kind: "hourly", every: 1 }, local(2026, 11, 3, 9, 15))), "3 10:00");
    assert.equal(hhmm(nextRun({ kind: "hourly", every: 6 }, local(2026, 11, 3, 9, 15))), "3 12:00");
    assert.equal(hhmm(nextRun({ kind: "hourly", every: 6 }, local(2026, 11, 3, 18, 0))), "4 00:00");
  });

  it("runs daily at its time: today if it's still ahead, otherwise tomorrow", () => {
    assert.equal(hhmm(nextRun({ kind: "daily", at: "02:30" }, local(2026, 11, 3, 1, 0))), "3 02:30");
    assert.equal(hhmm(nextRun({ kind: "daily", at: "02:30" }, local(2026, 11, 3, 2, 30))), "4 02:30");
    assert.equal(hhmm(nextRun({ kind: "daily", at: "23:59" }, local(2026, 12, 31, 23, 59))).startsWith("1 "), true);
  });

  it("runs weekly on its days, wrapping into next week", () => {
    // 2026-11-03 is a Tuesday.
    const mon = nextRun({ kind: "weekly", days: [1], at: "09:00" }, local(2026, 11, 3, 10, 0));
    assert.deepEqual([mon.getDay(), mon.getDate()], [1, 9]);
    const later = nextRun({ kind: "weekly", days: [2, 5], at: "09:00" }, local(2026, 11, 3, 10, 0));
    assert.deepEqual([later.getDay(), later.getDate()], [5, 6]);
  });

  it("says the cadence in words", () => {
    assert.equal(cadenceText({ kind: "hourly", every: 1 }), "Every hour");
    assert.equal(cadenceText({ kind: "hourly", every: 6 }), "Every 6 hours");
    assert.equal(cadenceText({ kind: "daily", at: "02:00" }), "Daily at 02:00");
    assert.equal(cadenceText({ kind: "weekly", days: [0, 3, 1], at: "09:30" }), "Mon, Wed, Sun at 09:30");
  });
});

/** A scheduler on a fake clock, whose host records what it starts and refuses what the test says. */
function setup(start = local(2026, 11, 3, 1, 0)) {
  let now = start;
  const started: string[] = [];
  const changed: Schedule[] = [];
  const refuse = new Map<string, string | Error>();
  const s = new Scheduler({
    start: (_cwd, taskId, check) => {
      const reason = refuse.get(taskId);
      if (reason) throw typeof reason === "string" ? new Error(reason) : reason;
      if (!check) started.push(taskId);
    },
    title: (_cwd, taskId) => `Task ${taskId}`,
    changed: (x) => void changed.push(x),
    deleted: () => undefined,
    now: () => now,
  });
  return {
    s,
    started,
    changed,
    refuse,
    at: (t: Date) => {
      now = t;
    },
  };
}

const TASK = "2026-11-03-0000aaaa";

describe("the scheduler (M8-05)", () => {
  it("saves a schedule with its next time, runs it when due, then sets the next one", () => {
    const root = tmp();
    const { s, started, at } = setup(local(2026, 11, 3, 1, 0));
    const saved = s.save(root, { taskId: TASK, cadence: { kind: "daily", at: "02:00" }, enabled: true });
    assert.equal(hhmm(new Date(saved.nextAt)), "3 02:00");
    assert.equal(saved.title, `Task ${TASK}`);
    assert.match(readFileSync(path.join(root, ".agentchainer", ".gitignore"), "utf8"), /schedules\.json/);
    s.tick();
    assert.deepEqual(started, [], "not due yet");
    at(local(2026, 11, 3, 2, 0));
    s.tick();
    assert.deepEqual(started, [TASK]);
    const [after] = loadSchedules(root);
    assert.equal(hhmm(new Date(after?.nextAt ?? "")), "4 02:00");
    assert.deepEqual(after?.lastRun?.state, "started");
    assert.equal(after?.lastRun?.late, false);
    s.stop();
  });

  it("runs a time missed while the app was closed once, marked late", () => {
    const root = tmp();
    const { s, started, at } = setup(local(2026, 11, 3, 1, 0));
    s.save(root, { taskId: TASK, cadence: { kind: "hourly", every: 1 }, enabled: true });
    // Closed for five hours: five run times passed, one run happens.
    at(local(2026, 11, 3, 6, 30));
    s.watch([root]);
    s.tick();
    assert.deepEqual(started, [TASK]);
    const [x] = loadSchedules(root);
    assert.equal(x?.lastRun?.late, true);
    assert.equal(hhmm(new Date(x?.nextAt ?? "")), "3 07:00");
    s.stop();
  });

  it("isn't late within a couple of minutes of its time", () => {
    const root = tmp();
    const { s, at } = setup(local(2026, 11, 3, 1, 0));
    s.save(root, { taskId: TASK, cadence: { kind: "daily", at: "02:00" }, enabled: true });
    at(new Date(local(2026, 11, 3, 2, 0).getTime() + LATE_MS - 1000));
    s.tick();
    assert.equal(loadSchedules(root)[0]?.lastRun?.late, false);
    s.stop();
  });

  it("skips a run while the task still runs, and records why a run couldn't start", () => {
    const root = tmp();
    const { s, started, refuse, at } = setup(local(2026, 11, 3, 1, 0));
    s.save(root, { taskId: TASK, cadence: { kind: "hourly", every: 1 }, enabled: true });
    refuse.set(TASK, new AlreadyRunning("The task is already running."));
    at(local(2026, 11, 3, 2, 0));
    s.tick();
    assert.deepEqual(loadSchedules(root)[0]?.lastRun?.state, "skipped");
    refuse.set(TASK, "Its last run was interrupted: resume or stop it first.");
    at(local(2026, 11, 3, 3, 0));
    s.tick();
    const [x] = loadSchedules(root);
    assert.deepEqual(
      [x?.lastRun?.state, x?.lastRun?.reason],
      ["failed-to-start", "Its last run was interrupted: resume or stop it first."],
    );
    assert.deepEqual(started, []);
    s.stop();
  });

  it("leaves a disabled schedule alone, and runs one now without moving its next time", () => {
    const root = tmp();
    const { s, started, at } = setup(local(2026, 11, 3, 1, 0));
    const x = s.save(root, { taskId: TASK, cadence: { kind: "daily", at: "02:00" }, enabled: false });
    at(local(2026, 11, 3, 5, 0));
    s.tick();
    assert.deepEqual(started, []);
    const ran = s.runNow(root, x.id);
    assert.deepEqual(started, [TASK]);
    assert.equal(ran.nextAt, x.nextAt);
    s.stop();
  });

  it("refuses a task a schedule can't run, and writes nothing", () => {
    const root = tmp();
    const { s, refuse } = setup();
    refuse.set(TASK, "An XL task can't be scheduled: each run's split needs your approval.");
    assert.throws(() => s.save(root, { taskId: TASK, cadence: { kind: "daily", at: "02:00" }, enabled: true }), /XL/);
    assert.equal(existsSync(path.join(root, ".agentchainer", "schedules.json")), false);
  });

  it("edits and deletes, and lists only the watched workspaces", () => {
    const a = tmp();
    const b = tmp();
    const { s } = setup();
    const x = s.save(a, { taskId: TASK, cadence: { kind: "daily", at: "02:00" }, enabled: true });
    s.save(b, { taskId: TASK, cadence: { kind: "hourly", every: 2 }, enabled: true });
    const edited = s.save(a, { id: x.id, taskId: TASK, cadence: { kind: "daily", at: "03:00" }, enabled: false });
    assert.deepEqual([edited.id, edited.createdAt, edited.enabled], [x.id, x.createdAt, false]);
    assert.equal(s.watch([a]).length, 1);
    s.delete(a, x.id);
    assert.deepEqual(s.list(a), []);
    assert.throws(() => s.delete(a, x.id), /no schedule/);
    s.stop();
  });

  it("reads a broken file as no schedules", () => {
    const root = tmp();
    const { s } = setup();
    s.save(root, { taskId: TASK, cadence: { kind: "daily", at: "02:00" }, enabled: true });
    writeFileSync(path.join(root, ".agentchainer", "schedules.json"), "{ not json");
    assert.deepEqual(loadSchedules(root), []);
  });
});
