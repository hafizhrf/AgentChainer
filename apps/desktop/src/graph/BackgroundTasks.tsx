import { Bot, Loader2, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n/index.ts";
import type { BackgroundTask } from "../tabs.ts";

/** A background task's kind in words; one the app doesn't know yet shows as the SDK names it. */
function kindLabel(kind: string): string {
  switch (kind) {
    case "local_agent":
      return t("graph.backgroundTasks.subagent");
    case "local_bash":
      return t("graph.backgroundTasks.shell");
    case "monitor":
      return t("graph.backgroundTasks.monitor");
    default:
      return kind;
  }
}

/**
 * The session's background tasks (M4-07), above the composer: subagents and shells that outlive the turn. Each one can
 * be stopped on its own; a subagent opens its drawer. When the last one ends, the CLI may start a turn on its own to
 * report back.
 */
export function BackgroundTasks({
  tasks,
  onStop,
  onOpen,
}: {
  tasks: BackgroundTask[];
  onStop: (taskId: string) => Promise<void>;
  /** Opens a subagent's drawer. */
  onOpen: (taskId: string) => void;
}) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function stop(taskId: string) {
    setStopping((s) => new Set(s).add(taskId));
    setError(null);
    try {
      await onStop(taskId);
    } catch (err) {
      setError(String(err));
      setStopping((s) => {
        const next = new Set(s);
        next.delete(taskId);
        return next;
      });
    }
  }

  return (
    <section className="background-tasks" aria-label={t("graph.backgroundTasks.label")}>
      <header>
        <Loader2 size={13} className="spin" aria-hidden />
        {t("graph.backgroundTasks.count", { count: tasks.length })}
      </header>
      <ul>
        {tasks.map((task) => (
          <li key={task.taskId}>
            {task.kind === "local_agent" ? <Bot size={13} aria-hidden /> : <SquareTerminal size={13} aria-hidden />}
            <span className="muted">{kindLabel(task.kind)}</span>
            {task.kind === "local_agent" ? (
              <button type="button" className="link background-name" onClick={() => onOpen(task.taskId)}>
                {task.description}
              </button>
            ) : (
              <span className="background-name" title={task.description}>
                {task.description}
              </span>
            )}
            <button
              type="button"
              className="secondary small"
              disabled={stopping.has(task.taskId)}
              onClick={() => void stop(task.taskId)}
            >
              <Square size={12} />
              {stopping.has(task.taskId) ? t("graph.backgroundTasks.stopping") : t("graph.backgroundTasks.stop")}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="agent-error">{error}</p>}
    </section>
  );
}
