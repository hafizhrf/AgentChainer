import { Bot, Loader2, Square, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { BackgroundTask } from "../tabs.ts";

const KIND_LABEL: Record<string, string> = {
  local_agent: "Subagent",
  local_bash: "Shell",
  monitor: "Monitor",
};

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
    <section className="background-tasks" aria-label="Background tasks">
      <header>
        <Loader2 size={13} className="spin" aria-hidden />
        {tasks.length === 1 ? "1 task in the background" : `${tasks.length} tasks in the background`}
      </header>
      <ul>
        {tasks.map((t) => (
          <li key={t.taskId}>
            {t.kind === "local_agent" ? <Bot size={13} aria-hidden /> : <SquareTerminal size={13} aria-hidden />}
            <span className="muted">{KIND_LABEL[t.kind] ?? t.kind}</span>
            {t.kind === "local_agent" ? (
              <button type="button" className="link background-name" onClick={() => onOpen(t.taskId)}>
                {t.description}
              </button>
            ) : (
              <span className="background-name" title={t.description}>
                {t.description}
              </span>
            )}
            <button
              type="button"
              className="secondary small"
              disabled={stopping.has(t.taskId)}
              onClick={() => void stop(t.taskId)}
            >
              <Square size={12} />
              {stopping.has(t.taskId) ? "Stopping…" : "Stop"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="agent-error">{error}</p>}
    </section>
  );
}
