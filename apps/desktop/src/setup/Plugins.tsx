import type { InstalledPlugin, MarketPlugin, Methods, PluginChange } from "@agentchainer/protocol";
import * as Tabs from "@radix-ui/react-tabs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type Confirm, Modal } from "../Dialog.tsx";
import { count, timeOfDay } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
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
      title: t("setup.plugins.uninstallTitle", { id: i.id }),
      body: scope === "local" ? t("setup.plugins.uninstallBodyLocal") : t("setup.plugins.uninstallBodyShared"),
      confirmLabel: t("setup.plugins.uninstall"),
      danger: true,
    });
    if (!ok) return;
    await change(async () => {
      await request("plugins.uninstall", { cwd, id: i.id, scope });
      return t("setup.plugins.uninstalled", { id: i.id });
    });
  }

  const total = data?.available.length ?? 0;
  return (
    <Tabs.Root className="plugins" value={tab} onValueChange={(v) => setTab(v as Tab)}>
      <div className="plugins-bar">
        <Tabs.List className="plugins-tabs" aria-label={t("setup.plugins.tabs")}>
          <Tabs.Trigger value="marketplace">{t("setup.plugins.marketplace")}</Tabs.Trigger>
          <Tabs.Trigger value="installed">
            {t("setup.plugins.installed")}
            {data && <span className="count">{data.installed.length}</span>}
          </Tabs.Trigger>
        </Tabs.List>
        {tab === "marketplace" && (
          <>
            <input
              type="search"
              className="plugins-search"
              aria-label={t("setup.plugins.search")}
              placeholder={total ? t("setup.plugins.searchCount", { n: count(total) }) : t("setup.plugins.search")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
            />
            <label className="check">
              <input type="checkbox" checked={reviewedOnly} onChange={(e) => setReviewedOnly(e.target.checked)} />
              {t("setup.plugins.reviewedOnly")}
            </label>
          </>
        )}
        <span className="grow" />
        {data && (
          <span className="muted plugins-fetched" title={t("setup.plugins.listedTitle")}>
            {t("setup.plugins.listed", { time: timeOfDay(data.fetchedAt) })}
          </span>
        )}
        <IconButton label={t("setup.plugins.refresh")} onClick={() => void load(true)}>
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
            {t("setup.plugins.dismiss")}
          </button>
        </div>
      )}
      {/* The tabs point at their panels (aria-controls), so the panels exist before there's a list, too. */}
      {!data &&
        (["marketplace", "installed"] as const).map((v) => (
          <Tabs.Content key={v} value={v}>
            {loading && <p className="muted setup-pad">{t("setup.plugins.asking")}</p>}
          </Tabs.Content>
        ))}

      {data && (
        <div className="plan-split">
          <div className="plan-list">
            <Tabs.Content value="marketplace">
              {matches.length === 0 ? (
                <EmptyState>{t("setup.plugins.noMatches")}</EmptyState>
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
                  {t("setup.plugins.showMore", { n: count(matches.length - shown) })}
                </button>
              )}
            </Tabs.Content>
            <Tabs.Content value="installed">
              {rows.length === 0 && <EmptyState>{t("setup.plugins.noneInstalled")}</EmptyState>}
              {[true, false].map((here) => {
                const group = rows.filter((r) => r.installed.here === here);
                if (!group.length) return null;
                return (
                  <section key={String(here)} className="plugin-group">
                    <h4 className="muted">
                      {here ? t("setup.plugins.thisWorkspace") : t("setup.plugins.allYourProjects")}
                    </h4>
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
          <section className="plan-detail" aria-label={t("setup.plugins.details")} tabIndex={0}>
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
                    return installed.enabled
                      ? t("setup.plugins.turnedOff", { id: installed.id })
                      : t("setup.plugins.turnedOn", { id: installed.id });
                  })
                }
                onUpdate={() =>
                  installed &&
                  void change(async () => {
                    const r = await updateWithConfirm(cwd, installed, confirm);
                    if (!r) return null;
                    setNotice({
                      text: t("setup.plugins.updated", {
                        id: installed.id,
                        version: r.version ?? t("setup.plugins.theListedVersion"),
                      }),
                      warnings: r.warnings,
                    });
                    return null;
                  })
                }
              />
            ) : (
              <EmptyState>
                {tab === "marketplace" ? t("setup.plugins.pickMarketplace") : t("setup.plugins.pickInstalled")}
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
              text: r.version
                ? t("setup.plugins.installedVersion", { id: installing.id, version: r.version })
                : t("setup.plugins.installedNotice", { id: installing.id }),
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
    title: t("setup.plugins.runCommandTitle"),
    body: <DeclaredCommand command={first.command} />,
    confirmLabel: t("setup.plugins.runAndUpdate"),
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
          {installed && !p
            ? t("setup.plugins.scope", { scope: installed.scope })
            : oneLiner(p?.description ?? p?.review?.summary)}
        </span>
      </button>
      <span className="plugin-badges">
        {installed?.update && <span className="badge tone-busy">{t("setup.plugins.badgeUpdate")}</span>}
        {installed && !installed.enabled && <span className="badge">{t("setup.plugins.badgeOff")}</span>}
        {installed && !installed.update && installed.enabled && (
          <span className="badge">{t("setup.plugins.installed")}</span>
        )}
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
        inv.hooks.length ? t("setup.plugins.hooks", { count: inv.hooks.length }) : null,
        inv.mcpServers.length ? t("setup.plugins.mcpServers", { count: inv.mcpServers.length }) : null,
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
        {i && !i.enabled && <span className="badge">{t("setup.plugins.offHere")}</span>}
      </div>
      {(p?.description || r?.summary) && <p>{p?.description ?? r?.summary}</p>}

      {!r?.approved && (
        <p className="callout">
          {[
            r ? t("setup.plugins.stillWaiting", { n: r.reviews.length }) : t("setup.plugins.notReviewedSentence"),
            t("setup.plugins.runsInside"),
            i ? null : t("setup.plugins.lookAtSource"),
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      {i?.update && (
        <p className="callout tone-busy">
          {t("setup.plugins.versionListed", { to: i.update.to, have: i.version ?? t("setup.plugins.anOlderOne") })}
          {i.update.reviewed === false && ` ${t("setup.plugins.newerThanReviewed")}`}
        </p>
      )}

      <dl className="action-facts">
        <dt>{t("setup.plugins.factPlugin")}</dt>
        <dd>
          <code>{id}</code>
        </dd>
        {vendor && (
          <>
            <dt>{t("setup.plugins.factPublishedBy")}</dt>
            <dd>{vendor}</dd>
          </>
        )}
        <dt>{t("setup.plugins.factVersion")}</dt>
        <dd>
          {[
            i?.version && t("setup.plugins.versionInstalled", { version: i.version, scope: i.scope }),
            p?.version && t("setup.plugins.versionListedShort", { version: p.version }),
            r?.reviewedVersion && t("setup.plugins.versionReviewed", { version: r.reviewedVersion }),
          ]
            .filter(Boolean)
            .join(" · ") || t("setup.plugins.notGiven")}
        </dd>
        {p && (
          <>
            <dt>{t("setup.plugins.marketplace")}</dt>
            <dd>
              {p.marketplace}{" "}
              <span className="muted">
                · {p.official ? t("setup.plugins.anthropic") : t("setup.plugins.addedByYou")}
              </span>
            </dd>
          </>
        )}
        {link && (
          <>
            <dt>{t("setup.plugins.factSource")}</dt>
            <dd>
              <WebLink href={link}>
                {link.replace(/^https:\/\//, "")} <ExternalLink size={12} />
              </WebLink>
              {!p?.source.sha && <span className="muted"> · {t("setup.plugins.notPinned")}</span>}
            </dd>
          </>
        )}
        {p?.installCount !== undefined && (
          <>
            <dt>{t("setup.plugins.factInstalls")}</dt>
            <dd>{count(p.installCount)}</dd>
          </>
        )}
        <dt>{t("setup.plugins.factLicense")}</dt>
        <dd>{r ? r.license : <span className="muted">{t("setup.plugins.licenseNotChecked")}</span>}</dd>
        {r && (
          <>
            <dt>{t("setup.plugins.factReview")}</dt>
            <dd>
              {r.tier} ·{" "}
              {r.reviews.length
                ? r.reviews.map((rv) => `${rv.by}, ${rv.date}`).join("; ")
                : t("setup.plugins.noReviewsYet")}
            </dd>
          </>
        )}
        {r && r.permissions.length > 0 && (
          <>
            <dt>{t("setup.plugins.factPermissions")}</dt>
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
          <h4>{t("setup.plugins.whatItBrings")}</h4>
          {detailsError && <p className="warn">{detailsError}</p>}
          {!details && !detailsError && <p className="muted">{t("setup.plugins.askingCli")}</p>}
          {inv && (
            <p className="plugin-counts">
              {[
                { kind: "skill", names: inv.skills, text: t("setup.plugins.skills", { count: inv.skills.length }) },
                { kind: "agent", names: inv.agents, text: t("setup.plugins.agents", { count: inv.agents.length }) },
                { kind: "hook", names: inv.hooks, text: t("setup.plugins.hooks", { count: inv.hooks.length }) },
                {
                  kind: "mcp",
                  names: inv.mcpServers,
                  text: t("setup.plugins.mcpServers", { count: inv.mcpServers.length }),
                },
                {
                  kind: "lsp",
                  names: inv.lspServers,
                  text: t("setup.plugins.lspServers", { count: inv.lspServers.length }),
                },
              ].map(({ kind, names, text }) => (
                <span key={kind} className="chip" title={names.join(", ")}>
                  {text}
                </span>
              ))}
              {details?.alwaysOnTokens !== undefined && (
                <span className="muted">{t("setup.plugins.alwaysOnTokens", { n: count(details.alwaysOnTokens) })}</span>
              )}
            </p>
          )}
          {runsCode.length > 0 && (
            <p className="callout">{t("setup.plugins.runsCode", { list: runsCode.join(", ") })}</p>
          )}
          {details && (
            <details>
              <summary className="muted">{t("setup.plugins.cliDetails")}</summary>
              <pre className="plugin-raw">{details.text}</pre>
            </details>
          )}
          <p className="field-help">{t("setup.plugins.settingsInTerminal")}</p>
          <p className="plugin-command">
            <code>{`claude plugin configure ${id}`}</code> <CopyButton text={`claude plugin configure ${id}`} />
          </p>
        </section>
      )}

      <div className="plugin-actions">
        {!i && p && (
          <button type="button" className="primary small" disabled={busy} onClick={onInstall}>
            {t("setup.plugins.installEllipsis")}
          </button>
        )}
        {i?.here && (
          <>
            {i.update && (
              <button type="button" className="primary small" disabled={busy} onClick={onUpdate}>
                {t("setup.plugins.updateTo", { version: i.update.to })}
              </button>
            )}
            <button type="button" className="secondary small" disabled={busy} onClick={onToggle}>
              {i.enabled ? t("setup.plugins.turnOff") : t("setup.plugins.turnOn")}
            </button>
            <button type="button" className="secondary small danger" disabled={busy} onClick={onUninstall}>
              {t("setup.plugins.uninstall")}
            </button>
          </>
        )}
        {i && !i.here && (
          <p className="field-help">
            <Rich
              k="setup.plugins.manageInTerminal"
              params={{ scope: i.scope, command: `claude plugin uninstall ${id} --scope ${i.scope}` }}
              tags={{ code: (s) => <code>{s}</code> }}
            />
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

function DeclaredCommand({ command }: { command: string }) {
  return (
    <>
      <p>{t("setup.plugins.declaredCommand")}</p>
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
      title={t("setup.plugins.installTitle", { name: p.name })}
      description={t("setup.plugins.installDescription")}
      actions={
        <>
          <button type="button" className="secondary" disabled={working} onClick={onClose}>
            {t("setup.plugins.cancel")}
          </button>
          <button
            type="button"
            className={pending || !reviewed ? "danger" : "primary"}
            disabled={working}
            onClick={() => void install()}
          >
            {working && <Loader2 size={14} className="spin" />}
            {pending
              ? t("setup.plugins.runAndInstall")
              : reviewed
                ? t("setup.plugins.install")
                : t("setup.plugins.installUnreviewed")}
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
                <Rich k="setup.plugins.unreviewedWarning" tags={{ strong: (s) => <strong>{s}</strong> }} />
              </p>
              <p>
                {t("setup.plugins.sourceAsListed", { marketplace: p.marketplace })}{" "}
                {link ? (
                  <WebLink href={link}>{link.replace(/^https:\/\//, "")}</WebLink>
                ) : (
                  <span className="muted">{t("setup.plugins.sourceNotGiven")}</span>
                )}
                {p.source.sha ? (
                  <>
                    {" "}
                    <Rich
                      k="setup.plugins.atCommit"
                      params={{ sha: p.source.sha.slice(0, 12) }}
                      tags={{ code: (s) => <code>{s}</code> }}
                    />
                  </>
                ) : (
                  <span className="muted"> {t("setup.plugins.notPinnedParen")}</span>
                )}
                .
              </p>
            </div>
          )}
          <fieldset className="plugin-scope">
            <legend className="field-label">{t("setup.plugins.installFor")}</legend>
            <label className="check">
              <input type="radio" name="scope" checked={scope === "local"} onChange={() => setScope("local")} />
              <span>
                {t("setup.plugins.justMe")}{" "}
                <span className="muted">
                  <Rich
                    k="setup.plugins.localScopeNote"
                    params={{ file: ".claude/settings.local.json" }}
                    tags={{ code: (s) => <code>{s}</code> }}
                  />
                </span>
              </span>
            </label>
            <label className="check">
              <input type="radio" name="scope" checked={scope === "project"} onChange={() => setScope("project")} />
              <span>
                {t("setup.plugins.theTeam")}{" "}
                <span className="muted">
                  <Rich
                    k="setup.plugins.projectScopeNote"
                    params={{ file: ".claude/settings.json" }}
                    tags={{ code: (s) => <code>{s}</code> }}
                  />
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
