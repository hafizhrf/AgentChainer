/** Line diff for inline Edit/Write previews in tool cards (M1-11). Small inputs only; the diff pane uses Monaco. */

export type DiffLine = { op: " " | "-" | "+"; text: string };

/** Above this many lines per side, skip the O(n·m) table and show the change as remove-all / add-all. */
const MAX_LINES = 400;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  }
  // lcs[i * w + j] = length of the longest common subsequence of a[i..] and b[j..].
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i] ?? "" });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ op: "-", text: a[i++] ?? "" });
    } else {
      out.push({ op: "+", text: b[j++] ?? "" });
    }
  }
  for (; i < a.length; i++) out.push({ op: "-", text: a[i] ?? "" });
  for (; j < b.length; j++) out.push({ op: "+", text: b[j] ?? "" });
  return out;
}

/** The before/after pairs an Edit, MultiEdit or Write call shows, or null for other tools. */
export function editPairs(name: string, input: unknown): { before: string; after: string }[] | null {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "Edit") return [{ before: str(o.old_string), after: str(o.new_string) }];
  if (name === "MultiEdit" && Array.isArray(o.edits)) {
    return o.edits.map((e: Record<string, unknown>) => ({ before: str(e.old_string), after: str(e.new_string) }));
  }
  if (name === "Write") return [{ before: "", after: str(o.content) }];
  return null;
}
