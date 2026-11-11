import type { McpServer, McpServerDetails, Methods } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  Download,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type Confirm, Modal } from "../Dialog.tsx";
import { timeOfDay } from "../i18n/format.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { isMac } from "../options.ts";
import { request } from "../sidecar.ts";
import { CopyButton } from "../ui/CopyButton.tsx";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";
import { shellLine } from "./mcpCommand.ts";

type Listing = Methods["mcp.list"]["result"];
type Scope = "local" | "project" | "user";
type Transport = "stdio" | "http" | "sse";

/**
 * Workspace settings → MCP servers (CP-02, ADR-0015): the servers the user's own CLI knows here, each checked, with
 * adding, checking again and removing through that CLI. Nothing secret passes through the page: variables and
 * headers are names and `${NAME}` references, and signing in to a server happens in the user's own terminal.
 */
export function McpServers({ cwd, confirm, onChanged }: { cwd: string; confirm: Confirm; onChanged: () => void }) {
  const [data, setData] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        setData(await request("mcp.list", { cwd, ...(refresh ? { refresh: true } : {}) }));
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** A server checked again: its row takes the fresh status. */
  const checked = useCallback((d: McpServerDetails) => {
    setData(
      (cur) =>
        cur && {
          ...cur,
          servers: cur.servers.map((s) =>
            s.name === d.name
              ? { ...s, status: d.status, statusText: d.statusText, ...(d.target ? { target: d.target } : {}) }
              : s,
          ),
        },
    );
  }, []);

  const yours = data?.servers.filter((s) => !s.managedBy) ?? [];
  const managed = data?.servers.filter((s) => s.managedBy) ?? [];
  const server = data?.servers.find((s) => s.name === selected);

  async function remove(d: McpServerDetails) {
    const scope = d.scope as Scope;
    const ok = await confirm({
      title: t("setup.mcp.removeTitle", { name: d.name }),
      body:
        scope === "project"
          ? t("setup.mcp.removeBodyShared")
          : scope === "user"
            ? t("setup.mcp.removeBodyUser")
            : t("setup.mcp.removeBodyLocal"),
      confirmLabel: t("setup.mcp.remove"),
      danger: true,
    });
    if (!ok) return;
    try {
      await request("mcp.remove", { cwd, name: d.name, scope });
      setNotice(t("setup.mcp.removed", { name: d.name }));
      setSelected(null);
      onChanged();
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="plugins mcp-servers">
      <div className="plugins-bar mcp-bar">
        <button type="button" className="primary small" onClick={() => setAdding(true)}>
          <Plus size={14} />
          {t("setup.mcp.add")}
        </button>
        {isMac && (
          <button type="button" className="secondary small" onClick={() => setImporting(true)}>
            <Download size={14} />
            {t("setup.mcp.import")}
          </button>
        )}
        <span className="grow" />
        {data && (
          <span className="muted plugins-fetched" title={t("setup.mcp.checkedTitle")}>
            {t("setup.mcp.checked", { time: timeOfDay(data.checkedAt) })}
          </span>
        )}
        <IconButton label={t("setup.mcp.refresh")} onClick={() => void load(true)}>
          {loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        </IconButton>
      </div>

      {error && <p className="warn setup-pad">{error}</p>}
      {notice && (
        <div className="outcome-banner">
          <p className="grow">{notice}</p>
          <button type="button" className="ghost small" onClick={() => setNotice(null)}>
            {t("setup.mcp.dismiss")}
          </button>
        </div>
      )}
      {!data && loading && <p className="muted setup-pad">{t("setup.mcp.checking")}</p>}

      {data && (
        <div className="plan-split">
          <div className="plan-list">
            {data.servers.length === 0 && <EmptyState>{t("setup.mcp.none")}</EmptyState>}
            {[
              { title: t("setup.mcp.groupYours"), servers: yours },
              { title: t("setup.mcp.groupManaged"), servers: managed },
            ].map(
              (g) =>
                g.servers.length > 0 && (
                  <section key={g.title} className="plugin-group">
                    <h4 className="muted">{g.title}</h4>
                    <ul className="plugin-rows">
                      {g.servers.map((s) => (
                        <ServerRow
                          key={s.name}
                          server={s}
                          focused={s.name === selected}
                          onFocus={() => setSelected(s.name)}
                        />
                      ))}
                    </ul>
                  </section>
                ),
            )}
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable, so the keyboard can scroll it (PlanView). */}
          <section className="plan-detail" aria-label={t("setup.mcp.details")} tabIndex={0}>
            {server ? (
              <ServerDetails
                key={server.name}
                cwd={cwd}
                server={server}
                onChecked={checked}
                onRemove={(d) => void remove(d)}
              />
            ) : (
              <EmptyState>{t("setup.mcp.pick")}</EmptyState>
            )}
          </section>
        </div>
      )}

      {adding && (
        <AddDialog
          cwd={cwd}
          taken={new Set(yours.map((s) => s.name))}
          onClose={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            setNotice(t("setup.mcp.added", { name }));
            onChanged();
            void load().then(() => setSelected(name));
          }}
        />
      )}
      {importing && (
        <ImportDialog
          cwd={cwd}
          onClose={(refresh) => {
            setImporting(false);
            if (refresh) void load(true);
          }}
        />
      )}
    </div>
  );
}

const STATUS: Record<McpServer["status"], { tone: string; icon: ReactNode; label: () => string }> = {
  connected: { tone: "tone-ok", icon: <CircleCheck size={12} />, label: () => t("setup.mcp.statusConnected") },
  failed: { tone: "tone-err", icon: <CircleX size={12} />, label: () => t("setup.mcp.statusFailed") },
  needsAuth: { tone: "tone-warn", icon: <KeyRound size={12} />, label: () => t("setup.mcp.statusNeedsAuth") },
  pending: { tone: "tone-busy", icon: <Clock size={12} />, label: () => t("setup.mcp.statusPending") },
  unknown: { tone: "", icon: <CircleHelp size={12} />, label: () => t("setup.mcp.statusUnknown") },
};

/** The status as an icon and words, never color alone. */
function StatusBadge({ status }: { status: McpServer["status"] }) {
  const s = STATUS[status];
  return (
    <span className={`badge mcp-status ${s.tone}`}>
      {s.icon}
      {s.label()}
    </span>
  );
}

function ServerRow({ server: s, focused, onFocus }: { server: McpServer; focused: boolean; onFocus: () => void }) {
  return (
    <li className={`plan-row${focused ? " focused" : ""}`}>
      <button type="button" className="plan-row-main" aria-current={focused} onClick={onFocus}>
        <span className="plan-title">{s.name}</span>
        <span className="plan-meta mcp-target">{s.target}</span>
      </button>
      <span className="plugin-badges">
        <StatusBadge status={s.status} />
      </span>
    </li>
  );
}

/** A name with a space ("claude.ai Example") quoted, for a command to paste. */
const arg = (name: string) => (/^[\w.:@/-]+$/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`);

/** A command to run in the user's own terminal, opened in the workspace folder. */
function TerminalCommand({ cwd, command }: { cwd: string; command: string }) {
  return (
    <div className="plugin-command mcp-command">
      <code>{command}</code>
      <CopyButton text={command} />
      <button type="button" className="secondary small" onClick={() => void invoke("open_terminal", { dir: cwd })}>
        <SquareTerminal size={14} />
        {t("setup.mcp.openTerminal")}
      </button>
    </div>
  );
}

function ServerDetails({
  cwd,
  server: s,
  onChecked,
  onRemove,
}: {
  cwd: string;
  server: McpServer;
  onChecked: (d: McpServerDetails) => void;
  onRemove: (d: McpServerDetails) => void;
}) {
  const [details, setDetails] = useState<McpServerDetails | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const d = await request("mcp.get", { cwd, name: s.name });
      setDetails(d);
      onChecked(d);
    } catch (err) {
      setError(String(err));
    } finally {
      setChecking(false);
    }
  }, [cwd, s.name, onChecked]);

  useEffect(() => {
    void check();
  }, [check]);

  const status = details?.status ?? s.status;
  const statusText = details?.statusText ?? s.statusText;
  const scope = details?.scope;
  const removable = !s.managedBy && (scope === "local" || scope === "project" || scope === "user");
  return (
    <div className="action-details">
      <div className="action-head">
        <h3>{s.name}</h3>
        {checking ? (
          <span className="badge mcp-status">
            <Loader2 size={12} className="spin" />
            {t("setup.mcp.statusChecking")}
          </span>
        ) : (
          <StatusBadge status={status} />
        )}
      </div>

      {s.managedBy && (
        <p className="callout">{s.managedBy === "plugin" ? t("setup.mcp.fromPlugin") : t("setup.mcp.fromClaudeAi")}</p>
      )}
      {(status === "failed" || status === "unknown") && statusText && <p className="warn">{statusText}</p>}
      {s.warnings.map((w) => (
        <p key={w} className="warn">
          {w}
        </p>
      ))}
      {error && <p className="warn">{error}</p>}

      {status === "needsAuth" && (
        <section className="mcp-help">
          <p className="field-help">{t("setup.mcp.signInHelp")}</p>
          <TerminalCommand cwd={cwd} command={`claude mcp login ${arg(s.name)}`} />
        </section>
      )}
      {status === "pending" && (
        <section className="mcp-help">
          <p className="field-help">{t("setup.mcp.pendingHelp")}</p>
          <TerminalCommand cwd={cwd} command="claude" />
        </section>
      )}

      <dl className="action-facts">
        <dt>{t("setup.mcp.factScope")}</dt>
        <dd>{scope ? scopeLabel(scope, details?.scopeText ?? "") : <span className="muted">…</span>}</dd>
        <dt>{t("setup.mcp.factTransport")}</dt>
        <dd>{transportLabel(details?.transport ?? s.transport)}</dd>
        {s.target && (
          <>
            <dt>{s.transport === "stdio" ? t("setup.mcp.factCommand") : t("setup.mcp.factUrl")}</dt>
            <dd>
              <code className="mcp-target-full">{details?.target || s.target}</code>
            </dd>
          </>
        )}
        {details && details.env.length > 0 && (
          <>
            <dt>{t("setup.mcp.factEnv")}</dt>
            <dd>
              <Names names={details.env} />
            </dd>
          </>
        )}
        {details && details.headers.length > 0 && (
          <>
            <dt>{t("setup.mcp.factHeaders")}</dt>
            <dd>
              <Names names={details.headers} />
            </dd>
          </>
        )}
      </dl>
      {details && (details.env.length > 0 || details.headers.length > 0) && (
        <p className="field-help">{t("setup.mcp.valuesHidden")}</p>
      )}

      <div className="plugin-actions">
        <button type="button" className="secondary small" disabled={checking} onClick={() => void check()}>
          <RefreshCw size={14} />
          {t("setup.mcp.checkAgain")}
        </button>
        {removable && details && (
          <button
            type="button"
            className="secondary small danger"
            disabled={checking}
            onClick={() => onRemove(details)}
          >
            <Trash2 size={14} />
            {t("setup.mcp.removeEllipsis")}
          </button>
        )}
      </div>
    </div>
  );
}

function Names({ names }: { names: string[] }) {
  return (
    <span className="mcp-names">
      {names.map((n) => (
        <code key={n}>{n}</code>
      ))}
    </span>
  );
}

function scopeLabel(scope: McpServerDetails["scope"], text: string): string {
  if (scope === "local") return t("setup.mcp.scopeLocal");
  if (scope === "project") return t("setup.mcp.scopeProject");
  if (scope === "user") return t("setup.mcp.scopeUser");
  return text;
}

function transportLabel(transport: McpServer["transport"]): string {
  if (transport === "stdio") return t("setup.mcp.transportStdio");
  if (transport === "http") return "HTTP";
  if (transport === "sse") return "SSE";
  return t("setup.mcp.transportOther");
}

type Draft = {
  name: string;
  transport: Transport;
  command: string;
  env: string;
  url: string;
  headers: { name: string; value: string }[];
  scope: Scope;
};

/**
 * Add server…: the server, then the exact command that will run, before anything runs. AgentChainer hasn't reviewed
 * what's added here (like an unreviewed plugin, ADR-0010), so the dialog says so; it's recorded in History.
 */
function AddDialog({
  cwd,
  taken,
  onClose,
  onAdded,
}: {
  cwd: string;
  taken: Set<string>;
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    name: "",
    transport: "stdio",
    command: "",
    env: "",
    url: "",
    headers: [],
    scope: "local",
  });
  const [command, setCommand] = useState<string[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };

  const nameProblem = !draft.name
    ? null
    : !/^[A-Za-z0-9_][\w-]{0,63}$/.test(draft.name)
      ? t("setup.mcp.nameRule")
      : taken.has(draft.name)
        ? t("setup.mcp.nameTaken", { name: draft.name })
        : null;
  const stdio = draft.transport === "stdio";
  const ready = Boolean(draft.name) && !nameProblem && (stdio ? draft.command.trim() : draft.url.trim());

  const params = (dryRun: boolean) => ({
    cwd,
    name: draft.name,
    scope: draft.scope,
    transport: draft.transport,
    ...(stdio
      ? { command: draft.command, env: draft.env.split(/[\s,]+/).filter(Boolean) }
      : { url: draft.url, headers: draft.headers.filter((h) => h.name.trim() || h.value.trim()) }),
    ...(dryRun ? { dryRun: true } : {}),
  });

  async function next() {
    setWorking(true);
    setError(null);
    try {
      if (!command) setCommand((await request("mcp.add", params(true))).command);
      else {
        await request("mcp.add", params(false));
        onAdded(draft.name);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open
      size="lg"
      onOpenChange={(open) => !open && !working && onClose()}
      title={t("setup.mcp.addTitle")}
      description={command ? t("setup.mcp.reviewDescription") : t("setup.mcp.addDescription")}
      actions={
        <>
          <button
            type="button"
            className="secondary"
            disabled={working}
            onClick={() => (command ? setCommand(null) : onClose())}
          >
            {command ? t("setup.mcp.back") : t("setup.mcp.cancel")}
          </button>
          <button
            type="button"
            className={command ? "danger" : "primary"}
            disabled={working || !ready}
            onClick={() => void next()}
          >
            {working && <Loader2 size={14} className="spin" />}
            {command ? t("setup.mcp.addServer") : t("setup.mcp.next")}
          </button>
        </>
      }
    >
      {command ? (
        <>
          <p>{t("setup.mcp.willRun")}</p>
          <pre className="plugin-raw">{shellLine(command)}</pre>
          <p className="field-help">{t("setup.mcp.historyNote")}</p>
        </>
      ) : (
        <form
          className="mcp-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !working) void next();
          }}
        >
          <div className="callout">
            <p>
              <Rich k="setup.mcp.unreviewedWarning" tags={{ strong: (s) => <strong>{s}</strong> }} />
            </p>
          </div>
          <div className="field-row">
            <Field label={t("setup.mcp.name")} help={nameProblem ?? t("setup.mcp.nameHelp")}>
              <input
                value={draft.name}
                onChange={(e) => set({ name: e.target.value.trim() })}
                placeholder={t("setup.mcp.namePlaceholder")}
                aria-invalid={nameProblem ? true : undefined}
                spellCheck={false}
              />
            </Field>
            <Field label={t("setup.mcp.transport")}>
              <fieldset className="segmented">
                <legend className="sr-only">{t("setup.mcp.transport")}</legend>
                {(["stdio", "http", "sse"] as const).map((tr) => (
                  <button
                    key={tr}
                    type="button"
                    className={draft.transport === tr ? "active" : undefined}
                    aria-pressed={draft.transport === tr}
                    onClick={() => set({ transport: tr })}
                  >
                    {transportLabel(tr)}
                  </button>
                ))}
              </fieldset>
            </Field>
          </div>
          {stdio ? (
            <>
              <Field label={t("setup.mcp.command")} help={t("setup.mcp.commandHelp")}>
                <input
                  value={draft.command}
                  onChange={(e) => set({ command: e.target.value })}
                  placeholder={t("setup.mcp.commandPlaceholder")}
                  spellCheck={false}
                />
              </Field>
              <Field label={t("setup.mcp.env")} help={t("setup.mcp.envHelp")}>
                <input
                  value={draft.env}
                  onChange={(e) => set({ env: e.target.value })}
                  placeholder={t("setup.mcp.envPlaceholder")}
                  spellCheck={false}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label={t("setup.mcp.url")}>
                <input
                  type="url"
                  value={draft.url}
                  onChange={(e) => set({ url: e.target.value.trim() })}
                  placeholder={t("setup.mcp.urlPlaceholder")}
                  spellCheck={false}
                />
              </Field>
              <fieldset className="mcp-headers">
                <legend className="field-label">{t("setup.mcp.headers")}</legend>
                {draft.headers.map((h, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until they're typed in.
                  <div key={i} className="mcp-header-row">
                    <input
                      aria-label={t("setup.mcp.headerName")}
                      value={h.name}
                      placeholder={t("setup.mcp.headerNamePlaceholder")}
                      spellCheck={false}
                      onChange={(e) =>
                        set({ headers: draft.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })
                      }
                    />
                    <input
                      aria-label={t("setup.mcp.headerValue")}
                      value={h.value}
                      placeholder={t("setup.mcp.headerValuePlaceholder")}
                      spellCheck={false}
                      onChange={(e) =>
                        set({ headers: draft.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })
                      }
                    />
                    <IconButton
                      label={t("setup.mcp.removeHeader")}
                      onClick={() => set({ headers: draft.headers.filter((_, j) => j !== i) })}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost small mcp-add-header"
                  onClick={() => set({ headers: [...draft.headers, { name: "", value: "" }] })}
                >
                  <Plus size={14} />
                  {t("setup.mcp.addHeader")}
                </button>
                <span className="field-help">{t("setup.mcp.headersHelp")}</span>
              </fieldset>
            </>
          )}
          <ScopeChoice scope={draft.scope} onChange={(scope) => set({ scope })} />
        </form>
      )}
      {error && <p className="warn">{error}</p>}
    </Modal>
  );
}

function ScopeChoice({ scope, onChange }: { scope: Scope; onChange: (scope: Scope) => void }) {
  const option = (value: Scope, label: string, note: MessageKey, file: string) => (
    <label className="check">
      <input type="radio" name="mcp-scope" checked={scope === value} onChange={() => onChange(value)} />
      <span>
        {label}{" "}
        <span className="muted">
          <Rich k={note} params={{ file }} tags={{ code: (s) => <code>{s}</code> }} />
        </span>
      </span>
    </label>
  );
  return (
    <fieldset className="plugin-scope">
      <legend className="field-label">{t("setup.mcp.addFor")}</legend>
      {option("local", t("setup.mcp.scopeLocal"), "setup.mcp.scopeLocalNote", "~/.claude.json")}
      {option("project", t("setup.mcp.scopeProject"), "setup.mcp.scopeProjectNote", ".mcp.json")}
      {option("user", t("setup.mcp.scopeUser"), "setup.mcp.scopeUserNote", "~/.claude.json")}
    </fieldset>
  );
}

/**
 * Import from Claude Desktop: the CLI's own importer, run in the user's terminal, where it asks which servers to
 * bring. AgentChainer never reads Claude Desktop's config.
 */
function ImportDialog({ cwd, onClose }: { cwd: string; onClose: (refresh: boolean) => void }) {
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose(false)}
      title={t("setup.mcp.importTitle")}
      description={t("setup.mcp.importDescription")}
      actions={
        <>
          <button type="button" className="secondary" onClick={() => onClose(false)}>
            {t("setup.mcp.close")}
          </button>
          <button type="button" className="primary" onClick={() => onClose(true)}>
            {t("setup.mcp.importDone")}
          </button>
        </>
      }
    >
      <TerminalCommand cwd={cwd} command="claude mcp add-from-claude-desktop" />
      <p className="field-help">
        <Rich
          k="setup.mcp.importScopes"
          params={{ project: "--scope project", user: "--scope user" }}
          tags={{ code: (s) => <code>{s}</code> }}
        />
      </p>
      <p className="field-help">{t("setup.mcp.importNotHistory")}</p>
    </Modal>
  );
}
