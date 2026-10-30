import { editPairs, lineDiff } from "./textdiff.ts";

/** The line diffs of an Edit, MultiEdit or Write call's input, or null for other tools. */
export function editDiffs(toolName: string, input: unknown) {
  return editPairs(toolName, input)?.map((p) => lineDiff(p.before, p.after)) ?? null;
}

/** Added and removed line counts of `editDiffs`. */
export function diffStat(diffs: ReturnType<typeof lineDiff>[]) {
  const lines = diffs.flat();
  return { added: lines.filter((l) => l.op === "+").length, removed: lines.filter((l) => l.op === "-").length };
}

/**
 * What an edit changes, as +/− lines (M1-11), from the tool input only: the transcript's tool cards and the approval
 * dialog (UX-05) both show it.
 */
export function InlineDiff({ diffs }: { diffs: ReturnType<typeof lineDiff>[] }) {
  return (
    <>
      {diffs.map((lines, i) => (
        // Edits of one call have no ids; their order is fixed.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above.
        <pre key={i} className="inline-diff">
          {lines.map((l, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff.
            <span key={j} className={l.op === "+" ? "add" : l.op === "-" ? "del" : ""}>
              {l.op} {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
      ))}
    </>
  );
}
