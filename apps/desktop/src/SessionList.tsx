import type { SessionInfo } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { approxUsd, dateTime } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
import { request } from "./sidecar.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";

/** From the local cost history (M1-33), kept by the Rust core. */
type SessionCost = { sessionId: string; totalCostUsd: number };
type Summary = { todayUsd: number; last7Usd: number; last30Usd: number; uncountedTurns: number };

const usd = (v: number) => approxUsd(v, v < 1 ? 4 : 2);

type Editing = { sessionId: string; field: "title" | "tag"; value: string };

/**
 * Stored sessions of a workspace, through the SDK session APIs (M1-21/M1-22). Sessions started in the terminal CLI show
 * up here too and can be resumed. Cost per session needs the local cost history (M1-33).
 */
export function SessionList({
  cwd,
  openIds,
  onOpen,
  confirm,
}: {
  cwd: string;
  /** Sessions already open in a tab: they switch to that tab instead, and can't be deleted. */
  openIds: Set<string>;
  onOpen: (session: SessionInfo) => void;
  confirm: Confirm;
}) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [retention, setRetention] = useState<{ days: number; source: string } | null>(null);
  const [costs, setCosts] = useState<Map<string, number>>(new Map());
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const refresh = useCallback(async () => {
    if (!cwd) return;
    try {
      const [list, kept, sessionCosts, spend] = await Promise.all([
        request("session.list", { cwd }),
        request("session.retention", { cwd }),
        // The history is optional: without it the list still works.
        invoke<SessionCost[]>("cost_sessions", { cwd }).catch(() => []),
        invoke<Summary>("cost_summary", { cwd, now: Date.now() }).catch(() => null),
      ]);
      setSessions(list.sessions);
      setRetention(kept);
      setCosts(new Map(sessionCosts.map((c) => [c.sessionId, c.totalCostUsd])));
      setSummary(spend);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  // The path may still be typed, so wait for a pause before asking the SDK.
  useEffect(() => {
    setSessions(null);
    const timer = setTimeout(() => void refresh(), 400);
    return () => clearTimeout(timer);
  }, [refresh]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function saveEdit(edit: Editing) {
    setEditing(null);
    if (edit.field === "title") {
      if (edit.value.trim())
        await run(() => request("session.rename", { cwd, sessionId: edit.sessionId, title: edit.value }));
    } else {
      await run(() => request("session.tag", { cwd, sessionId: edit.sessionId, tag: edit.value.trim() || null }));
    }
  }

  async function fork(s: SessionInfo) {
    try {
      const { sessionId } = await request("session.fork", { cwd, sessionId: s.sessionId });
      await refresh();
      onOpen({
        ...s,
        sessionId,
        title: t("shell.sessionList.forkTitle", { title: s.title }),
        lastModified: Date.now(),
      });
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove(s: SessionInfo) {
    const ok = await confirm({
      title: t("shell.sessionList.deleteTitle"),
      body: <p>{t("shell.sessionList.deleteBody", { title: s.title })}</p>,
      confirmLabel: t("shell.sessionList.deleteConfirm"),
      danger: true,
    });
    if (ok) await run(() => request("session.delete", { cwd, sessionId: s.sessionId }));
  }

  if (!cwd) return null;
  return (
    <section className="card session-list" aria-labelledby="previous-title">
      <div className="card-title">
        <h2 id="previous-title">{t("shell.sessionList.title")}</h2>
      </div>
      {error && <p className="warn">{error}</p>}
      {sessions === null ? (
        <p className="muted">{t("shell.sessionList.loading")}</p>
      ) : sessions.length === 0 ? (
        <p className="muted">{t("shell.sessionList.empty")}</p>
      ) : (
        <ul>
          {sessions.map((s) => {
            const open = openIds.has(s.sessionId);
            const edit = editing?.sessionId === s.sessionId ? editing : null;
            return (
              <li key={s.sessionId}>
                <div className="session-main">
                  <div className="session-title-row">
                    {edit ? (
                      <input
                        // biome-ignore lint/a11y/noAutofocus: the field appears because the user just asked to edit it.
                        autoFocus
                        value={edit.value}
                        aria-label={
                          edit.field === "title" ? t("shell.sessionList.titleLabel") : t("shell.sessionList.tagLabel")
                        }
                        placeholder={edit.field === "tag" ? t("shell.sessionList.tagPlaceholder") : ""}
                        onChange={(e) => setEditing({ ...edit, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit(edit);
                          if (e.key === "Escape") setEditing(null);
                        }}
                        onBlur={() => void saveEdit(edit)}
                      />
                    ) : (
                      <span className="session-title" title={s.title}>
                        {s.title}
                      </span>
                    )}
                    {s.tag && <span className="badge">{s.tag}</span>}
                    {open && <span className="badge">{t("shell.sessionList.open")}</span>}
                  </div>
                  <span className="session-meta">
                    {dateTime(s.lastModified)}
                    {s.gitBranch ? ` · ${s.gitBranch}` : ""}
                    {costs.has(s.sessionId) ? ` · ${usd(costs.get(s.sessionId) ?? 0)}` : ""}
                  </span>
                </div>
                <div className="session-actions">
                  <button type="button" className="secondary small" onClick={() => onOpen(s)}>
                    {open ? t("shell.sessionList.show") : t("shell.sessionList.resume")}
                  </button>
                  <ActionMenu
                    label={t("shell.sessionList.actions", { title: s.title })}
                    items={[
                      { label: t("shell.sessionList.fork"), onSelect: () => void fork(s) },
                      {
                        label: t("shell.sessionList.rename"),
                        onSelect: () => setEditing({ sessionId: s.sessionId, field: "title", value: s.title }),
                      },
                      {
                        label: t("shell.sessionList.tag"),
                        onSelect: () => setEditing({ sessionId: s.sessionId, field: "tag", value: s.tag ?? "" }),
                      },
                      {
                        label: open ? t("shell.sessionList.deleteOpen") : t("shell.sessionList.delete"),
                        danger: true,
                        disabled: open,
                        onSelect: () => void remove(s),
                      },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {summary && summary.last30Usd + summary.uncountedTurns > 0 && (
        <p className="muted small-print">
          {t("shell.sessionList.spent", {
            today: usd(summary.todayUsd),
            week: usd(summary.last7Usd),
            month: usd(summary.last30Usd),
          })}
          {summary.uncountedTurns > 0 && ` · ${t("shell.sessionList.uncounted", { n: summary.uncountedTurns })}`}
        </p>
      )}
      {retention && (
        <p className="muted small-print">
          <Rich
            k="shell.sessionList.retention"
            params={{
              days: retention.days,
              source:
                retention.source === "default"
                  ? t("shell.sessionList.retentionDefault")
                  : t("shell.sessionList.retentionSetIn", { source: retention.source }),
              setting: "cleanupPeriodDays",
              file: "~/.claude/settings.json",
            }}
            tags={{ code: (s) => <code>{s}</code> }}
          />
        </p>
      )}
    </section>
  );
}
