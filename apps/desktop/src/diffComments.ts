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

/** A fence longer than any run of backticks in `text`, so a quote can't close it early. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The info string for a path's fence: its extension, when it has one. */
const languageOf = (path: string) => {
  const name = path.split("/").at(-1) ?? path;
  return name.includes(".") && !name.startsWith(".") ? (name.split(".").at(-1)?.toLowerCase() ?? "") : "";
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
    const fence = fenceFor(c.quote);
    return `${labels.where(c)}\n${fence}${languageOf(c.path)}\n${c.quote}\n${fence}\n${c.text.trim()}`;
  });
  return [labels.header, ...parts].join("\n\n");
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
