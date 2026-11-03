import { CheckCircle2, Circle, ListChecks, LoaderCircle } from "lucide-react";
import type { Todo } from "./commands.ts";

/**
 * Claude's todo list (its last `TodoWrite`, UX-12), pinned above the composer and folded to a count by default. Each
 * item's state is an icon and a label, not color alone (X-12).
 */
export function TodoPanel({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress");
  return (
    <details className="todo-panel">
      <summary className="todo-summary">
        <ListChecks size={14} aria-hidden />
        <span>
          Todos {done} of {todos.length} done
        </span>
        {current && <span className="muted todo-current">· {current.activeForm ?? current.content}</span>}
      </summary>
      <ul>
        {todos.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: todo texts can repeat; the list is replaced whole.
          <li key={i} className={`todo ${t.status}`}>
            {t.status === "completed" ? (
              <CheckCircle2 size={13} aria-label="Done" />
            ) : t.status === "in_progress" ? (
              <LoaderCircle size={13} className="spin" aria-label="In progress" />
            ) : (
              <Circle size={13} aria-label="To do" />
            )}
            <span>{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
