/**
 * Markdown fences for text the app quotes to a person or an agent (CP-05): a quote of a file, a diff, a log. The fence
 * is longer than any run of backticks in the text, so the text can't close it early and is kept exactly as it is.
 */

/** A fence longer than any run of backticks in `text`, at least three. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** `text` in a fence of its own, with an info string (a language) when one is given. */
export function fenced(text: string, info = ""): string {
  const fence = fenceFor(text);
  return `${fence}${info}\n${text}\n${fence}`;
}

/** The info string for a path's fence: its extension, when it has one. */
export function fenceLanguage(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return name.includes(".") && !name.startsWith(".") ? (name.split(".").at(-1)?.toLowerCase() ?? "") : "";
}
