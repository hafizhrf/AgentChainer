import { type EnvCheck, PERMISSION_MODES, type PermissionMode, type SessionInfo } from "@agentchainer/protocol";
import { open } from "@tauri-apps/plugin-dialog";
import { Folder, FolderOpen, Play, Wrench, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { GitInitOffer } from "./GitInitOffer.tsx";
import { MODE_HELP, MODELS, modeOptions } from "./options.ts";
import { Readiness } from "./Readiness.tsx";
import { SessionList } from "./SessionList.tsx";
import { asMode, folderName } from "./tabs.ts";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";

/** Opens the native folder picker; null when cancelled. */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "Choose a project folder" });
  return typeof picked === "string" ? picked : null;
}

/**
 * The start screen (UX-06): readiness, the workspace folder (M1-06), model and permission profile, then the
 * folder's previous sessions. The whole width scrolls; the content is a centered column.
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
  model,
  onModelChange,
  mode,
  onModeChange,
  canAutonomous,
  onStart,
  onOpenSetup,
  openIds,
  onOpenStored,
  confirm,
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
  model: string;
  onModelChange: (alias: string) => void;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  canAutonomous: boolean;
  onStart: () => void;
  /** Opens Workspace settings for the chosen folder. */
  onOpenSetup: () => void;
  openIds: Set<string>;
  onOpenStored: (session: SessionInfo) => void;
  confirm: Confirm;
}) {
  const workspace = cwd.trim();
  const blocked = !env?.ready
    ? "Finish the setup check first."
    : !workspace
      ? "Choose a workspace folder first."
      : mode === "auto" && !canAutonomous
        ? "Autonomous needs a budget cap: set one in Settings."
        : null;

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-header">
          <h1>Start a session</h1>
          <p className="muted">Pick a project folder, choose how much Claude may do on its own, and start.</p>
        </header>

        <Readiness env={env} checking={checking} onRecheck={onRecheck} />

        <WorkspaceCard cwd={cwd} onChange={onCwdChange} recent={recent} homeDir={homeDir}>
          {connected && workspace && <GitInitOffer cwd={workspace} />}
          {connected && workspace && (
            <div className="workspace-setup">
              <span className="muted">See what this project needs for agent work, and set it up with previews.</span>
              <button type="button" className="secondary small" onClick={onOpenSetup}>
                <Wrench size={14} />
                Workspace settings…
              </button>
            </div>
          )}
        </WorkspaceCard>

        <section className="card" aria-labelledby="options-title">
          <div className="card-title">
            <h2 id="options-title">Options</h2>
          </div>
          <div className="field-row">
            <Field label="Model">
              <Select label="Model" value={model} onChange={onModelChange} options={MODELS} />
            </Field>
            <Field label="Permission profile">
              <Select
                label="Permission profile"
                value={mode}
                onChange={(m) => onModeChange(asMode(m))}
                options={modeOptions(PERMISSION_MODES, canAutonomous)}
              />
            </Field>
          </div>
          <p className="field-help">{MODE_HELP[mode]}</p>
          <div className="card-footer">
            {blocked && <span className="muted">{blocked}</span>}
            <span className="grow" />
            <button type="button" disabled={blocked !== null} onClick={onStart}>
              <Play size={14} />
              Start session
            </button>
          </div>
        </section>

        {connected && workspace && (
          <SessionList cwd={workspace} openIds={openIds} onOpen={onOpenStored} confirm={confirm} />
        )}
      </div>
    </div>
  );
}

/**
 * Workspace selection (M1-06): native folder picker, recent workspaces, or a typed path. There's no default folder:
 * owner testing showed a home-folder workspace lets the agent roam the whole home directory, so it gets a warning.
 */
function WorkspaceCard({
  cwd,
  onChange,
  recent,
  homeDir,
  children,
}: {
  cwd: string;
  onChange: (dir: string) => void;
  recent: string[];
  homeDir: string | null;
  children?: ReactNode;
}) {
  const [typing, setTyping] = useState(false);
  const workspace = cwd.trim();
  const isHome = homeDir !== null && workspace.replace(/[\\/]+$/, "") === homeDir;
  const others = recent.filter((dir) => dir !== workspace);

  async function browse() {
    const picked = await pickFolder();
    if (picked) {
      onChange(picked);
      setTyping(false);
    }
  }

  return (
    <section className="card" aria-labelledby="workspace-title">
      <div className="card-title">
        <h2 id="workspace-title">Workspace</h2>
        <span className="grow" />
        <button type="button" className="ghost small" onClick={() => setTyping((v) => !v)}>
          {typing ? "Done" : "Enter a path"}
        </button>
      </div>

      {typing && (
        <input
          // biome-ignore lint/a11y/noAutofocus: the field appears because the user just asked to type a path.
          autoFocus
          value={cwd}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setTyping(false)}
          placeholder={homeDir ? `e.g. ${homeDir}/projects/my-app` : "Path to a project folder"}
          spellCheck={false}
          aria-label="Workspace folder"
        />
      )}

      {workspace ? (
        <div className="workspace-selected">
          <Folder size={20} className="workspace-icon" aria-hidden />
          <div className="workspace-text">
            <strong>{folderName(workspace)}</strong>
            <span className="muted" title={workspace}>
              {workspace}
            </span>
          </div>
          <button type="button" className="secondary small" onClick={() => void browse()}>
            Change…
          </button>
          <button
            type="button"
            className="ghost icon"
            aria-label="Clear the workspace"
            title="Clear"
            onClick={() => onChange("")}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="workspace-empty">
          <p className="muted">The agent works inside this folder and can't change anything outside it.</p>
          <button type="button" onClick={() => void browse()}>
            <FolderOpen size={16} />
            Open folder…
          </button>
        </div>
      )}

      {isHome && (
        <p className="warn">
          That's your whole home folder. Pick a single project folder so the agent stays inside it.
        </p>
      )}
      {children}

      {others.length > 0 && (
        <div className="recent">
          <h3 className="recent-heading">Recent</h3>
          <ul>
            {others.map((dir) => (
              <li key={dir}>
                <button type="button" className="recent-row" title={dir} onClick={() => onChange(dir)}>
                  <Folder size={14} aria-hidden />
                  <span className="recent-name">{folderName(dir)}</span>
                  <span className="recent-path">{dir}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
