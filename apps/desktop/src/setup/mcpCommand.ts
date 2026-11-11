/**
 * A command's words as one line to read or paste into a POSIX shell (CP-02): a word with a space or a character the
 * shell would read is single-quoted, so `NAME=${NAME}` shows exactly what the CLI receives.
 */
export function shellLine(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
