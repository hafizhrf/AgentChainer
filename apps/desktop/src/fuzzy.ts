/**
 * Fuzzy matching for the composer's @file and / pickers (M1-13): the query's characters must appear in order.
 * Scores favour matches in the file name, at word starts, and in runs.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 0;
  const nameStart = c.lastIndexOf("/") + 1;
  let score = 0;
  let prev = -2;
  let ci = 0;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found < 0) return null;
    score += 1;
    if (found === prev + 1) score += 3; // a run
    if (found >= nameStart) score += 2; // in the file name
    if (found === 0 || "/-_. ".includes(c[found - 1] ?? "")) score += 3; // a word start
    prev = found;
    ci = found + 1;
  }
  return score - c.length * 0.01; // shorter wins ties
}

/** Like `fuzzyFilter`, for objects: matches on `key(item)`, best first; with no query, keeps the given order. */
export function fuzzyFilterBy<T>(query: string, items: readonly T[], key: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, s: fuzzyScore(query.trim(), key(item)) }))
    .filter((x): x is { item: T; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.item);
}

export function fuzzyFilter(query: string, candidates: string[], limit = 8): string[] {
  return candidates
    .map((c) => ({ c, s: fuzzyScore(query, c) }))
    .filter((x): x is { c: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

/** The `@word` or leading `/word` being typed at `cursor`, with where it starts. */
export function tokenAt(text: string, cursor: number): { kind: "@" | "/"; query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "@", query: at[2] ?? "", start: cursor - (at[2]?.length ?? 0) - 1 };
  const slash = /^\/([^\s/]*)$/.exec(before);
  if (slash) return { kind: "/", query: slash[1] ?? "", start: 0 };
  return null;
}
