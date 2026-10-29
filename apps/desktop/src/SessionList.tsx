import type { SessionInfo } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { request } from "./sidecar.ts";

/** From the local cost history (M1-33), kept by the Rust core. */
type SessionCost = { sessionId: string; totalCostUsd: number };
type Summary = { todayUsd: number; last7Usd: number; last30Usd: number; uncountedTurns: number };

const usd = (v: number) => `≈$${v.toFixed(v < 1 ? 4 : 2)}`;

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
      onOpen({ ...s, sessionId, title: `${s.title} (fork)`, lastModified: Date.now() });
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove(s: SessionInfo) {
    const ok = await confirm({
      title: "Delete this session?",
      body: (
        <p>
          “{s.title}” and its transcript are deleted from Claude Code's session history. Files in the workspace aren't
          touched. This can't be undone.
        </p>
      ),
      confirmLabel: "Delete session",
      danger: true,
    });
    if (ok) await run(() => request("session.delete", { cwd, sessionId: s.sessionId }));
  }

  if (!cwd) return null;
  return (
    <section className="session-list" aria-label="Previous sessions">
      <h2>Previous sessions</h2>
      {error && <p className="warn">{error}</p>}
      {sessions === null ? (
        <p className="muted">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="muted">No sessions in this folder yet.</p>
      ) : (
        <ul>
          {sessions.map((s) => {
            const open = openIds.has(s.sessionId);
            const edit = editing?.sessionId === s.sessionId ? editing : null;
            return (
              <li key={s.sessionId}>
                <div className="session-main">
                  {edit ? (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: the field appears because the user just asked to edit it.
                      autoFocus
                      value={edit.value}
                      aria-label={edit.field === "title" ? "Session title" : "Session tag"}
                      placeholder={edit.field === "tag" ? "Tag (empty to clear)" : ""}
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
                  <span className="muted">
                    {new Date(s.lastModified).toLocaleString()}
                    {s.gitBranch ? ` · ${s.gitBranch}` : ""}
                    {costs.has(s.sessionId) ? ` · ${usd(costs.get(s.sessionId) ?? 0)}` : ""}
                  </span>
                  {s.tag && <span className="badge">{s.tag}</span>}
                  {open && <span className="badge">open</span>}
                </div>
                <div className="session-actions">
                  <button type="button" className="secondary" onClick={() => onOpen(s)}>
                    {open ? "Show" : "Resume"}
                  </button>
                  <button type="button" className="link" onClick={() => void fork(s)}>
                    Fork
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setEditing({ sessionId: s.sessionId, field: "title", value: s.title })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => setEditing({ sessionId: s.sessionId, field: "tag", value: s.tag ?? "" })}
                  >
                    Tag
                  </button>
                  <button
                    type="button"
                    className="link"
                    disabled={open}
                    title={open ? "Close its tab first" : undefined}
                    onClick={() => void remove(s)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {summary && summary.last30Usd + summary.uncountedTurns > 0 && (
        <p className="muted">
          Spent in this folder (estimates, sessions run in AgentChainer): today {usd(summary.todayUsd)} · 7 days{" "}
          {usd(summary.last7Usd)} · 30 days {usd(summary.last30Usd)}
          {summary.uncountedTurns > 0 &&
            ` · ${summary.uncountedTurns} turn(s) of sessions started elsewhere aren't counted`}
        </p>
      )}
      {retention && (
        <p className="muted retention">
          Claude Code deletes sessions after {retention.days} days without activity (
          {retention.source === "default" ? "default" : `set in your ${retention.source} settings`}). To keep them
          longer, raise <code>cleanupPeriodDays</code> in <code>~/.claude/settings.json</code>.
        </p>
      )}
    </section>
  );
}
