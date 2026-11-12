import type { TaskSummary } from "@agentchainer/protocol";
import { CircleDot } from "lucide-react";
import { useEffect, useState } from "react";
import { approxUsd, dateTime } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { stateLabel } from "./run.ts";

const usd = (n: number) => approxUsd(n, n < 0.1 ? 4 : 2);

/**
 * The workspace's tasks on Home (UX-13), newest first; one opens in its tab. New tasks start from the composer, or
 * from one of the repository's GitHub issues (CP-08).
 */
export function HomeTasks({
  cwd,
  onOpen,
  onFromIssue,
}: {
  cwd: string;
  onOpen: (id: string, title: string) => void;
  onFromIssue?: () => void;
}) {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    request("task.list", { cwd }).then(
      (r) => live && setTasks(r.tasks),
      () => live && setTasks([]),
    );
    return () => {
      live = false;
    };
  }, [cwd]);
  if (!tasks || (!tasks.length && !onFromIssue)) return null;
  return (
    <section className="card" aria-labelledby="home-tasks">
      <div className="card-title">
        <h2 id="home-tasks">{t("tasks.home.title")}</h2>
        <span className="muted">{t("tasks.home.subtitle")}</span>
        <span className="grow" />
        {onFromIssue && (
          <button type="button" className="secondary small" onClick={onFromIssue}>
            <CircleDot size={14} aria-hidden />
            {t("tasks.home.fromIssue")}
          </button>
        )}
      </div>
      {!tasks.length && <p className="muted">{t("tasks.home.none")}</p>}
      <ul className="task-list">
        {tasks.slice(0, 12).map((item) => (
          <li key={item.id} className="task-row">
            <button type="button" className="task-row-main" onClick={() => onOpen(item.id, item.request.slice(0, 60))}>
              <span className="task-row-title">{item.request}</span>
              <span className="muted">
                {dateTime(item.createdAt)} · {usd(item.costUsd)}
              </span>
            </button>
            {item.tier && <span className={`tier-badge tier-${item.tier}`}>{item.tier}</span>}
            <span className={`badge tone-${stateLabel(item.state).tone}`}>{stateLabel(item.state).label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
