import { cadenceText, type FleetItem, type Schedule } from "@agentchainer/protocol";
import {
  CalendarClock,
  CircleCheck,
  CircleMinus,
  ClipboardList,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Radar,
  ShieldQuestion,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ago, fleetGroups, FLEET_STATUS as STATUS, workspaceOf } from "./fleet.ts";
import { lastRunText, whenText } from "./schedules.ts";
import { folderName, type Tab } from "./tabs.ts";
import { IconButton } from "./ui/IconButton.tsx";

function StatusMark({ status }: { status: FleetItem["status"] }) {
  const Icon =
    status === "waiting"
      ? ShieldQuestion
      : status === "working"
        ? LoaderCircle
        : status === "idle"
          ? CircleCheck
          : CircleMinus;
  return (
    <span className={`fleet-status ${status}`}>
      <Icon size={13} className={status === "working" ? "spin" : undefined} aria-hidden />
      {STATUS[status].label}
    </span>
  );
}

/**
 * The fleet view (M8-02, docs/design/workspaces-and-fleet.md §4): every live chat and task step across workspaces,
 * with its status, how long it's been so, and its cost; one click opens it. Ended ones stay until the app restarts,
 * or until they're cleared.
 */
export function FleetView({
  items,
  tabs,
  schedules = [],
  onOpenChat,
  onOpenTask,
  onStop,
  onClearEnded,
  onSchedule,
}: {
  items: FleetItem[];
  tabs: Tab[];
  /** Every schedule in the watched workspaces (M8-05). */
  schedules?: Schedule[];
  onOpenChat: (sessionId: string) => void;
  onOpenTask: (cwd: string, id: string, title: string) => void;
  onStop: (item: FleetItem) => void;
  onClearEnded: () => void;
  onSchedule?: (action: ScheduleAction, schedule: Schedule) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  const groups = useMemo(() => fleetGroups(items), [items]);
  const counts = {
    waiting: items.filter((i) => i.status === "waiting").length,
    working: items.filter((i) => i.status === "working").length,
    ended: items.filter((i) => i.status === "ended").length,
  };
  const tabTitle = (id: string) => tabs.find((t) => t.sessionId === id)?.title;
  const title = (i: FleetItem) =>
    i.task
      ? `${i.task.title ?? i.task.id}`
      : i.parentId
        ? // A Team chat's worker (M8-03).
          `${tabTitle(i.sessionId) ?? "Worker"} · worker of ${tabTitle(i.parentId) ?? "a Team chat"}`
        : (tabTitle(i.sessionId) ?? "Chat");
  const open = (i: FleetItem) =>
    i.task ? onOpenTask(workspaceOf(i.task.cwd), i.task.id, i.task.title ?? "Task") : onOpenChat(i.sessionId);

  return (
    <div className="fleet">
      <header className="fleet-header">
        <Radar size={18} aria-hidden />
        <h1>Fleet</h1>
        <span className="muted">
          {counts.waiting} waiting for you · {counts.working} working · {items.length} in all
        </span>
        <span className="grow" />
        {counts.ended > 0 && (
          <button type="button" className="secondary small" onClick={onClearEnded}>
            Clear {counts.ended} ended
          </button>
        )}
      </header>
      {items.length === 0 ? (
        <p className="muted fleet-empty">Nothing is running. Chats and task steps show here while they live.</p>
      ) : (
        groups.map((g) => (
          <section key={g.cwd} className="fleet-group" aria-label={folderName(g.cwd)}>
            <h2 title={g.cwd}>{folderName(g.cwd)}</h2>
            <ul className="fleet-list">
              {g.items.map((i) => (
                <li key={i.sessionId} className={`fleet-row ${i.status}`}>
                  {i.task ? (
                    <ClipboardList size={14} aria-label="Task step" />
                  ) : (
                    <MessageSquare size={14} aria-label="Chat" />
                  )}
                  <button type="button" className="fleet-main" onClick={() => open(i)} title="Open it">
                    <span className="fleet-title">{title(i)}</span>
                    {i.task && (
                      <span className="muted fleet-step">
                        {i.task.label}
                        {i.task.role ? ` · ${i.task.role}` : ""}
                      </span>
                    )}
                  </button>
                  <StatusMark status={i.status} />
                  {i.waiting > 0 && <span className="badge">{i.waiting} to answer</span>}
                  <span className="muted fleet-time" title={new Date(i.since).toLocaleString()}>
                    {ago(i.since, now)}
                  </span>
                  <span className="muted fleet-cost">≈${i.costUsd.toFixed(3)}</span>
                  {i.status === "waiting" ? (
                    <button type="button" className="small" onClick={() => open(i)}>
                      Answer
                    </button>
                  ) : (
                    <button type="button" className="secondary small" onClick={() => open(i)}>
                      Open
                    </button>
                  )}
                  {(i.status === "working" || i.status === "waiting") && (
                    <button
                      type="button"
                      className="ghost icon"
                      aria-label={i.task ? "Stop the task" : "Stop the turn"}
                      title={i.task ? "Stop the task" : "Stop the turn"}
                      onClick={() => onStop(i)}
                    >
                      <Square size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {schedules.length > 0 && (
        <section className="fleet-group fleet-schedules" aria-label="Scheduled">
          <h2>Scheduled</h2>
          <p className="muted fleet-note">
            Runs only while AgentChainer is open; a time missed while it was closed runs once.
          </p>
          <ul className="fleet-list">
            {[...schedules]
              .sort((a, b) => a.nextAt.localeCompare(b.nextAt))
              .map((s) => (
                <li key={`${s.cwd}|${s.id}`} className={`fleet-row${s.enabled ? "" : " ended"}`}>
                  <CalendarClock size={14} aria-label="Schedule" />
                  <button
                    type="button"
                    className="fleet-main"
                    onClick={() => onOpenTask(workspaceOf(s.cwd), s.taskId, s.title)}
                    title="Open the task"
                  >
                    <span className="fleet-title">{s.title}</span>
                    <span className="muted fleet-step">
                      {folderName(s.cwd)} · {cadenceText(s.cadence)} ·{" "}
                      {s.enabled ? `next ${whenText(new Date(s.nextAt), new Date(now))}` : "off"}
                    </span>
                  </button>
                  <span className={`muted fleet-time${s.lastRun?.state === "failed-to-start" ? " warn" : ""}`}>
                    {lastRunText(s, new Date(now))}
                  </span>
                  <label className="check" title={s.enabled ? "Turn this schedule off" : "Turn this schedule on"}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={() => onSchedule?.("toggle", s)}
                      aria-label={`${s.title}: schedule on`}
                    />
                    <span className="sr-only">On</span>
                  </label>
                  <button type="button" className="secondary small" onClick={() => onSchedule?.("run", s)}>
                    Run now
                  </button>
                  <IconButton label={`Edit the schedule of ${s.title}`} onClick={() => onSchedule?.("edit", s)}>
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton label={`Delete the schedule of ${s.title}`} onClick={() => onSchedule?.("delete", s)}>
                    <Trash2 size={13} />
                  </IconButton>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export type ScheduleAction = "toggle" | "run" | "edit" | "delete";
