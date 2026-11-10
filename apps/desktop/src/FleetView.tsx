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
import { approxUsd, dateTime } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { lastRunText, whenText } from "./schedules.ts";
import { folderName, type Tab } from "./tabs.ts";
import { agentLabel, costText } from "./tasks/stepAgent.ts";
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
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const groups = useMemo(() => fleetGroups(items), [items]);
  const counts = {
    waiting: items.filter((i) => i.status === "waiting").length,
    working: items.filter((i) => i.status === "working").length,
    ended: items.filter((i) => i.status === "ended").length,
  };
  const tabTitle = (id: string) => tabs.find((tab) => tab.sessionId === id)?.title;
  const title = (i: FleetItem) =>
    i.task
      ? `${i.task.title ?? i.task.id}`
      : i.parentId
        ? // A Team chat's worker (M8-03).
          t("graph.fleet.workerOf", {
            worker: tabTitle(i.sessionId) ?? t("graph.fleet.worker"),
            parent: tabTitle(i.parentId) ?? t("graph.fleet.teamChat"),
          })
        : (tabTitle(i.sessionId) ?? t("graph.fleet.chat"));
  const open = (i: FleetItem) =>
    i.task
      ? onOpenTask(workspaceOf(i.task.cwd), i.task.id, i.task.title ?? t("graph.fleet.task"))
      : onOpenChat(i.sessionId);

  return (
    <div className="fleet">
      <header className="fleet-header">
        <Radar size={18} aria-hidden />
        <h1>{t("graph.fleet.title")}</h1>
        <span className="muted">
          {t("graph.fleet.counts", { waiting: counts.waiting, working: counts.working, total: items.length })}
        </span>
        <span className="grow" />
        {counts.ended > 0 && (
          <button type="button" className="secondary small" onClick={onClearEnded}>
            {t("graph.fleet.clearEnded", { n: counts.ended })}
          </button>
        )}
      </header>
      {items.length === 0 ? (
        <p className="muted fleet-empty">{t("graph.fleet.empty")}</p>
      ) : (
        groups.map((g) => (
          <section key={g.cwd} className="fleet-group" aria-label={folderName(g.cwd)}>
            <h2 title={g.cwd}>{folderName(g.cwd)}</h2>
            <ul className="fleet-list">
              {g.items.map((i) => (
                <li key={i.sessionId} className={`fleet-row ${i.status}`}>
                  {i.task ? (
                    <ClipboardList size={14} aria-label={t("graph.fleet.taskStep")} />
                  ) : (
                    <MessageSquare size={14} aria-label={t("graph.fleet.chat")} />
                  )}
                  <button type="button" className="fleet-main" onClick={() => open(i)} title={t("graph.fleet.openIt")}>
                    <span className="fleet-title">{title(i)}</span>
                    {i.task && (
                      <span className="muted fleet-step">
                        {i.task.label}
                        {i.task.role ? ` · ${i.task.role}` : ""}
                        {i.agent && i.agent !== "claude" ? ` · ${agentLabel(i.agent, i.model)}` : ""}
                      </span>
                    )}
                  </button>
                  <StatusMark status={i.status} />
                  {i.waiting > 0 && <span className="badge">{t("graph.fleet.toAnswer", { n: i.waiting })}</span>}
                  <span className="muted fleet-time" title={dateTime(i.since)}>
                    {ago(i.since, now)}
                  </span>
                  <FleetCost item={i} />
                  {i.status === "waiting" ? (
                    <button type="button" className="small" onClick={() => open(i)}>
                      {t("graph.fleet.answer")}
                    </button>
                  ) : (
                    <button type="button" className="secondary small" onClick={() => open(i)}>
                      {t("graph.fleet.open")}
                    </button>
                  )}
                  {(i.status === "working" || i.status === "waiting") && (
                    <button
                      type="button"
                      className="ghost icon"
                      aria-label={i.task ? t("graph.fleet.stopTask") : t("graph.fleet.stopTurn")}
                      title={i.task ? t("graph.fleet.stopTask") : t("graph.fleet.stopTurn")}
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
        <section className="fleet-group fleet-schedules" aria-label={t("graph.fleet.scheduled")}>
          <h2>{t("graph.fleet.scheduled")}</h2>
          <p className="muted fleet-note">{t("graph.fleet.scheduledNote")}</p>
          <ul className="fleet-list">
            {[...schedules]
              .sort((a, b) => a.nextAt.localeCompare(b.nextAt))
              .map((s) => (
                <li key={`${s.cwd}|${s.id}`} className={`fleet-row${s.enabled ? "" : " ended"}`}>
                  <CalendarClock size={14} aria-label={t("graph.fleet.schedule")} />
                  <button
                    type="button"
                    className="fleet-main"
                    onClick={() => onOpenTask(workspaceOf(s.cwd), s.taskId, s.title)}
                    title={t("graph.fleet.openTask")}
                  >
                    <span className="fleet-title">{s.title}</span>
                    <span className="muted fleet-step">
                      {folderName(s.cwd)} · {cadenceText(s.cadence)} ·{" "}
                      {s.enabled
                        ? t("graph.fleet.next", { when: whenText(new Date(s.nextAt), new Date(now)) })
                        : t("graph.fleet.off")}
                    </span>
                  </button>
                  <span className={`muted fleet-time${s.lastRun?.state === "failed-to-start" ? " warn" : ""}`}>
                    {lastRunText(s, new Date(now))}
                  </span>
                  <label className="check" title={s.enabled ? t("graph.fleet.turnOff") : t("graph.fleet.turnOn")}>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={() => onSchedule?.("toggle", s)}
                      aria-label={t("graph.fleet.scheduleOn", { title: s.title })}
                    />
                    <span className="sr-only">{t("graph.fleet.on")}</span>
                  </label>
                  <button type="button" className="secondary small" onClick={() => onSchedule?.("run", s)}>
                    {t("graph.fleet.runNow")}
                  </button>
                  <IconButton
                    label={t("graph.fleet.editSchedule", { title: s.title })}
                    onClick={() => onSchedule?.("edit", s)}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    label={t("graph.fleet.deleteSchedule", { title: s.title })}
                    onClick={() => onSchedule?.("delete", s)}
                  >
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

/** A row's spend: an estimate from tokens for a step on Codex or agy (M9-07). */
function FleetCost({ item }: { item: FleetItem }) {
  const c = costText(approxUsd(item.costUsd, 3), item.costKind, undefined);
  return (
    <span className="muted fleet-cost" title={c.title}>
      {c.text}
    </span>
  );
}
