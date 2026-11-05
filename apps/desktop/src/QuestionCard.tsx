import type { PermissionRequest } from "@agentchainer/protocol";
import { Check, MessageCircleQuestion } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { t } from "./i18n/index.ts";
import type { PermissionAnswer } from "./PermissionDialog.tsx";
import { answeredInput, answerOf, type Choice, questionsOf } from "./questions.ts";

const EMPTY: Choice = { picked: [], other: "" };

/**
 * Claude's questions (`AskUserQuestion`, UX-12) as a card in the thread, one question at a time like the CLI: a tab per
 * question (its short header, ticked once answered) and a last Submit tab that shows every answer. Picking an option
 * of a single-choice question moves on; a multi-choice question has Next. Keys: 1–9 pick, ←/→ change tabs, Enter
 * submits from the last tab. Skip tells Claude to go on without the answers.
 */
export function QuestionCard({
  request,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  const questions = useMemo(() => questionsOf(request.input), [request.input]);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [at, setAt] = useState(0);
  const card = useRef<HTMLElement>(null);
  const input = answeredInput(request.input, questions, choices);
  const submitTab = questions.length;
  const choice = (i: number): Choice => choices[i] ?? EMPTY;
  const answered = (i: number) => answerOf(choices[i]) !== "";

  /** The next question without an answer after `i`, or the Submit tab. */
  const nextFrom = (i: number, all: Record<number, Choice>) => {
    for (let k = i + 1; k < questions.length; k++) if (!answerOf(all[k])) return k;
    for (let k = 0; k < i; k++) if (!answerOf(all[k])) return k;
    return submitTab;
  };
  const go = (i: number) => {
    setAt(Math.max(0, Math.min(submitTab, i)));
    requestAnimationFrame(() => card.current?.focus());
  };

  function pick(i: number, label: string) {
    const q = questions[i];
    if (!q) return;
    const c = choice(i);
    const on = c.picked.includes(label);
    const next: Choice = q.multiSelect
      ? { ...c, picked: on ? c.picked.filter((p) => p !== label) : [...c.picked, label] }
      : { picked: [label], other: "" };
    const all = { ...choices, [i]: next };
    setChoices(all);
    if (!q.multiSelect) go(nextFrom(i, all));
  }

  function onKey(e: KeyboardEvent<HTMLElement>) {
    if (e.target instanceof HTMLInputElement && e.target.type === "text") {
      if (e.key === "Enter") {
        e.preventDefault();
        go(nextFrom(at, choices));
      }
      return;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      go(at + (e.key === "ArrowRight" ? 1 : -1));
      return;
    }
    const q = questions[at];
    const n = Number(e.key);
    if (q && Number.isInteger(n) && n >= 1 && n <= q.options.length) {
      e.preventDefault();
      pick(at, q.options[n - 1]?.label ?? "");
      return;
    }
    if (e.key === "Enter" && at === submitTab && input) {
      e.preventDefault();
      onAnswer({ allow: true, updatedInput: input });
    }
  }

  const q = questions[at];
  const c = choice(at);
  return (
    <section
      className="question-card"
      aria-label={t("session.question.claudeAsks")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the card takes the number and arrow keys while it has focus.
      tabIndex={0}
      ref={card}
      onKeyDown={onKey}
    >
      <header>
        <MessageCircleQuestion size={15} aria-hidden />
        <strong>{t("session.question.claudeAsks")}</strong>
        <div className="question-tabs" role="tablist" aria-label={t("session.question.tabsLabel")}>
          {questions.map((x, i) => (
            <button
              key={x.question}
              type="button"
              role="tab"
              aria-selected={at === i}
              className={`question-tab${at === i ? " active" : ""}`}
              onClick={() => go(i)}
            >
              {answered(i) && <Check size={12} aria-label={t("session.question.answered")} />}
              {x.header ?? t("session.question.number", { n: i + 1 })}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={at === submitTab}
            className={`question-tab${at === submitTab ? " active" : ""}`}
            onClick={() => go(submitTab)}
          >
            {t("session.question.submitTab")}
          </button>
        </div>
      </header>

      {q ? (
        <div className="question" role="tabpanel">
          <p className="question-text">{q.question}</p>
          {q.multiSelect && <p className="muted question-hint">{t("session.question.multi")}</p>}
          <ol className="question-options">
            {q.options.map((o, k) => {
              const on = c.picked.includes(o.label);
              return (
                <li key={o.label}>
                  <button
                    type="button"
                    className={`question-option${on ? " on" : ""}`}
                    aria-pressed={on}
                    onClick={() => pick(at, o.label)}
                  >
                    <kbd>{k + 1}</kbd>
                    <span className="question-label">{o.label}</span>
                    {o.description && <span className="muted question-desc">{o.description}</span>}
                    {on && <Check size={14} className="question-check" aria-hidden />}
                  </button>
                  {o.preview && on && <pre className="question-preview">{o.preview}</pre>}
                </li>
              );
            })}
          </ol>
          <label className="question-other">
            <span className="muted">{t("session.question.other")}</span>
            <input
              type="text"
              value={c.other}
              placeholder={t("session.question.otherPlaceholder")}
              onChange={(e) =>
                setChoices((all) => ({
                  ...all,
                  [at]: { picked: q.multiSelect ? c.picked : [], other: e.target.value },
                }))
              }
            />
          </label>
        </div>
      ) : (
        <div className="question-review" role="tabpanel">
          <ul>
            {questions.map((x, i) => (
              <li key={x.question}>
                <button type="button" className="link" onClick={() => go(i)}>
                  {x.header ?? t("session.question.number", { n: i + 1 })}
                </button>
                <span className={answered(i) ? undefined : "muted"}>
                  {answerOf(choices[i]) || t("session.question.notAnswered")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer>
        <span className="muted question-keys">
          {t("session.question.keys", { max: Math.max(...questions.map((x) => x.options.length), 1) })}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="secondary small"
          // Sent to Claude: stays English (X-13).
          onClick={() => onAnswer({ allow: false, message: "The person skipped these questions. Go on without them." })}
        >
          {t("session.question.skip")}
        </button>
        {q && (q.multiSelect || c.other.trim()) && at < submitTab ? (
          <button type="button" className="small" disabled={!answered(at)} onClick={() => go(nextFrom(at, choices))}>
            {t("session.question.next")}
          </button>
        ) : (
          <button
            type="button"
            className="small"
            disabled={!input}
            title={input ? undefined : t("session.question.answerAllFirst")}
            onClick={() => input && onAnswer({ allow: true, updatedInput: input })}
          >
            {t("session.question.submit")}
          </button>
        )}
      </footer>
    </section>
  );
}
