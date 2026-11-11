import { type FeedbackComment, fenced, fenceLanguage } from "@agentchainer/protocol";

/**
 * Comments on a diff's lines (CP-05): the person picks lines in the diff of a chat's changes, writes what's wrong,
 * and the comments go into the chat's message as one piece of feedback. `new` lines are the file as it is now;
 * `old` lines are ones the change removed, numbered as they were.
 */
export type DiffComment = {
  id: string;
  path: string;
  /** The folder `path` is in, when it isn't the chat's own (a multi-folder workspace's other folder). */
  dir?: string;
  side: "new" | "old";
  start: number;
  end: number;
  /** The lines as they were when the comment was made. */
  quote: string;
  text: string;
};

/**
 * The comments as one message: a header, then for each, where it is, the quoted lines and the comment. Files keep
 * the order they were first commented in; within a file, lines go top to bottom.
 */
export function feedbackMessage(
  comments: readonly DiffComment[],
  labels: { header: string; where: (c: DiffComment) => string },
): string {
  const files = [...new Set(comments.map((c) => c.path))];
  const ordered = files.flatMap((f) =>
    comments
      .filter((c) => c.path === f)
      .sort((a, b) => (a.side === b.side ? a.start - b.start : a.side === "old" ? -1 : 1)),
  );
  const parts = ordered.map((c) => {
    return `${labels.where(c)}\n${fenced(c.quote, fenceLanguage(c.path))}\n${c.text.trim()}`;
  });
  return [labels.header, ...parts].join("\n\n");
}

/**
 * A task's comments as `task.feedback` takes them (CP-05 part 2): on a task's diff, `dir` holds the name of the other
 * folder a file is in.
 */
export function toFeedback(comments: readonly DiffComment[]): FeedbackComment[] {
  return comments.map((c) => ({
    path: c.path,
    ...(c.dir ? { folder: c.dir } : {}),
    side: c.side,
    start: c.start,
    end: c.end,
    quote: c.quote,
    text: c.text.trim(),
  }));
}

/** Whether the lines a comment quotes read differently now (the file changed since). */
export function isStale(comment: DiffComment, text: string): boolean {
  return (
    text
      .split("\n")
      .slice(comment.start - 1, comment.end)
      .join("\n") !== comment.quote
  );
}

/** A draft with `text` added after it, a blank line apart: what Add to message puts in the composer. */
export function appendToDraft(draft: string, text: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, "")}\n\n${text}` : text;
}
