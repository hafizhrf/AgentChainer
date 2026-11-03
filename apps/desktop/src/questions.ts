/**
 * Claude's questions (`AskUserQuestion`, UX-12): the tool's input as the app reads it, and the answers in the shape the
 * tool takes back: question text → the chosen label, several labels joined by ", ", or the person's own text.
 */

export type QuestionOption = { label: string; description?: string; preview?: string };
export type Question = { question: string; header?: string; options: QuestionOption[]; multiSelect: boolean };

/** The questions in an `AskUserQuestion` input; anything malformed is left out. */
export function questionsOf(input: unknown): Question[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.flatMap((q): Question[] => {
    if (typeof q?.question !== "string" || !Array.isArray(q.options)) return [];
    const options = (q.options as unknown[]).flatMap((o): QuestionOption[] => {
      const r = o as Record<string, unknown> | null;
      if (typeof r?.label !== "string") return [];
      return [
        {
          label: r.label,
          ...(typeof r.description === "string" ? { description: r.description } : {}),
          ...(typeof r.preview === "string" ? { preview: r.preview } : {}),
        },
      ];
    });
    return [
      {
        question: q.question,
        ...(typeof q.header === "string" ? { header: q.header } : {}),
        options,
        multiSelect: q.multiSelect === true,
      },
    ];
  });
}

/** What the person picked for one question: option labels, and their own text ("Other"). */
export type Choice = { picked: string[]; other: string };

/** The answer for one question, or "" when nothing was picked or typed. */
export function answerOf(choice: Choice | undefined): string {
  if (!choice) return "";
  const parts = [...choice.picked, ...(choice.other.trim() ? [choice.other.trim()] : [])];
  return parts.join(", ");
}

/** The tool's input with the answers added, keyed by question text; null until every question has an answer. */
export function answeredInput(
  input: unknown,
  questions: Question[],
  choices: Record<number, Choice>,
): Record<string, unknown> | null {
  const answers: Record<string, string> = {};
  for (const [i, q] of questions.entries()) {
    const a = answerOf(choices[i]);
    if (!a) return null;
    answers[q.question] = a;
  }
  return { ...(input as Record<string, unknown>), answers };
}
