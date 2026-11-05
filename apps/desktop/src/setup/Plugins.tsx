import type { InstalledPlugin, MarketPlugin, Methods, PluginChange } from "@agentchainer/protocol";
import * as Tabs from "@radix-ui/react-tabs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type Confirm, Modal } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";
import { RiskPill } from "./PlanView.tsx";
import {
  defaultScope,
  installedRows,
  oneLiner,
  PAGE,
  reviewBadge,
  searchPlugins,
  sourceLink,
  updateCount,
  vendorOf,
} from "./pluginList.ts";

type Listing = Methods["plugins.list"]["result"];
type Details = Methods["plugins.details"]["result"];
type Scope = "project" | "local";
type Tab = "marketplace" | "installed";

/**
 * Workspace settings → Plugins (UX-10, ADR-0010), laid out like Android Studio's: Marketplace and Installed tabs, a
 * search, the list on the left and the selected plugin on the right. Everything comes from the user's own CLI, which
 * lists the reviewed catalog's plugins and every other plugin its marketplaces carry; only the catalog's approved
 * items are marked reviewed. Installs are per workspace and show in History.
 */
export function Plugins({
  cwd,
  confirm,
  onChanged,
  onUpdates,
}: {
  cwd: string;
  confirm: Confirm;
  /** After an install or removal: History and the setup plan reload. */
  onChanged: () => void;
  /** Updates this workspace can apply, for the nav entry's count. */
  onUpdates: (count: number) => void;
}) {
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("marketplace");
  const [query, setQuery] = useState("");
  const [reviewedOnly, setReviewedOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<string | null>(null);
  const [installing, setInstalling] = useState<MarketPlugin | null>(null);
  const [notice, setNotice] = useState<{ text: string; warnings: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const next = await request("plugins.list", { cwd, ...(refresh ? { refresh: true } : {}) });
        setData(next);
        onUpdates(updateCount(next.installed));
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [cwd, onUpdates],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const matches = useMemo(
    () => (data ? searchPlugins(query, data.available, reviewedOnly) : []),
    [data, query, reviewedOnly],
  );
  const rows = useMemo(() => (data ? installedRows(data.installed, data.available) : []), [data]);
  const installedById = useMemo(() => new Map(data?.installed.map((i) => [i.id, i]) ?? []), [data]);
  const plugin = data?.available.find((p) => p.id === selected);
  const installed = selected ? installedById.get(selected) : undefined;

  /** Runs a change, then reloads the installed list (the listing itself stays). */
  async function change(what: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      const text = await what();
      if (text) setNotice({ text, warnings: [] });
      onChanged();
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(i: InstalledPlugin) {
    const scope = i.scope as Scope;
    const ok = await confirm({
      title: `Uninstall ${i.id}?`,
      body: `Claude Code removes it from this workspace's ${scope === "local" ? "local" : "shared"} settings. Its History entry shows it as rolled back.`,
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (!ok) return;
    await change(async () => {
      await request("plugins.uninstall", { cwd, id: i.id, scope });
      return `Uninstalled ${i.id}.`;
    });
  }

  const total = data?.available.length ?? 0;
  return (
    <Tabs.Root className="plugins" value={tab} onValueChange={(v) => setTab(v as Tab)}>
      <div className="plugins-bar">
        <Tabs.List className="plugins-tabs" aria-label="Plugins">
          <Tabs.Trigger value="marketplace">Marketplace</Tabs.Trigger>
          <Tabs.Trigger value="installed">
            Installed
            {data && <span className="count">{data.installed.length}</span>}
          </Tabs.Trigger>
        </Tabs.List>
        {tab === "marketplace" && (
          <>
            <input
              type="search"
              className="plugins-search"
              aria-label="Search plugins"
              placeholder={total ? `Search ${total.toLocaleString()} plugins` : "Search plugins"}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
            />
            <label className="check">
              <input type="checkbox" checked={reviewedOnly} onChange={(e) => setReviewedOnly(e.target.checked)} />
              Reviewed only
            </label>
          </>
        )}
        <span className="grow" />
        {data && (
          <span className="muted plugins-fetched" title="When the CLI last listed the marketplaces">
            Listed {new Date(data.fetchedAt).toLocaleTimeString()}
          </span>
        )}
        <IconButton label="Refresh: the CLI updates its marketplaces" onClick={() => void load(true)}>
          {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        </IconButton>
      </div>

      {error && <p className="warn setup-pad">{error}</p>}
      {notice && (
        <div className="outcome-banner">
          <div className="grow">
            <p>{notice.text}</p>
            {notice.warnings.map((w) => (
              <p key={w} className="warn">
                {w}
              </p>
            ))}
          </div>
          <button type="button" className="ghost small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      {/* The tabs point at their panels (aria-controls), so the panels exist before there's a list, too. */}
      {!data &&
        (["marketplace", "installed"] as const).map((v) => (
          <Tabs.Content key={v} value={v}>
            {loading && <p className="muted setup-pad">Asking your Claude CLI for its marketplaces…</p>}
          </Tabs.Content>
        ))}

      {data && (
        <div className="plan-split">
          <div className="plan-list">
            <Tabs.Content value="marketplace">
              {matches.length === 0 ? (
                <EmptyState>No plugin matches.</EmptyState>
              ) : (
                <ul className="plugin-rows">
                  {matches.slice(0, shown).map((p) => (
                    <PluginRow
                      key={p.id}
                      plugin={p}
                      installed={installedById.get(p.id)}
                      focused={p.id === selected}
                      onFocus={() => setSelected(p.id)}
                    />
                  ))}
                </ul>
              )}
              {matches.length > shown && (
                <button type="button" className="ghost small plugins-more" onClick={() => setShown((n) => n + PAGE)}>
                  Show more ({(matches.length - shown).toLocaleString()} left)
                </button>
              )}
            </Tabs.Content>
            <Tabs.Content value="installed">
              {rows.length === 0 && (
                <EmptyState>No plugins installed for this workspace or for all your projects.</EmptyState>
              )}
              {[true, false].map((here) => {
                const group = rows.filter((r) => r.installed.here === here);
                if (!group.length) return null;
                return (
                  <section key={String(here)} className="plugin-group">
                    <h4 className="muted">{here ? "This workspace" : "All your projects"}</h4>
                    <ul className="plugin-rows">
                      {group.map((r) => (
                        <PluginRow
                          key={`${r.installed.id}:${r.installed.scope}`}
                          plugin={r.plugin}
                          id={r.installed.id}
                          installed={r.installed}
                          focused={r.installed.id === selected}
                          onFocus={() => setSelected(r.installed.id)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </Tabs.Content>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable, so the keyboard can scroll it (PlanView). */}
          <section className="plan-detail" aria-label="Details" tabIndex={0}>
            {selected ? (
              <PluginDetails
                cwd={cwd}
                id={selected}
                plugin={plugin}
                installed={installed}
                busy={busy}
                onInstall={() => plugin && setInstalling(plugin)}
                onUninstall={() => installed && void uninstall(installed)}
                onToggle={() =>
                  installed &&
                  void change(async () => {
                    await request("plugins.setEnabled", {
                      cwd,
                      id: installed.id,
                      scope: installed.scope as Scope,
                      enabled: !installed.enabled,
                    });
                    return `Turned ${installed.id} ${installed.enabled ? "off" : "on"} in this workspace.`;
                  })
                }
                onUpdate={() =>
                  installed &&
                  void change(async () => {
                    const r = await updateWithConfirm(cwd, installed, confirm);
                    if (!r) return null;
                    setNotice({
                      text: `Updated ${installed.id} to ${r.version ?? "the listed version"}.`,
                      warnings: r.warnings,
                    });
                    return null;
                  })
                }
              />
            ) : (
              <EmptyState>
                {tab === "marketplace"
                  ? "Pick a plugin to see what it is, who publishes it, and whether AgentChainer reviewed it."
                  : "Pick an installed plugin to update, turn off or uninstall it."}
              </EmptyState>
            )}
          </section>
        </div>
      )}

      {installing && (
        <InstallDialog
          cwd={cwd}
          plugin={installing}
          onClose={() => setInstalling(null)}
          onInstalled={(r) => {
            setInstalling(null);
            setNotice({
              text: `Installed ${installing.id}${r.version ? ` ${r.version}` : ""}. It's in History.`,
              warnings: r.warnings,
            });
            onChanged();
            void load();
          }}
        />
      )}
    </Tabs.Root>
  );
}

/** An update, asking again when the marketplace declares a command it runs. Null when the person said no. */
async function updateWithConfirm(
  cwd: string,
  i: InstalledPlugin,
  confirm: Confirm,
): Promise<Extract<PluginChange, { status: "done" }> | null> {
  const scope = i.scope as Scope;
  const first = await request("plugins.update", { cwd, id: i.id, scope });
  if (first.status === "done") return first;
  const ok = await confirm({
    title: "Run the marketplace's command?",
    body: <DeclaredCommand command={first.command} />,
    confirmLabel: "Run it and update",
    danger: true,
  });
  if (!ok) return null;
  const second = await request("plugins.update", { cwd, id: i.id, scope, acceptCommand: first.sha256 });
  return second.status === "done" ? second : null;
}

function PluginRow({
  plugin: p,
  id,
  installed,
  focused,
  onFocus,
}: {
  plugin: MarketPlugin | undefined;
  id?: string;
  installed: InstalledPlugin | undefined;
  focused: boolean;
  onFocus: () => void;
}) {
  const badge = reviewBadge(p);
  return (
    <li className={`plan-row${focused ? " focused" : ""}`}>
      <button type="button" className="plan-row-main" aria-current={focused} onClick={onFocus}>
        <span className="plan-title">{p?.name ?? id}</span>
        <span className="plan-meta">
          {installed && !p ? `${installed.scope} scope` : oneLiner(p?.description ?? p?.review?.summary)}
        </span>
      </button>
      <span className="plugin-badges">
        {installed?.update && <span className="badge tone-busy">Update</span>}
        {installed && !installed.enabled && <span className="badge">Off</span>}
        {installed && !installed.update && installed.enabled && <span className="badge">Installed</span>}
        <span className={`badge tone-${badge.tone}`} title={badge.title}>
          {badge.label}
        </span>
      </span>
    </li>
  );
}

function PluginDetails({
  cwd,
  id,
  plugin: p,
  installed: i,
  busy,
  onInstall,
  onUninstall,
  onToggle,
  onUpdate,
}: {
  cwd: string;
  id: string;
  plugin: MarketPlugin | undefined;
  installed: InstalledPlugin | undefined;
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onToggle: () => void;
  onUpdate: () => void;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const version = i?.version;
  useEffect(() => {
    setDetails(null);
    setDetailsError(null);
    if (!version) return;
    let live = true;
    request("plugins.details", { cwd, id })
      .then((d) => live && setDetails(d))
      .catch((err) => live && setDetailsError(String(err)));
    return () => {
      live = false;
    };
  }, [cwd, id, version]);

  const badge = reviewBadge(p);
  const r = p?.review;
  const link = p ? sourceLink(p.source) : null;
  const vendor = p ? vendorOf(p) : null;
  const inv = details?.inventory;
  const runsCode = inv
    ? [
        inv.hooks.length ? plural(inv.hooks.length, "hook") : null,
        inv.mcpServers.length ? plural(inv.mcpServers.length, "MCP server") : null,
      ].filter(Boolean)
    : [];
  return (
    <div className="action-details">
      <div className="action-head">
        <h3>{p?.name ?? id}</h3>
        <span className={`badge tone-${badge.tone}`} title={badge.title}>
          {badge.label}
        </span>
        {r?.approved && <RiskPill risk={r.risk} />}
        {i && !i.enabled && <span className="badge">Off in this workspace</span>}
      </div>
      {(p?.description || r?.summary) && <p>{p?.description ?? r?.summary}</p>}

      {!r?.approved && (
        <p className="callout">
          {r
            ? `In the AgentChainer catalog, but still waiting for its reviews (${r.reviews.length} so far).`
            : "Not reviewed by AgentChainer."}{" "}
          A plugin runs inside your Claude sessions in this workspace: its skills, hooks and MCP servers can run
          commands with your permissions.{i ? "" : " Look at its source before you install it."}
        </p>
      )}
      {i?.update && (
        <p className="callout tone-busy">
          Version {i.update.to} is listed (you have {i.version ?? "an older one"}).
          {i.update.reviewed === false && " It's newer than the version AgentChainer reviewed."}
        </p>
      )}

      <dl className="action-facts">
        <dt>Plugin</dt>
        <dd>
          <code>{id}</code>
        </dd>
        {vendor && (
          <>
            <dt>Published by</dt>
            <dd>{vendor}</dd>
          </>
        )}
        <dt>Version</dt>
        <dd>
          {[
            i?.version && `${i.version} installed (${i.scope} scope)`,
            p?.version && `${p.version} listed`,
            r?.reviewedVersion && `${r.reviewedVersion} reviewed`,
          ]
            .filter(Boolean)
            .join(" · ") || "Not given"}
        </dd>
        {p && (
          <>
            <dt>Marketplace</dt>
            <dd>
              {p.marketplace} <span className="muted">· {p.official ? "Anthropic" : "added by you"}</span>
            </dd>
          </>
        )}
        {link && (
          <>
            <dt>Source</dt>
            <dd>
              <WebLink href={link}>
                {link.replace(/^https:\/\//, "")} <ExternalLink size={12} />
              </WebLink>
              {!p?.source.sha && <span className="muted"> · not pinned to a commit</span>}
            </dd>
          </>
        )}
        {p?.installCount !== undefined && (
          <>
            <dt>Installs</dt>
            <dd>{p.installCount.toLocaleString()}</dd>
          </>
        )}
        <dt>License</dt>
        <dd>{r ? r.license : <span className="muted">Not checked: see the source</span>}</dd>
        {r && (
          <>
            <dt>Review</dt>
            <dd>
              {r.tier} ·{" "}
              {r.reviews.length ? r.reviews.map((rv) => `${rv.by}, ${rv.date}`).join("; ") : "no reviews yet"}
            </dd>
          </>
        )}
        {r && r.permissions.length > 0 && (
          <>
            <dt>What it can do</dt>
            <dd>
              <ul className="plain-list">
                {r.permissions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      {i && (
        <section className="plugin-inventory">
          <h4>What it brings</h4>
          {detailsError && <p className="warn">{detailsError}</p>}
          {!details && !detailsError && <p className="muted">Asking the CLI…</p>}
          {inv && (
            <p className="plugin-counts">
              {(
                [
                  ["skill", inv.skills],
                  ["agent", inv.agents],
                  ["hook", inv.hooks],
                  ["MCP server", inv.mcpServers],
                  ["LSP server", inv.lspServers],
                ] as const
              ).map(([noun, names]) => (
                <span key={noun} className="chip" title={names.join(", ")}>
                  {plural(names.length, noun)}
                </span>
              ))}
              {details?.alwaysOnTokens !== undefined && (
                <span className="muted">~{details.alwaysOnTokens.toLocaleString()} tokens in every session</span>
              )}
            </p>
          )}
          {runsCode.length > 0 && <p className="callout">Runs code on your machine: {runsCode.join(", ")}.</p>}
          {details && (
            <details>
              <summary className="muted">The CLI's details</summary>
              <pre className="plugin-raw">{details.text}</pre>
            </details>
          )}
          <p className="field-help">
            Settings, if it has any, are set in a terminal, so they never pass through AgentChainer:
          </p>
          <p className="plugin-command">
            <code>claude plugin configure {id}</code> <CopyButton text={`claude plugin configure ${id}`} />
          </p>
        </section>
      )}

      <div className="plugin-actions">
        {!i && p && (
          <button type="button" className="primary small" disabled={busy} onClick={onInstall}>
            Install…
          </button>
        )}
        {i?.here && (
          <>
            {i.update && (
              <button type="button" className="primary small" disabled={busy} onClick={onUpdate}>
                Update to {i.update.to}
              </button>
            )}
            <button type="button" className="secondary small" disabled={busy} onClick={onToggle}>
              {i.enabled ? "Turn off" : "Turn on"}
            </button>
            <button type="button" className="secondary small danger" disabled={busy} onClick={onUninstall}>
              Uninstall
            </button>
          </>
        )}
        {i && !i.here && (
          <p className="field-help">
            Installed for all your projects ({i.scope} scope). Manage it in a terminal:{" "}
            <code>
              claude plugin uninstall {id} --scope {i.scope}
            </code>
          </p>
        )}
        {busy && <Loader2 size={14} className="spin" />}
      </div>
    </div>
  );
}

/** Opens in the user's browser: the webview doesn't navigate away. */
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function DeclaredCommand({ command }: { command: string }) {
  return (
    <>
      <p>The marketplace declares a command that runs while the plugin is fetched. Run it only if you trust it:</p>
      <pre className="plugin-raw">{command}</pre>
    </>
  );
}

/**
 * Install…: the scope, and for a plugin AgentChainer hasn't reviewed, what that means and where it comes from
 * (ADR-0010). When the marketplace declares a command, the dialog shows it and asks again.
 */
function InstallDialog({
  cwd,
  plugin: p,
  onClose,
  onInstalled,
}: {
  cwd: string;
  plugin: MarketPlugin;
  onClose: () => void;
  onInstalled: (r: Extract<PluginChange, { status: "done" }>) => void;
}) {
  const [scope, setScope] = useState<Scope>(defaultScope(p));
  const [pending, setPending] = useState<{ command: string; sha256: string } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewed = p.review?.approved === true;
  const link = sourceLink(p.source);

  async function install() {
    setWorking(true);
    setError(null);
    try {
      const r = await request("plugins.install", {
        cwd,
        id: p.id,
        scope,
        ...(pending ? { acceptCommand: pending.sha256 } : {}),
      });
      if (r.status === "confirm") setPending({ command: r.command, sha256: r.sha256 });
      else onInstalled(r);
    } catch (err) {
      setError(String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !working && onClose()}
      title={`Install ${p.name}`}
      description="Claude Code installs it from its marketplace. It's recorded in History, where Roll back removes it."
      actions={
        <>
          <button type="button" className="secondary" disabled={working} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={pending || !reviewed ? "danger" : "primary"}
            disabled={working}
            onClick={() => void install()}
          >
            {working && <Loader2 size={14} className="spin" />}
            {pending ? "Run it and install" : reviewed ? "Install" : "Install unreviewed plugin"}
          </button>
        </>
      }
    >
      {pending ? (
        <DeclaredCommand command={pending.command} />
      ) : (
        <>
          {!reviewed && (
            <div className="callout">
              <p>
                <strong>AgentChainer hasn't reviewed this plugin.</strong> It will run inside your Claude sessions in
                this workspace, and its hooks and MCP servers can run commands with your permissions.
              </p>
              <p>
                Source, as {p.marketplace} lists it:{" "}
                {link ? (
                  <WebLink href={link}>{link.replace(/^https:\/\//, "")}</WebLink>
                ) : (
                  <span className="muted">not given</span>
                )}
                {p.source.sha ? (
                  <>
                    {" "}
                    at <code>{p.source.sha.slice(0, 12)}</code>
                  </>
                ) : (
                  <span className="muted"> (not pinned to a commit)</span>
                )}
                .
              </p>
            </div>
          )}
          <fieldset className="plugin-scope">
            <legend className="field-label">Install for</legend>
            <label className="check">
              <input type="radio" name="scope" checked={scope === "local"} onChange={() => setScope("local")} />
              <span>
                Just me{" "}
                <span className="muted">
                  (local scope: <code>.claude/settings.local.json</code>, not committed)
                </span>
              </span>
            </label>
            <label className="check">
              <input type="radio" name="scope" checked={scope === "project"} onChange={() => setScope("project")} />
              <span>
                The team{" "}
                <span className="muted">
                  (project scope: <code>.claude/settings.json</code>, committed with the repository)
                </span>
              </span>
            </label>
          </fieldset>
        </>
      )}
      {error && <p className="warn">{error}</p>}
    </Modal>
  );
}
