import { realpathSync } from "node:fs";
import type { InstalledPlugin, MarketPlugin, MethodResult, PluginChange } from "@agentchainer/protocol";
import {
  forgetPlugin,
  type LockItem,
  pluginInstallFiles,
  pluginVersion,
  recordPluginInstall,
  setPluginVersion,
} from "./bootstrap/apply.ts";
import { type Catalog, type Item, REQUIRED_REVIEWS } from "./catalog/schema.ts";
import { itemText } from "./catalog/text.ts";
import { compareVersions } from "./catalog/updates.ts";
import { t } from "./i18n/index.ts";
import type { CliResult, PluginCli } from "./installer.ts";

/**
 * The Plugins page (UX-10, ADR-0010): every plugin the user's CLI lists, merged with the AgentChainer catalog's
 * reviews, and installs, updates and removals through that CLI. Only the CLI's JSON output is read, never its cache
 * files. Plugin options are never collected here: they can hold secrets, so the page points to
 * `claude plugin configure` in a terminal (ADR-0002).
 */

type Scope = "project" | "local" | "user";
type Listing = Omit<MethodResult<"plugins.list">, "installed">;

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** The catalog's plugin items by plugin id (`plugin@marketplace`). */
export function catalogPlugins(catalog: Catalog): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const item of catalog.items) {
    if (item.kind === "plugin" && item.source.type === "marketplace") {
      out.set(`${item.source.plugin}@${item.source.marketplace}`, item);
    }
  }
  return out;
}

export function reviewOf(item: Item): NonNullable<MarketPlugin["review"]> {
  return {
    itemId: item.id,
    approved: item.reviews.length >= REQUIRED_REVIEWS[item.tier],
    tier: item.tier,
    reviews: item.reviews.map((r) => ({ by: r.by, date: r.date, ...(r.notes ? { notes: r.notes } : {}) })),
    ...(item.source.type === "marketplace" && item.source.reviewedVersion
      ? { reviewedVersion: item.source.reviewedVersion }
      : {}),
    license: item.license,
    risk: item.risk,
    // In the app's language (X-13); the review records stay as their reviewers wrote them.
    permissions: itemText(item).permissions,
    summary: itemText(item).summary,
    ...(item.homepage ? { homepage: item.homepage } : {}),
  };
}

/**
 * The marketplaces the CLI has configured. Anthropic's are official: `claude-plugins-official` from the
 * `anthropics` GitHub org, and the directory built into the CLI, which isn't in this list at all.
 */
export function parseMarketplaces(json: unknown): Listing["marketplaces"] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((m) => {
    const o = asObject(m);
    const name = str(o?.name);
    if (!o || !name) return [];
    const repo = str(o.repo);
    return [{ name, ...(repo ? { repo } : {}), official: repo?.startsWith("anthropics/") ?? false }];
  });
}

const BUILT_IN = "anthropic-plugin-directory";

/** Where a listed plugin comes from, with a marketplace-relative folder resolved against the marketplace's repo. */
function sourceOf(raw: unknown, marketplaceRepo: string | undefined): MarketPlugin["source"] {
  if (typeof raw === "string") {
    const path = raw.replace(/^\.\//, "");
    return marketplaceRepo ? { url: `https://github.com/${marketplaceRepo}`, path } : { path };
  }
  const o = asObject(raw);
  if (!o) return {};
  const repo = str(o.repo);
  const url = str(o.url) ?? (repo ? `https://github.com/${repo}` : undefined);
  const path = str(o.path);
  const sha = str(o.sha);
  return { ...(url ? { url } : {}), ...(path ? { path } : {}), ...(sha ? { sha } : {}) };
}

/** `claude plugin list --available --json`, merged with the catalog's reviews. */
export function parseAvailable(json: unknown, marketplaces: Listing["marketplaces"], catalog: Catalog): MarketPlugin[] {
  const list = asObject(json)?.available;
  if (!Array.isArray(list)) return [];
  const known = new Map(marketplaces.map((m) => [m.name, m]));
  const reviewed = catalogPlugins(catalog);
  return list.flatMap((p) => {
    const o = asObject(p);
    const name = str(o?.name);
    const marketplace = str(o?.marketplaceName);
    if (!o || !name || !marketplace) return [];
    const id = str(o.pluginId) ?? `${name}@${marketplace}`;
    const m = known.get(marketplace);
    const official = m ? m.official : marketplace === BUILT_IN;
    // A review only counts for Anthropic's marketplace: a marketplace someone added could reuse its name.
    const item = official ? reviewed.get(id) : undefined;
    return [
      {
        id,
        name,
        marketplace,
        ...(str(o.description) ? { description: str(o.description) } : {}),
        ...(str(o.version) ? { version: str(o.version) } : {}),
        ...(typeof o.installCount === "number" ? { installCount: o.installCount } : {}),
        source: sourceOf(o.source, m?.repo),
        official,
        ...(item ? { review: reviewOf(item) } : {}),
      },
    ];
  });
}

const samePath = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
};

/**
 * `claude plugin list --json`: the user's plugins and this workspace's. Other projects' installs are left out. A newer
 * version in the listing is an update; it's never applied without a click (ADR-0005 §8).
 */
export function parseInstalled(json: unknown, root: string, available: MarketPlugin[]): InstalledPlugin[] {
  if (!Array.isArray(json)) return [];
  const listed = new Map(available.map((p) => [p.id, p]));
  return json.flatMap((p) => {
    const o = asObject(p);
    const id = str(o?.id);
    const scope = str(o?.scope);
    if (!o || !id || (scope !== "user" && scope !== "project" && scope !== "local" && scope !== "managed")) return [];
    const projectPath = str(o.projectPath);
    const here = scope === "project" || scope === "local";
    if (here && projectPath && !samePath(projectPath, root)) return [];
    const version = str(o.version);
    const next = listed.get(id);
    const newer =
      version && next?.version && compareVersions(next.version, version) > 0
        ? {
            to: next.version,
            reviewed: next.review ? next.review.approved && next.review.reviewedVersion === next.version : null,
          }
        : undefined;
    return [
      {
        id,
        ...(version ? { version } : {}),
        scope,
        // `projectEnabled` is about the shared settings file only; a local install reports it false while it's on.
        enabled: o.enabled !== false,
        ...(str(o.installedAt) ? { installedAt: str(o.installedAt) } : {}),
        here,
        ...(newer ? { update: newer } : {}),
      },
    ];
  });
}

const INVENTORY: [string, keyof NonNullable<MethodResult<"plugins.details">["inventory"]>][] = [
  ["Skills", "skills"],
  ["Agents", "agents"],
  ["Hooks", "hooks"],
  ["MCP servers", "mcpServers"],
  ["LSP servers", "lspServers"],
];

/**
 * Reads the counts out of `claude plugin details`, which has no JSON mode. The text is always returned as it is, so
 * when its format changes the page shows the text instead of wrong counts.
 */
export function parseDetails(raw: string): MethodResult<"plugins.details"> {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes, in case the CLI ever adds them when piped.
  const text = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  const out: MethodResult<"plugins.details"> = { text };
  if (/^Component inventory$/m.test(text)) {
    const inventory = { skills: [], agents: [], hooks: [], mcpServers: [], lspServers: [] } as NonNullable<
      MethodResult<"plugins.details">["inventory"]
    >;
    for (const [label, key] of INVENTORY) {
      const m = new RegExp(`^[ \\t]*${label} \\((\\d+)\\)[ \\t]*([^\\n]*)$`, "m").exec(text);
      if (!m) continue;
      const count = Number(m[1]);
      const names = (m[2] ?? "").split(/,\s*/).filter(Boolean);
      inventory[key] = names.length === count ? names : Array.from({ length: count }, (_, i) => `${label} ${i + 1}`);
    }
    out.inventory = inventory;
  }
  const tokens = /Always-on:\s*[~<]?\s*([\d,]+)\s*tok/.exec(text);
  if (tokens?.[1]) out.alwaysOnTokens = Number(tokens[1].replace(/,/g, ""));
  return out;
}

/**
 * The command a marketplace declares for a plugin (a command-source install, or the helper that fetches its archive),
 * which the CLI refuses to run until a person confirms it by its sha256.
 */
export function confirmOf(res: CliResult): { command: string; sha256: string } | null {
  const shown = asObject(asObject(res.json)?.shownCommand);
  const sha256 = str(shown?.sha256);
  if (!shown || !sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const cmd = shown.command;
  const command =
    typeof cmd === "string" ? cmd : Array.isArray(cmd) ? cmd.map(String).join(" ") : JSON.stringify(shown);
  const archive = str(shown.archiveUrl);
  return { command: archive ? t("plugins.confirm.fetches", { command, archive }) : command, sha256 };
}

export function cliError(what: string, res: CliResult): Error {
  const message = str(asObject(res.json)?.message) ?? (res.stderr || res.stdout).trim();
  return new Error(t("plugins.cli.failed", { command: what, detail: message.slice(0, 400) || `exit ${res.status}` }));
}

/** The listing, kept per workspace for the app session: it takes the CLI a few seconds. */
const listings = new Map<string, Listing>();

async function listing(root: string, cli: PluginCli, catalog: Catalog, refresh: boolean): Promise<Listing> {
  const kept = listings.get(root);
  if (kept && !refresh) return kept;
  const [available, mk] = await Promise.all([cli.available(), cli.marketplaces()]);
  if (!available.ok) throw cliError("claude plugin list --available", available);
  const marketplaces = parseMarketplaces(mk.json);
  const fresh: Listing = {
    available: parseAvailable(available.json, marketplaces, catalog),
    marketplaces: [
      ...marketplaces,
      ...(marketplaces.some((m) => m.name === BUILT_IN) ? [] : [{ name: BUILT_IN, official: true }]),
    ],
    fetchedAt: new Date().toISOString(),
  };
  listings.set(root, fresh);
  return fresh;
}

export async function listPluginsFor(
  root: string,
  cli: PluginCli,
  catalog: Catalog,
  refresh = false,
): Promise<MethodResult<"plugins.list">> {
  const [l, installed] = await Promise.all([listing(root, cli, catalog, refresh), cli.installed()]);
  if (!installed.ok) throw cliError("claude plugin list", installed);
  return { ...l, installed: parseInstalled(installed.json, root, l.available) };
}

/** The version the CLI reports after an install or update, from its result or else from its list. */
async function versionAfter(cli: PluginCli, res: CliResult, id: string): Promise<string | undefined> {
  const v = str(asObject(res.json)?.installedVersion);
  return v ?? pluginVersion((await cli.installed()).json, id);
}

function reviewedWarning(item: Item | undefined, version: string | undefined): string[] {
  const src = item?.source;
  if (src?.type !== "marketplace" || !src.reviewedVersion || !version || version === src.reviewedVersion) return [];
  return [t("plugins.review.versionMoved", { version, reviewed: src.reviewedVersion })];
}

/**
 * Installs a plugin for this workspace and records it as a History run. A plugin the catalog approved is recorded
 * like a setup step; any other is recorded as unreviewed, with the source its marketplace listed (ADR-0010).
 */
export async function installListed(
  root: string,
  cli: PluginCli,
  catalog: Catalog,
  id: string,
  scope: Scope,
  acceptCommand?: string,
): Promise<PluginChange> {
  const [plugin = "", marketplace = ""] = id.split("@");
  const item = catalogPlugins(catalog).get(id);
  const approved = item ? reviewOf(item).approved : false;
  const listed = (listings.get(root) ?? (await listing(root, cli, catalog, false))).available.find((p) => p.id === id);
  // What the CLI did, filled in by the install below.
  const out: { confirm?: PluginChange; version?: string; warnings: string[] } = { warnings: [] };
  const runId = await recordPluginInstall(
    root,
    { id: `plugin:${id}`, title: t("plugins.install.title", { name: item?.name ?? plugin }), scope },
    async () => {
      const res = await cli.install(id, scope, acceptCommand);
      if (!res.ok) {
        const c = confirmOf(res);
        if (c) {
          out.confirm = { status: "confirm", ...c };
          return null;
        }
        throw cliError("claude plugin install", res);
      }
      out.version = await versionAfter(cli, res, id);
      out.warnings = approved ? reviewedWarning(item, out.version) : [];
      const installed = {
        scope,
        installedAt: new Date().toISOString(),
        ...(out.version ? { version: out.version } : {}),
      };
      const lock: LockItem =
        item && approved
          ? { id: item.id, kind: item.kind, tier: item.tier, source: item.source, ...installed }
          : {
              id,
              kind: "plugin",
              tier: "unreviewed",
              source: { type: "listed", marketplace, plugin, ...listed?.source },
              ...installed,
            };
      return { pluginId: id, lock, warnings: out.warnings };
    },
    catalog.version,
  );
  if (out.confirm) return out.confirm;
  return {
    status: "done",
    ...(out.version ? { version: out.version } : {}),
    warnings: out.warnings,
    ...(runId ? { runId } : {}),
  };
}

export async function updateListed(
  root: string,
  cli: PluginCli,
  catalog: Catalog,
  id: string,
  scope: Scope,
  acceptCommand?: string,
): Promise<PluginChange> {
  const res = await cli.update(id, scope, acceptCommand);
  if (!res.ok) {
    const c = confirmOf(res);
    if (c) return { status: "confirm", ...c };
    throw cliError("claude plugin update", res);
  }
  const version = await versionAfter(cli, res, id);
  if (version) setPluginVersion(root, id, version);
  const item = catalogPlugins(catalog).get(id);
  const warnings = item && reviewOf(item).approved ? reviewedWarning(item, version) : [];
  return { status: "done", ...(version ? { version } : {}), warnings };
}

/**
 * Uninstalls through the CLI. When the settings file is still as the page's install left it, it goes back to how it was
 * before (the CLI would leave an empty `enabledPlugins` behind); the lockfile entry goes, and History shows the install
 * rolled back.
 */
export async function uninstallListed(root: string, cli: PluginCli, id: string, scope: Scope): Promise<void> {
  const restore = pluginInstallFiles(root, id, scope);
  const res = await cli.uninstall(id, scope);
  if (!res.ok) throw cliError("claude plugin uninstall", res);
  restore?.();
  forgetPlugin(root, id, scope);
}
