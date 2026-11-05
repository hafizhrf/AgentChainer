import { CheckCircle2, Circle, ListChecks, LoaderCircle } from "lucide-react";
import type { Todo } from "./commands.ts";
import { t } from "./i18n/index.ts";

/**
 * Claude's todo list (its last `TodoWrite`, UX-12), pinned above the composer and folded to a count by default. Each
 * item's state is an icon and a label, not color alone (X-12).
 */
export function TodoPanel({ todos }: { todos: Todo[] }) {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const current = todos.find((todo) => todo.status === "in_progress");
  return (
    <details className="todo-panel">
      <summary className="todo-summary">
        <ListChecks size={14} aria-hidden />
        <span>{t("session.todos.summary", { done, total: todos.length })}</span>
        {current && <span className="muted todo-current">· {current.activeForm ?? current.content}</span>}
      </summary>
      <ul>
        {todos.map((todo, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: todo texts can repeat; the list is replaced whole.
          <li key={i} className={`todo ${todo.status}`}>
            {todo.status === "completed" ? (
              <CheckCircle2 size={13} aria-label={t("session.todos.done")} />
            ) : todo.status === "in_progress" ? (
              <LoaderCircle size={13} className="spin" aria-label={t("session.todos.inProgress")} />
            ) : (
              <Circle size={13} aria-label={t("session.todos.toDo")} />
            )}
            <span>{todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
