/**
 * What makes a CLAUDE.md a good one, shared by the readiness audit, the generators, task lessons and the CLAUDE.md
 * editor (CP-03).
 */

/** CLAUDE.md files over this many lines cost context in every session. */
export const LONG_CLAUDE_MD = 300;

/** A path in someone's home folder: it says who wrote the file and where, and works on nobody else's machine. */
export const HOME_PATH = /(\/Users\/|\/home\/|[A-Z]:\\Users\\)\w/;

/** Lines as an editor counts them: a final newline starts one more, empty line. */
export const lineCount = (text: string) => text.split("\n").length;
