import type { EnvCheck, SessionInfo } from "@agentchainer/protocol";
import { open } from "@tauri-apps/plugin-dialog";
import { ClipboardList, Folder, FolderOpen, FolderPlus, Plus, Wrench, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Confirm } from "./Dialog.tsx";
import { GitInitOffer } from "./GitInitOffer.tsx";
import { t } from "./i18n/index.ts";
import { Readiness } from "./Readiness.tsx";
import { SessionList } from "./SessionList.tsx";
import { shortPath } from "./shortPath.ts";
import { folderName } from "./tabs.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

/** Opens the native folder picker; null when cancelled. */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: t("home.view.pickFolder") });
  return typeof picked === "string" ? picked : null;
}

/** Where a folder lives: its parent folder, shortened. */
const parentOf = (dir: string, homeDir: string | null) => shortPath(dir.replace(/[\\/]+[^\\/]+[\\/]*$/, ""), homeDir);

/**
 * The start screen (UX-06, redone in UX-20 like an IDE's): with no folder, a welcome page with the ways to start and
 * the recent folders and workspaces; with one, the folder's page: its sessions and tasks, and New session. New
 * session opens a dialog (folder, model, permission profile), so starting is one clear step. Readiness shows here
 * only when something is missing; otherwise the sidebar's status says so.
 */
export function HomeView({
  env,
  checking,
  onRecheck,
  homeDir,
  connected,
  cwd,
  onCwdChange,
  recent,
  onNewSession,
  onNewTask,
  onNewWorkspace,
  onOpenSetup,
  openIds,
  onOpenStored,
  confirm,
  workspaces,
  children,
}: {
  env: EnvCheck | null;
  checking: boolean;
  onRecheck: () => void;
  homeDir: string | null;
  /** The agent runtime answered; the git check and session list need it. */
  connected: boolean;
  cwd: string;
  onCwdChange: (dir: string) => void;
  recent: string[];
  /** Opens the New session dialog, for the folder shown when there's one. */
  onNewSession: () => void;
  onNewTask?: () => void;
  onNewWorkspace: () => void;
  /** Opens Workspace settings for the chosen folder. */
  onOpenSetup: () => void;
  openIds: Set<string>;
  onOpenStored: (session: SessionInfo) => void;
  confirm: Confirm;
  /** The named multi-folder workspaces, on the welcome page. */
  workspaces?: ReactNode;
  /** More of the folder's work below its sessions: its tasks (UX-13). */
  children?: ReactNode;
}) {
  const workspace = cwd.trim();
  const ready = env?.ready === true;
  const readiness = !ready && <Readiness env={env} checking={checking} onRecheck={onRecheck} />;

  async function browse() {
    const picked = await pickFolder();
    if (picked) onCwdChange(picked);
  }

  if (!workspace) {
    const action = (icon: ReactNode, label: string, onClick: () => void, keys?: string | null) => (
      <li>
        <button type="button" className="welcome-action" onClick={onClick}>
          {icon}
          <span className="grow">{label}</span>
          {keys && <kbd>{keys}</kbd>}
        </button>
      </li>
    );
    return (
      <div className="home">
        <div className="home-inner">
          {readiness}
          <header className="welcome-header">
            <h1>{t("home.welcome.title")}</h1>
            <p className="muted">{t("home.welcome.subtitle")}</p>
          </header>
          <div className="welcome-grid">
            <section className="welcome-col" aria-labelledby="welcome-start">
              <h2 id="welcome-start" className="welcome-heading">
                {t("home.welcome.start")}
              </h2>
              <ul className="welcome-actions">
                {action(
                  <Plus size={16} aria-hidden />,
                  t("home.welcome.newSession"),
                  onNewSession,
                  menuShortcut("new-session"),
                )}
                {action(<FolderOpen size={16} aria-hidden />, t("home.welcome.openFolder"), () => void browse())}
                {onNewTask &&
                  action(
                    <ClipboardList size={16} aria-hidden />,
                    t("home.welcome.newTask"),
                    onNewTask,
                    menuShortcut("new-task"),
                  )}
                {action(<FolderPlus size={16} aria-hidden />, t("home.welcome.newWorkspace"), onNewWorkspace)}
              </ul>
            </section>
            <section className="welcome-col" aria-labelledby="welcome-recent">
              <h2 id="welcome-recent" className="welcome-heading">
                {t("home.welcome.recent")}
              </h2>
              {recent.length === 0 ? (
                <p className="muted">{t("home.welcome.noRecent")}</p>
              ) : (
                <ul className="welcome-recent">
                  {recent.map((dir) => (
                    <li key={dir}>
                      <button type="button" className="welcome-recent-row" title={dir} onClick={() => onCwdChange(dir)}>
                        <Folder size={14} aria-hidden />
                        <span className="welcome-recent-name">{folderName(dir)}</span>
                        <span className="welcome-recent-path">{parentOf(dir, homeDir)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          {workspaces}
        </div>
      </div>
    );
  }

  const isHome = homeDir !== null && workspace.replace(/[\\/]+$/, "") === homeDir.replace(/[\\/]+$/, "");
  return (
    <div className="home">
      <div className="home-inner">
        {readiness}
        <section className="card folder-head" aria-labelledby="folder-title">
          <Folder size={22} className="workspace-icon" aria-hidden />
          <div className="folder-head-text">
            <h1 id="folder-title">{folderName(workspace)}</h1>
            <span className="muted" title={workspace}>
              {shortPath(workspace, homeDir, 72)}
            </span>
          </div>
          <span className="grow" />
          {connected && (
            <button type="button" className="secondary small" onClick={onOpenSetup}>
              <Wrench size={14} aria-hidden />
              {t("home.view.openSetup")}
            </button>
          )}
          <button type="button" onClick={onNewSession}>
            <Plus size={14} aria-hidden />
            {t("home.folder.newSession")}
          </button>
          <IconButton label={t("home.folder.close")} onClick={() => onCwdChange("")}>
            <X size={14} />
          </IconButton>
        </section>
        {isHome && <p className="warn">{t("home.workspace.homeWarning")}</p>}
        {connected && <GitInitOffer cwd={workspace} />}
        {connected && <SessionList cwd={workspace} openIds={openIds} onOpen={onOpenStored} confirm={confirm} />}
        {children}
      </div>
    </div>
  );
}
