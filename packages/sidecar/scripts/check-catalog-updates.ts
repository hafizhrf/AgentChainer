// The upstream-update bot (M2-04, docs/CATALOG.md §8): checks every catalog item's upstream and, for each one that
// moved, bumps its pin in catalog/items/<id>.yaml with hashes computed here, and clears its reviews (ADR-0005: a new
// upstream version is reviewed again). Writes a markdown summary for the pull request.
// - marketplace plugins: changes under the plugin's folder since `reviewedRef` → the marketplace's current commit;
// - git sources: changes under `path` since `ref` → the default branch's commit, with a new tree hash;
// - release assets and npm: the newest stable version at least 14 days old, with hashes from the downloads.
//
// Usage: node packages/sidecar/scripts/check-catalog-updates.ts [--dry-run] [--summary <file>] [--catalog <dir>]
// GITHUB_TOKEN (read-only use) avoids the GitHub API's anonymous rate limit. The workflow then rebuilds the catalog
// and snapshots, and opens the PR (.github/workflows/catalog-updates.yml).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { fetchGitHubTree, treeHash } from "../src/bootstrap/git-source.ts";
import { type Item, ItemSchema } from "../src/catalog/schema.ts";
import {
  bumpItemYaml,
  type Candidate,
  catalogVersion,
  newestEligible,
  rewriteAssetUrl,
} from "../src/catalog/updates.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const summaryAt = args.indexOf("--summary");
const summaryFile = summaryAt >= 0 ? args[summaryAt + 1] : undefined;
const catalogAt = args.indexOf("--catalog");
// --catalog <dir> checks another copy (used to test the bump path against older pins).
const catalogDir =
  catalogAt >= 0
    ? path.resolve(args[catalogAt + 1] ?? ".")
    : fileURLToPath(new URL("../../../catalog/", import.meta.url));
const headers: Record<string, string> = {
  accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function gh<T>(route: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${route}`, { headers });
  if (!res.ok) throw new Error(`GitHub ${route}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const repoOf = (url: string) =>
  new URL(url.includes("://") ? url : `https://github.com/${url}`).pathname.replace(/^\/|\.git$/g, "");
const sha256 = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createHash("sha256")
    .update(new Uint8Array(await res.arrayBuffer()))
    .digest("hex");
};

type Compare = { files?: { filename: string }[]; html_url: string };
type Update = {
  id: string;
  from: string;
  to: string;
  changes: [(string | number)[], unknown][];
  link: string;
  note: string;
};

/** Commits since `ref` on the default branch that touched files under `dir` (or anything, for ""). */
async function changesSince(repo: string, ref: string, dir: string) {
  const { default_branch } = await gh<{ default_branch: string }>(`repos/${repo}`);
  const head = (await gh<{ sha: string }>(`repos/${repo}/commits/${default_branch}`)).sha;
  if (head === ref) return { head, files: [] as string[], link: "" };
  const cmp = await gh<Compare>(`repos/${repo}/compare/${ref}...${head}`);
  const prefix = dir.replace(/^\.\//, "").replace(/\/?$/, "/");
  const files = (cmp.files ?? []).map((f) => f.filename).filter((f) => !dir || dir === "." || f.startsWith(prefix));
  return { head, files, link: cmp.html_url };
}

async function check(item: Item): Promise<Update | null> {
  const src = item.source;
  if (src.type === "marketplace") {
    const repo = repoOf(src.repo);
    const market = await gh<{ content: string }>(`repos/${repo}/contents/.claude-plugin/marketplace.json`);
    const plugins = (
      JSON.parse(Buffer.from(market.content, "base64").toString("utf8")) as {
        plugins: { name: string; source: unknown }[];
      }
    ).plugins;
    const entry = plugins.find((p) => p.name === src.plugin);
    if (!entry || typeof entry.source !== "string") return null;
    const { head, files, link } = await changesSince(repo, src.reviewedRef, entry.source);
    if (files.length === 0) return null;
    let version: string | undefined;
    try {
      const manifest = await gh<{ content: string }>(
        `repos/${repo}/contents/${entry.source.replace(/^\.\//, "")}/.claude-plugin/plugin.json?ref=${head}`,
      );
      version = (JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8")) as { version?: string }).version;
    } catch {
      // no plugin manifest: the version stays as reviewed
    }
    return {
      id: item.id,
      from: `${src.reviewedVersion ?? ""} @ ${src.reviewedRef.slice(0, 7)}`.trim(),
      to: `${version ?? src.reviewedVersion ?? ""} @ ${head.slice(0, 7)}`.trim(),
      changes: [
        [["source", "reviewedRef"], head],
        ...(version ? ([[["source", "reviewedVersion"], version]] as Update["changes"]) : []),
      ],
      link,
      note: `${files.length} file(s) changed in ${entry.source}`,
    };
  }
  if (src.type === "git") {
    const repo = repoOf(src.repo);
    const { head, files, link } = await changesSince(repo, src.ref, src.path);
    if (files.length === 0) return null;
    const tree = await fetchGitHubTree(src.repo, head, src.path);
    try {
      return {
        id: item.id,
        from: src.ref.slice(0, 7),
        to: head.slice(0, 7),
        changes: [
          [["source", "ref"], head],
          [["source", "sha256"], treeHash(tree.dir)],
        ],
        link,
        note: `${files.length} file(s) changed in ${src.path}`,
      };
    } finally {
      tree.cleanup();
    }
  }
  if (src.type === "release-asset") {
    const repo = repoOf(src.repo);
    const releases = await gh<
      {
        tag_name: string;
        published_at: string;
        prerelease: boolean;
        assets: { browser_download_url: string; digest?: string }[];
      }[]
    >(`repos/${repo}/releases?per_page=30`);
    const candidates: Candidate[] = releases
      .filter((r) => !r.prerelease)
      .map((r) => ({ version: r.tag_name.replace(/^v/, ""), publishedAt: r.published_at }));
    const next = newestEligible(candidates, src.version, new Date());
    if (!next) return null;
    const release = releases.find((r) => r.tag_name.replace(/^v/, "") === next.version);
    const changes: Update["changes"] = [[["source", "version"], next.version]];
    for (const [platform, asset] of Object.entries(src.assets)) {
      const url = rewriteAssetUrl(asset.url, src.version, next.version);
      const published = release?.assets.find((a) => a.browser_download_url === url);
      if (!published) throw new Error(`${item.id} ${next.version}: no asset at ${url}; update the item by hand`);
      const hash = await sha256(url);
      const digest = published.digest?.replace(/^sha256:/, "");
      if (digest && digest !== hash)
        throw new Error(`${item.id} ${next.version} ${platform}: download and GitHub digest differ`);
      changes.push([["source", "assets", platform, "url"], url], [["source", "assets", platform, "sha256"], hash]);
    }
    return {
      id: item.id,
      from: src.version,
      to: next.version,
      changes,
      link: `https://github.com/${repo}/compare/${releases.find((r) => r.tag_name.replace(/^v/, "") === src.version)?.tag_name ?? src.version}...${release?.tag_name ?? next.version}`,
      note: `release ${next.publishedAt.slice(0, 10)}`,
    };
  }
  if (src.type === "npm") {
    const res = await fetch(`https://registry.npmjs.org/${src.name.replace("/", "%2F")}`);
    if (!res.ok) throw new Error(`npm ${src.name}: HTTP ${res.status}`);
    const meta = (await res.json()) as {
      time: Record<string, string>;
      versions: Record<string, { dist: { integrity: string } }>;
    };
    const candidates = Object.keys(meta.versions).map((version) => ({
      version,
      publishedAt: meta.time[version] ?? "",
    }));
    const next = newestEligible(candidates, src.version, new Date());
    if (!next) return null;
    return {
      id: item.id,
      from: src.version,
      to: next.version,
      changes: [
        [["source", "version"], next.version],
        [["source", "integrity"], meta.versions[next.version]?.dist.integrity ?? ""],
      ],
      link: `https://www.npmjs.com/package/${src.name}/v/${next.version}`,
      note: `published ${next.publishedAt.slice(0, 10)}`,
    };
  }
  return null;
}

const updates: Update[] = [];
const failures: string[] = [];
for (const file of readdirSync(path.join(catalogDir, "items"))
  .filter((f) => f.endsWith(".yaml"))
  .sort()) {
  const full = path.join(catalogDir, "items", file);
  const text = readFileSync(full, "utf8");
  const item = ItemSchema.parse(parse(text));
  try {
    const update = await check(item);
    if (!update) {
      console.log(`up to date  ${item.id}`);
      continue;
    }
    updates.push(update);
    console.log(`update      ${item.id}: ${update.from} → ${update.to} (${update.note})`);
    if (dryRun) continue;
    let next = bumpItemYaml(text, update.changes);
    // npm items name their exact version in the steps too (`@x/mcp@1.2.3`).
    if (item.source.type === "npm")
      next = next.split(`${item.source.name}@${update.from}`).join(`${item.source.name}@${update.to}`);
    writeFileSync(full, next);
  } catch (err) {
    failures.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`FAILED      ${item.id}: ${failures.at(-1)}`);
  }
}

if (updates.length && !dryRun) {
  const versionFile = path.join(catalogDir, "catalog.yaml");
  const text = readFileSync(versionFile, "utf8");
  writeFileSync(versionFile, text.replace(/^version: .*$/m, `version: "${catalogVersion(new Date())}"`));
}

if (summaryFile) {
  const rows = updates.map(
    (u) => `| \`${u.id}\` | ${u.from} | ${u.to} | ${u.note} | ${u.link ? `[diff](${u.link})` : ""} |`,
  );
  writeFileSync(
    summaryFile,
    [
      "Upstream updates found by the weekly catalog check (M2-04). Pins and hashes were computed in CI.",
      "",
      `**Every bumped item has its reviews cleared**: review each one against [CATALOG §4](https://github.com/${process.env.GITHUB_REPOSITORY ?? "hafizhrf/AgentChainer"}/blob/main/docs/CATALOG.md#4-review-checklist-adding-or-updating-an-item), summarize the upstream diff here, and add the reviews before merging.`,
      "",
      "| Item | From | To | What changed | Upstream |",
      "|---|---|---|---|---|",
      ...rows,
      ...(failures.length ? ["", "Couldn't check:", ...failures.map((f) => `- ${f}`)] : []),
      "",
    ].join("\n"),
  );
}
console.log(
  `${updates.length} update(s)${failures.length ? `, ${failures.length} failure(s)` : ""}${dryRun ? " (dry run: nothing written)" : ""}`,
);
// Nothing found and something couldn't be checked: fail the run, so a broken check doesn't look like "up to date".
if (failures.length && updates.length === 0) process.exit(1);
