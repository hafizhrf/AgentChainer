import type { FleetItem } from "@agentchainer/protocol";
import {
  BarChart3,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  FileText,
  Folder,
  Folders,
  Loader2,
  Plus,
  Radar,
  Settings,
} from "lucide-react";
import { t } from "./i18n/index.ts";
import type { WorkspaceDef } from "./settings.ts";
import { folderName, type Tab } from "./tabs.ts";
import { stateLabel } from "./tasks/run.ts";
import { type TaskTab, taskKey } from "./tasks/taskTabs.ts";
import { nestedTabs } from "./team.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

/** The `active` key of the fleet view (M8-02). */
export const FLEET = "fleet";
/** The usage page (CP-01), shown like the fleet view in the main area. */
export const USAGE = "usage";
/** Every project's CLAUDE.md (CP-03), shown like the usage page. */
export const MEMORY = "memory";

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
    <nav className="sidebar" aria-label={t("shell.sidebar.label")}>
      <div className="sidebar-top">
        <span className="brand">{t("shell.sidebar.brand")}</span>
        <button
          type="button"
          className={`new-session${active === null ? " current" : ""}`}
          onClick={onNew}
          title={onNewTask ? t("shell.sidebar.newTitle", { keys: menuShortcut("new-task") ?? "" }) : undefined}
        >
          <Plus size={16} />
          {t("shell.sidebar.newSession")}
          <kbd>{menuShortcut("new-session")}</kbd>
        </button>
        {/* The app-wide pages, close together: Fleet, Usage and CLAUDE.md. */}
        <div className="sidebar-pages">
          <button
            type="button"
            className={`fleet-entry${active === FLEET ? " current" : ""}`}
            aria-current={active === FLEET ? "page" : undefined}
            onClick={() => onSelect(FLEET)}
          >
            <Radar size={15} aria-hidden />
            {t("shell.sidebar.fleet")}
            <span className="grow" />
            {fleet.some((i) => i.status === "waiting") && (
              <span className="fleet-count waiting" title={t("shell.sidebar.waitingTitle")}>
                {t("shell.sidebar.waitingCount", { n: fleet.filter((i) => i.status === "waiting").length })}
              </span>
            )}
            {fleet.some((i) => i.status === "working") && (
              <span className="fleet-count" title={t("shell.sidebar.working")}>
                {t("shell.sidebar.workingCount", { n: fleet.filter((i) => i.status === "working").length })}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`fleet-entry${active === USAGE ? " current" : ""}`}
            aria-current={active === USAGE ? "page" : undefined}
            onClick={() => onSelect(USAGE)}
          >
            <BarChart3 size={15} aria-hidden />
            {t("shell.sidebar.usage")}
          </button>
          <button
            type="button"
            className={`fleet-entry${active === MEMORY ? " current" : ""}`}
            aria-current={active === MEMORY ? "page" : undefined}
            onClick={() => onSelect(MEMORY)}
          >
            <FileText size={15} aria-hidden />
            {t("shell.sidebar.memory")}
          </button>
        </div>
      </div>

      <div className="sidebar-scroll">
        <section>
          <h2 className="sidebar-heading">{t("shell.sidebar.chats")}</h2>
          {tabs.length === 0 ? (
            <p className="sidebar-empty">{t("shell.sidebar.chatsEmpty")}</p>
          ) : (
            <ul className="nav-list">
              {nestedTabs(tabs).map(({ tab, child }) => (
                <li
                  key={tab.sessionId}
                  className={`nav-row${child ? " child" : ""}${tab.sessionId === active ? " active" : ""}`}
                >
                  <button
                    type="button"
                    className="nav-main"
                    aria-current={tab.sessionId === active ? "page" : undefined}
                    title={`${tab.title}\n${tab.cwd}`}
                    onClick={() => onSelect(tab.sessionId)}
                  >
                    <span className="nav-title">{tab.title}</span>
                    <span className="nav-sub">
                      {child
                        ? [
                            t("shell.sidebar.worker"),
                            tab.profile,
                            tab.access === "write" ? t("shell.sidebar.canEdit") : t("shell.sidebar.readOnly"),
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : `${folderName(tab.cwd)}${tab.profile ? ` · ${tab.profile}` : ""}`}
                      {tab.team ? ` · ${t("shell.sidebar.team")}` : ""}
                    </span>
                  </button>
                  <SessionStatus tab={tab} />
                  <ActionMenu
                    label={t("shell.sidebar.actionsFor", { title: tab.title })}
                    items={[
                      {
                        label: t("shell.sidebar.closeSession"),
                        shortcut: menuShortcut("close-session"),
                        onSelect: () => onClose(tab.sessionId),
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
            <h2 className="sidebar-heading">{t("shell.sidebar.tasks")}</h2>
            <ul className="nav-list">
              {taskTabs.map((task) => {
                const key = taskKey(task.id);
                return (
                  <li key={task.id} className={`nav-row${key === active ? " active" : ""}`}>
                    <button
                      type="button"
                      className="nav-main"
                      aria-current={key === active ? "page" : undefined}
                      title={`${task.title}\n${task.cwd}`}
                      onClick={() => onSelect(key)}
                    >
                      <span className="nav-title">
                        <ClipboardList size={13} aria-hidden className="nav-kind" />
                        {task.title}
                      </span>
                      <span className="nav-sub">
                        {folderName(task.cwd)} ·{" "}
                        {task.state === "draft" ? t("shell.sidebar.draft") : stateLabel(task.state).label}
                      </span>
                    </button>
                    {waitingTasks.has(task.id) ? (
                      <span
                        className="nav-status approval"
                        role="img"
                        title={t("shell.sidebar.approvalTitle")}
                        aria-label={t("shell.sidebar.approvalLabel")}
                      />
                    ) : task.busy ? (
                      <Loader2 className="nav-status spin" size={14} aria-label={t("shell.sidebar.working")} />
                    ) : null}
                    <ActionMenu
                      label={t("shell.sidebar.actionsFor", { title: task.title })}
                      items={[{ label: t("shell.sidebar.closeTaskTab"), onSelect: () => onCloseTask(task.id) }]}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {workspaces.length > 0 && (
          <section>
            <h2 className="sidebar-heading">{t("shell.sidebar.workspaces")}</h2>
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
                    <span
                      className="nav-status ended"
                      title={t("shell.sidebar.folderCount", { n: w.folders.length + 1 })}
                    >
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
            <h2 className="sidebar-heading">{t("shell.sidebar.recent")}</h2>
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
          title={t("shell.sidebar.setupCheck")}
        >
          {ready === false ? <CircleAlert size={14} /> : <CircleCheck size={14} />}
          {ready === null
            ? t("shell.sidebar.checking")
            : ready
              ? t("shell.sidebar.ready")
              : t("shell.sidebar.needsSetup")}
        </button>
        <span className="grow" />
        <IconButton label={t("shell.sidebar.settings")} shortcut={menuShortcut("settings")} onClick={onSettings}>
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
        title={t("shell.sidebar.approvalTitle")}
        aria-label={t("shell.sidebar.approvalLabel")}
      />
    );
  if (tab.running) return <Loader2 className="nav-status spin" size={14} aria-label={t("shell.sidebar.working")} />;
  if (tab.background.length > 0)
    return <Loader2 className="nav-status spin" size={14} aria-label={t("shell.sidebar.workingBackground")} />;
  if (tab.ended)
    return (
      <span className="nav-status ended" title={t("shell.sidebar.endedTitle")}>
        {t("shell.sidebar.ended")}
      </span>
    );
  return null;
}
