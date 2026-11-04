import type { InstalledPlugin, MarketPlugin } from "@agentchainer/protocol";
import { fuzzyScore } from "../fuzzy.ts";

/** Rows the Plugins page shows before "Show more": the marketplaces list thousands. */
export const PAGE = 100;

const approved = (p: MarketPlugin) => p.review?.approved === true;

/** Reviewed first, then Anthropic's marketplaces, then the most installed, then by name. */
export function byDefault(a: MarketPlugin, b: MarketPlugin): number {
  return (
    Number(approved(b)) - Number(approved(a)) ||
    Number(b.official) - Number(a.official) ||
    (b.installCount ?? 0) - (a.installCount ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Every query word must appear in the name, the description or the marketplace. Name matches rank first, then the
 * default order; a word that's in none of them can still match the name loosely (letters in order).
 */
export function searchPlugins(query: string, plugins: readonly MarketPlugin[], reviewedOnly = false): MarketPlugin[] {
  const pool = reviewedOnly ? plugins.filter(approved) : plugins;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...pool].sort(byDefault);
  const scored: { p: MarketPlugin; s: number }[] = [];
  for (const p of pool) {
    const name = p.name.toLowerCase();
    const rest = `${p.description ?? ""} ${p.review?.summary ?? ""} ${p.marketplace}`.toLowerCase();
    let s = 0;
    for (const w of words) {
      if (name === w) s += 30;
      else if (name.startsWith(w)) s += 20;
      else if (name.includes(w)) s += 12;
      else if (rest.includes(w)) s += 3;
      else {
        const loose = fuzzyScore(w, name);
        if (loose === null || words.length > 1) {
          s = -1;
          break;
        }
        s += 1;
      }
    }
    if (s >= 0) scored.push({ p, s });
  }
  return scored.sort((a, b) => b.s - a.s || byDefault(a.p, b.p)).map((x) => x.p);
}

export type ReviewBadge = { label: string; tone: "ok" | "warn"; title: string };

/** "Reviewed" only for a catalog item with its reviews; everything else is "Not reviewed" (ADR-0010). */
export function reviewBadge(p: MarketPlugin | undefined): ReviewBadge {
  const r = p?.review;
  if (r?.approved) {
    const n = r.reviews.length;
    return {
      label: "Reviewed",
      tone: "ok",
      title: `Reviewed by AgentChainer: ${r.tier}, ${n} review${n === 1 ? "" : "s"}`,
    };
  }
  if (r)
    return { label: "Not reviewed", tone: "warn", title: "In the AgentChainer catalog, still waiting for reviews" };
  return { label: "Not reviewed", tone: "warn", title: "Not reviewed by AgentChainer" };
}

/** A link to the plugin's source: on GitHub, the folder at the commit its marketplace pins. */
export function sourceLink(source: MarketPlugin["source"]): string | null {
  const url = source.url?.replace(/\.git$/, "").replace(/\/$/, "");
  if (!url?.startsWith("https://")) return null;
  if (!url.startsWith("https://github.com/")) return url;
  if (!source.sha && !source.path) return url;
  return `${url}/tree/${source.sha ?? "HEAD"}${source.path ? `/${source.path}` : ""}`;
}

/** Who publishes it, as far as the listing tells: Anthropic's own folder, or the source's GitHub owner. */
export function vendorOf(p: MarketPlugin): string | null {
  if (p.official && p.marketplace === "claude-plugins-official" && p.source.path?.startsWith("plugins/")) {
    return "Anthropic";
  }
  const owner = /^https:\/\/github\.com\/([^/]+)\//.exec(p.source.url ?? "")?.[1];
  return owner ?? null;
}

/** The description's first line, short enough for a list row. */
export function oneLiner(text: string | undefined, max = 140): string {
  const line = (text ?? "").split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Updates this workspace can apply (its own installs): the count on the Plugins nav entry. */
export const updateCount = (installed: readonly InstalledPlugin[]) =>
  installed.filter((i) => i.here && i.update).length;

/** The installed plugins, this workspace's first, each with its listing when the marketplaces still have it. */
export function installedRows(
  installed: readonly InstalledPlugin[],
  available: readonly MarketPlugin[],
): { installed: InstalledPlugin; plugin: MarketPlugin | undefined }[] {
  const byId = new Map(available.map((p) => [p.id, p]));
  return [...installed]
    .sort((a, b) => Number(b.here) - Number(a.here) || a.id.localeCompare(b.id))
    .map((i) => ({ installed: i, plugin: byId.get(i.id) }));
}

/** The default scope of an install: shared for a reviewed plugin, just you for any other (ADR-0010). */
export const defaultScope = (p: MarketPlugin | undefined): "project" | "local" =>
  p && approved(p) ? "project" : "local";
