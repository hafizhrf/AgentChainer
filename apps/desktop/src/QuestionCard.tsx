import type { PermissionRequest } from "@agentchainer/protocol";
import { MessageCircleQuestion } from "lucide-react";
import { useMemo, useState } from "react";
import type { PermissionAnswer } from "./PermissionDialog.tsx";
import { answeredInput, type Choice, questionsOf } from "./questions.ts";

/**
 * Claude's questions (`AskUserQuestion`, UX-12) as a card in the thread: each with its options (one, or several when
 * the question allows it) and "Other" for the person's own answer. Answer sends the choices back as the tool's input;
 * Skip tells Claude to go on without them.
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
  const input = answeredInput(request.input, questions, choices);
  const choice = (i: number): Choice => choices[i] ?? { picked: [], other: "" };
  const set = (i: number, next: Choice) => setChoices((all) => ({ ...all, [i]: next }));

  return (
    <section className="question-card" aria-label="Claude asks">
      <header>
        <MessageCircleQuestion size={15} aria-hidden />
        <strong>Claude asks</strong>
        <span className="muted">
          {questions.length === 1 ? "1 question" : `${questions.length} questions`} before going on
        </span>
      </header>
      {questions.map((q, i) => {
        const c = choice(i);
        const name = `${request.requestId}-${i}`;
        return (
          <fieldset key={q.question} className="question">
            <legend>
              {q.header && <span className="chip">{q.header}</span>}
              {q.question}
            </legend>
            {q.options.map((o) => {
              const on = c.picked.includes(o.label);
              return (
                <label key={o.label} className={`question-option${on ? " on" : ""}`}>
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={name}
                    checked={on}
                    onChange={() =>
                      set(i, {
                        ...c,
                        picked: q.multiSelect
                          ? on
                            ? c.picked.filter((p) => p !== o.label)
                            : [...c.picked, o.label]
                          : [o.label],
                        // One answer per single-choice question: picking an option clears "Other".
                        other: q.multiSelect ? c.other : "",
                      })
                    }
                  />
                  <span>
                    <span className="question-label">{o.label}</span>
                    {o.description && <span className="muted"> {o.description}</span>}
                    {o.preview && on && <pre className="question-preview">{o.preview}</pre>}
                  </span>
                </label>
              );
            })}
            <label className="question-option other">
              <span className="question-label">Other</span>
              <input
                type="text"
                value={c.other}
                placeholder="Your own answer"
                onChange={(e) => set(i, { picked: q.multiSelect ? c.picked : [], other: e.target.value })}
              />
            </label>
          </fieldset>
        );
      })}
      <footer>
        <span className="grow" />
        <button
          type="button"
          className="secondary small"
          onClick={() => onAnswer({ allow: false, message: "The person skipped these questions. Go on without them." })}
        >
          Skip
        </button>
        <button
          type="button"
          className="small"
          disabled={!input}
          title={input ? undefined : "Answer every question first"}
          onClick={() => input && onAnswer({ allow: true, updatedInput: input })}
        >
          Answer
        </button>
      </footer>
    </section>
  );
}
