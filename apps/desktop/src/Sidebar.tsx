import type { FleetItem } from "@agentchainer/protocol";
import { CircleAlert, CircleCheck, ClipboardList, Folder, Folders, Loader2, Plus, Radar, Settings } from "lucide-react";
import type { WorkspaceDef } from "./settings.ts";
import { folderName, type Tab } from "./tabs.ts";
import { stateLabel } from "./tasks/run.ts";
import { type TaskTab, taskKey } from "./tasks/taskTabs.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

/** The `active` key of the fleet view (M8-02). */
export const FLEET = "fleet";

/**
 * The left column (UX-03): New, the open chats and tasks with their status (UX-13), recent workspaces, and at the
 * bottom the readiness state and Settings. A task is started from a chat's composer (Task), so there's one New.
 */
export function Sidebar({
  tabs,
  taskTabs,
  waitingTasks,
  onCloseTask,
  fleet,
  active,
  recent,
  ready,
  onNew,
  onNewTask,
  onSelect,
  onClose,
  onOpenWorkspace,
  workspaces,
  onOpenWorkspaceDef,
  onSettings,
}: {
  tabs: Tab[];
  taskTabs: TaskTab[];
  /** Tasks with a step waiting for an approval. */
  waitingTasks: ReadonlySet<string>;
  onCloseTask: (id: string) => void;
  /** Every live session, for the Fleet entry's counts (M8-02). */
  fleet: FleetItem[];
  /** The active session, or a task's `task:<id>`; null while Home is shown. */
  active: string | null;
  recent: string[];
  /** null while the readiness check hasn't run yet. */
  ready: boolean | null;
  onNew: () => void;
  /** Set only while the Tasks preview is on: New with the composer in Task mode. */
  onNewTask?: () => void;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onOpenWorkspace: (dir: string) => void;
  /** Named multi-folder workspaces (M8-01). */
  workspaces: WorkspaceDef[];
  onOpenWorkspaceDef: (def: WorkspaceDef) => void;
  onSettings: () => void;
}) {
  return (
    <nav className="sidebar" aria-label="Sessions and workspaces">
      <div className="sidebar-top">
        <span className="brand">AgentChainer</span>
        <button
          type="button"
          className={`new-session${active === null ? " current" : ""}`}
          onClick={onNew}
          title={onNewTask ? `New chat; pick Task in its composer for a task (${menuShortcut("new-task")})` : undefined}
        >
          <Plus size={16} />
          New
          <kbd>{menuShortcut("new-session")}</kbd>
        </button>
        <button
          type="button"
          className={`fleet-entry${active === FLEET ? " current" : ""}`}
          aria-current={active === FLEET ? "page" : undefined}
          onClick={() => onSelect(FLEET)}
        >
          <Radar size={15} aria-hidden />
          Fleet
          <span className="grow" />
          {fleet.some((i) => i.status === "waiting") && (
            <span className="fleet-count waiting" title="Waiting for you">
              {fleet.filter((i) => i.status === "waiting").length} waiting
            </span>
          )}
          {fleet.some((i) => i.status === "working") && (
            <span className="fleet-count" title="Working">
              {fleet.filter((i) => i.status === "working").length} working
            </span>
          )}
        </button>
      </div>

      <div className="sidebar-scroll">
        <section>
          <h2 className="sidebar-heading">Chats</h2>
          {tabs.length === 0 ? (
            <p className="sidebar-empty">Open chats show up here.</p>
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

        {taskTabs.length > 0 && (
          <section>
            <h2 className="sidebar-heading">Tasks</h2>
            <ul className="nav-list">
              {taskTabs.map((t) => {
                const key = taskKey(t.id);
                return (
                  <li key={t.id} className={`nav-row${key === active ? " active" : ""}`}>
                    <button
                      type="button"
                      className="nav-main"
                      aria-current={key === active ? "page" : undefined}
                      title={`${t.title}\n${t.cwd}`}
                      onClick={() => onSelect(key)}
                    >
                      <span className="nav-title">
                        <ClipboardList size={13} aria-hidden className="nav-kind" />
                        {t.title}
                      </span>
                      <span className="nav-sub">
                        {folderName(t.cwd)} · {t.state === "draft" ? "draft" : stateLabel(t.state).label}
                      </span>
                    </button>
                    {waitingTasks.has(t.id) ? (
                      <span
                        className="nav-status approval"
                        role="img"
                        title="Waiting for your approval"
                        aria-label="Waiting for approval"
                      />
                    ) : t.busy ? (
                      <Loader2 className="nav-status spin" size={14} aria-label="Working" />
                    ) : null}
                    <ActionMenu
                      label={`Actions for ${t.title}`}
                      items={[{ label: "Close task tab", onSelect: () => onCloseTask(t.id) }]}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {workspaces.length > 0 && (
          <section>
            <h2 className="sidebar-heading">Workspaces</h2>
            <ul className="nav-list">
              {workspaces.map((w) => (
                <li key={w.id} className="nav-row">
                  <button
                    type="button"
                    className="nav-main workspace"
                    title={[w.primary, ...w.folders].join("\n")}
                    onClick={() => onOpenWorkspaceDef(w)}
                  >
                    <Folders size={14} aria-hidden />
                    <span className="nav-title">{w.name}</span>
                    <span className="grow" />
                    <span className="nav-status ended" title={`${w.folders.length + 1} folders`}>
                      {w.folders.length + 1}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

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
  if (tab.background.length > 0)
    return <Loader2 className="nav-status spin" size={14} aria-label="Working in the background" />;
  if (tab.ended)
    return (
      <span className="nav-status ended" title="Ended: open it to resume">
        ended
      </span>
    );
  return null;
}
