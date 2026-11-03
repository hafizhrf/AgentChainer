import type { FleetItem } from "@agentchainer/protocol";
import {
  CircleCheck,
  CircleMinus,
  ClipboardList,
  LoaderCircle,
  MessageSquare,
  Radar,
  ShieldQuestion,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ago, fleetGroups, FLEET_STATUS as STATUS, workspaceOf } from "./fleet.ts";
import { folderName, type Tab } from "./tabs.ts";

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
  onOpenChat,
  onOpenTask,
  onStop,
  onClearEnded,
}: {
  items: FleetItem[];
  tabs: Tab[];
  onOpenChat: (sessionId: string) => void;
  onOpenTask: (cwd: string, id: string, title: string) => void;
  onStop: (item: FleetItem) => void;
  onClearEnded: () => void;
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
  const title = (i: FleetItem) =>
    i.task ? `${i.task.title ?? i.task.id}` : (tabs.find((t) => t.sessionId === i.sessionId)?.title ?? "Chat");
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
    </div>
  );
}
