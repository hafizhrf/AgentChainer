import { isMap, isScalar, isSeq, parseDocument } from "yaml";

/**
 * Pure helpers of the upstream-update bot (M2-04, scripts/check-catalog-updates.ts): which upstream version to move
 * to, how its asset URLs look, and editing item YAML without losing comments.
 */

const DAY = 24 * 60 * 60 * 1000;
/** New upstream versions wait this long, like dependencies (pnpm minimumReleaseAge): time for bad releases to surface. */
export const MIN_AGE_DAYS = 14;

const parts = (v: string) => v.replace(/^v/, "").split("-");

export const isPrerelease = (v: string) => parts(v).length > 1;

/** Compares dotted versions (a leading v ignored): negative when a < b. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [ma = "", pa] = parts(a);
  const [mb = "", pb] = parts(b);
  const na = ma.split(".").map(Number);
  const nb = mb.split(".").map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  return (pa ?? "").localeCompare(pb ?? "");
}

export type Candidate = { version: string; publishedAt: string };

/** The newest release that's newer than `current`, not a prerelease, and at least `minAgeDays` old; else null. */
export function newestEligible(
  candidates: Candidate[],
  current: string,
  now: Date,
  minAgeDays = MIN_AGE_DAYS,
): Candidate | null {
  const cutoff = now.getTime() - minAgeDays * DAY;
  return (
    candidates
      .filter((c) => !isPrerelease(c.version))
      .filter((c) => Date.parse(c.publishedAt) <= cutoff)
      .filter((c) => compareVersions(c.version, current) > 0)
      .sort((x, y) => compareVersions(y.version, x.version))[0] ?? null
  );
}

/** An asset URL for another version: every occurrence of the old version (tag and file name) is replaced. */
export function rewriteAssetUrl(url: string, from: string, to: string): string {
  return url.split(from).join(to);
}

/** Today as a catalog version, e.g. 2026.11.5 (docs/CATALOG.md: bumped whenever items change). */
export const catalogVersion = (d: Date) => `${d.getUTCFullYear()}.${d.getUTCMonth() + 1}.${d.getUTCDate()}`;

/**
 * Applies `changes` (path → value) to an item's YAML and clears its reviews: an upstream change must be reviewed again
 * (ADR-0005). Only the changed values are rewritten, in their original quoting, so the rest of the file stays byte for
 * byte. A value that isn't there yet (e.g. a first `reviewedVersion`) falls back to re-serializing the document.
 */
export function bumpItemYaml(text: string, changes: [path: (string | number)[], value: unknown][]): string {
  const doc = parseDocument(text);
  const edits: { start: number; end: number; text: string }[] = [];
  let surgical = true;
  for (const [path, value] of changes) {
    const node = doc.getIn(path, true);
    if (!isScalar(node) || !node.range) {
      surgical = false;
      break;
    }
    const v = String(value);
    const quoted =
      node.type === "QUOTE_DOUBLE"
        ? JSON.stringify(v)
        : node.type === "QUOTE_SINGLE"
          ? `'${v.replaceAll("'", "''")}'`
          : v;
    edits.push({ start: node.range[0], end: node.range[1], text: quoted });
  }
  const reviews = isMap(doc.contents)
    ? doc.contents.items.find((p) => isScalar(p.key) && p.key.value === "reviews")
    : undefined;
  const value = reviews?.value;
  const keyEnd = isScalar(reviews?.key) ? reviews.key.range?.[1] : undefined;
  const cleared = isSeq(value) && value.items.length === 0;
  if (surgical && !cleared) {
    if (keyEnd !== undefined && value && "range" in value && value.range) {
      // `reviews:` + its list → `reviews: []`, keeping the line break that follows a block list.
      let end = value.range[1];
      while (end > keyEnd && /\s/.test(text[end - 1] ?? "")) end--;
      edits.push({ start: keyEnd, end, text: ": []" });
    } else {
      surgical = false;
    }
  }
  if (!surgical) {
    for (const [path, v] of changes) doc.setIn(path, v);
    doc.set("reviews", doc.createNode([]));
    return doc.toString({ lineWidth: 0 });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
