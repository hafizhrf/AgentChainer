import { CircleAlert, CircleCheck, Folder, Loader2, Plus, Settings } from "lucide-react";

import { folderName, type Tab } from "./tabs.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

/**
 * The left column (UX-03): new session, open sessions with their status, recent workspaces, and at the bottom the
 * readiness state and Settings.
 */
export function Sidebar({
  tabs,
  active,
  recent,
  ready,
  onNew,
  onSelect,
  onClose,
  onOpenWorkspace,
  onSettings,
}: {
  tabs: Tab[];
  /** The active session; null while Home is shown. */
  active: string | null;
  recent: string[];
  /** null while the readiness check hasn't run yet. */
  ready: boolean | null;
  onNew: () => void;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onOpenWorkspace: (dir: string) => void;
  onSettings: () => void;
}) {
  return (
    <nav className="sidebar" aria-label="Sessions and workspaces">
      <div className="sidebar-top">
        <span className="brand">AgentChainer</span>
        <button type="button" className={`new-session${active === null ? " current" : ""}`} onClick={onNew}>
          <Plus size={16} />
          New session
          <kbd>{menuShortcut("new-session")}</kbd>
        </button>
      </div>

      <div className="sidebar-scroll">
        <section>
          <h2 className="sidebar-heading">Sessions</h2>
          {tabs.length === 0 ? (
            <p className="sidebar-empty">Open sessions show up here.</p>
          ) : (
            <ul className="nav-list">
              {tabs.map((t) => (
                <li key={t.sessionId} className={`nav-row${t.sessionId === active ? " active" : ""}`}>
                  <button
                    type="button"
                    className="nav-main"
                    aria-current={t.sessionId === active ? "page" : undefined}
                    title={`${t.title}\n${t.cwd}`}
                    onClick={() => onSelect(t.sessionId)}
                  >
                    <span className="nav-title">{t.title}</span>
                    <span className="nav-sub">{folderName(t.cwd)}</span>
                  </button>
                  <SessionStatus tab={t} />
                  <ActionMenu
                    label={`Actions for ${t.title}`}
                    items={[
                      {
                        label: "Close session",
                        shortcut: menuShortcut("close-session"),
                        onSelect: () => onClose(t.sessionId),
                      },
                    ]}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {recent.length > 0 && (
          <section>
            <h2 className="sidebar-heading">Recent workspaces</h2>
            <ul className="nav-list">
              {recent.map((dir) => (
                <li key={dir} className="nav-row">
                  <button type="button" className="nav-main workspace" title={dir} onClick={() => onOpenWorkspace(dir)}>
                    <Folder size={14} aria-hidden />
                    <span className="nav-title">{folderName(dir)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={`ready-pill${ready === false ? " not-ready" : ""}`}
          onClick={onNew}
          title="Setup check"
        >
          {ready === false ? <CircleAlert size={14} /> : <CircleCheck size={14} />}
          {ready === null ? "Checking…" : ready ? "Ready" : "Needs setup"}
        </button>
        <span className="grow" />
        <IconButton label="Settings" shortcut={menuShortcut("settings")} onClick={onSettings}>
          <Settings size={16} />
        </IconButton>
      </div>
    </nav>
  );
}

function SessionStatus({ tab }: { tab: Tab }) {
  if (tab.permissions.length > 0)
    return (
      <span
        className="nav-status approval"
        role="img"
        title="Waiting for your approval"
        aria-label="Waiting for approval"
      />
    );
  if (tab.running) return <Loader2 className="nav-status spin" size={14} aria-label="Working" />;
  if (tab.ended)
    return (
      <span className="nav-status ended" title="Ended: open it to resume">
        ended
      </span>
    );
  return null;
}
