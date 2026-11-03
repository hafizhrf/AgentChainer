import type { TaskSummary } from "@agentchainer/protocol";
import { useEffect, useState } from "react";
import { request } from "../sidecar.ts";
import { stateLabel } from "./run.ts";

const usd = (n: number) => `≈$${n.toFixed(n < 0.1 ? 4 : 2)}`;

/** The workspace's tasks on Home (UX-13), newest first; one opens in its tab. New tasks start from the composer. */
export function HomeTasks({ cwd, onOpen }: { cwd: string; onOpen: (id: string, title: string) => void }) {
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
  if (!tasks?.length) return null;
  return (
    <section className="card" aria-labelledby="home-tasks">
      <div className="card-title">
        <h2 id="home-tasks">Tasks in this workspace</h2>
        <span className="muted">Start one with Task in a chat's composer</span>
      </div>
      <ul className="task-list">
        {tasks.slice(0, 12).map((t) => (
          <li key={t.id} className="task-row">
            <button type="button" className="task-row-main" onClick={() => onOpen(t.id, t.request.slice(0, 60))}>
              <span className="task-row-title">{t.request}</span>
              <span className="muted">
                {new Date(t.createdAt).toLocaleString()} · {usd(t.costUsd)}
              </span>
            </button>
            {t.tier && <span className={`tier-badge tier-${t.tier}`}>{t.tier}</span>}
            <span className={`badge tone-${stateLabel(t.state).tone}`}>{stateLabel(t.state).label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
