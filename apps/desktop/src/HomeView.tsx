import {
  type AgentDefinition,
  agentProblems,
  type EnvCheck,
  PERMISSION_MODES,
  type PermissionMode,
  type SessionInfo,
} from "@agentchainer/protocol";
import { open } from "@tauri-apps/plugin-dialog";
import { Folder, FolderOpen, Play, Wrench, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { GitInitOffer } from "./GitInitOffer.tsx";
import { t } from "./i18n/index.ts";
import { MODE_HELP, modelChoices, modeOptions } from "./options.ts";
import { Readiness } from "./Readiness.tsx";
import { SessionList } from "./SessionList.tsx";
import { request } from "./sidecar.ts";
import { asMode, folderName } from "./tabs.ts";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";

/** Opens the native folder picker; null when cancelled. */
export async function pickFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: t("home.view.pickFolder") });
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
  profile,
  onProfileChange,
  canAutonomous,
  onStart,
  onOpenSetup,
  openIds,
  onOpenStored,
  confirm,
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
  model: string;
  onModelChange: (alias: string) => void;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  /** The agent profile a new chat starts as (M8-04); "" for none. */
  profile: string;
  onProfileChange: (name: string) => void;
  canAutonomous: boolean;
  onStart: () => void;
  /** Opens Workspace settings for the chosen folder. */
  onOpenSetup: () => void;
  openIds: Set<string>;
  onOpenStored: (session: SessionInfo) => void;
  confirm: Confirm;
  /** More of the folder's work below its sessions: its tasks (UX-13). */
  children?: ReactNode;
}) {
  const workspace = cwd.trim();
  const profiles = useProfiles(connected ? workspace : "");
  // A profile the new folder doesn't have is dropped, so Start never names a missing one.
  useEffect(() => {
    if (profile && profiles && !profiles.some((p) => p.name === profile)) onProfileChange("");
  }, [profile, profiles, onProfileChange]);
  const blocked = !env?.ready
    ? t("home.view.blockedSetup")
    : !workspace
      ? t("home.view.blockedFolder")
      : mode === "auto" && !canAutonomous
        ? t("home.view.blockedBudget")
        : null;

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-header">
          <h1>{t("home.view.title")}</h1>
          <p className="muted">{t("home.view.subtitle")}</p>
        </header>

        <Readiness env={env} checking={checking} onRecheck={onRecheck} />

        <WorkspaceCard cwd={cwd} onChange={onCwdChange} recent={recent} homeDir={homeDir}>
          {connected && workspace && <GitInitOffer cwd={workspace} />}
          {connected && workspace && (
            <div className="workspace-setup">
              <span className="muted">{t("home.view.setupHint")}</span>
              <button type="button" className="secondary small" onClick={onOpenSetup}>
                <Wrench size={14} />
                {t("home.view.openSetup")}
              </button>
            </div>
          )}
        </WorkspaceCard>

        <section className="card" aria-labelledby="options-title">
          <div className="card-title">
            <h2 id="options-title">{t("home.view.options")}</h2>
          </div>
          <div className="field-row">
            <Field label={t("home.view.model")}>
              <Select
                label={t("home.view.model")}
                value={model}
                onChange={onModelChange}
                options={modelChoices(undefined, model)}
              />
            </Field>
            <Field label={t("home.view.permissionProfile")}>
              <Select
                label={t("home.view.permissionProfile")}
                value={mode}
                onChange={(m) => onModeChange(asMode(m))}
                options={modeOptions(PERMISSION_MODES, canAutonomous)}
              />
            </Field>
          </div>
          <p className="field-help">{MODE_HELP[mode]}</p>
          {profiles && profiles.length > 0 && (
            <Field label={t("home.view.agentProfile")} help={t("home.view.agentProfileHelp")}>
              <Select
                label={t("home.view.agentProfile")}
                value={profile}
                onChange={onProfileChange}
                options={[
                  { value: "", label: t("home.view.profileNone"), hint: t("home.view.profileNoneHint") },
                  ...profiles.map((p) => ({
                    value: p.name,
                    label: p.name,
                    hint: `${p.scope === "user" ? t("home.view.profileYours") : t("home.view.profileProject")} · ${p.description}`,
                  })),
                ]}
              />
            </Field>
          )}
          <div className="card-footer">
            {blocked && <span className="muted">{blocked}</span>}
            <span className="grow" />
            <button type="button" disabled={blocked !== null} onClick={onStart}>
              <Play size={14} />
              {t("home.view.start")}
            </button>
          </div>
        </section>

        {connected && workspace && (
          <SessionList cwd={workspace} openIds={openIds} onOpen={onOpenStored} confirm={confirm} />
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Workspace selection (M1-06): native folder picker, recent workspaces, or a typed path. There's no default folder:
 * owner testing showed a home-folder workspace lets the agent roam the whole home directory, so it gets a warning.
 */
export function WorkspaceCard({
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
        <h2 id="workspace-title">{t("home.workspace.title")}</h2>
        <span className="grow" />
        <button type="button" className="ghost small" onClick={() => setTyping((v) => !v)}>
          {typing ? t("home.workspace.done") : t("home.workspace.enterPath")}
        </button>
      </div>

      {typing && (
        <input
          // biome-ignore lint/a11y/noAutofocus: the field appears because the user just asked to type a path.
          autoFocus
          value={cwd}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setTyping(false)}
          placeholder={
            homeDir ? t("home.workspace.pathExample", { home: homeDir }) : t("home.workspace.pathPlaceholder")
          }
          spellCheck={false}
          aria-label={t("home.workspace.folderLabel")}
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
            {t("home.workspace.change")}
          </button>
          <button
            type="button"
            className="ghost icon"
            aria-label={t("home.workspace.clearLabel")}
            title={t("home.workspace.clear")}
            onClick={() => onChange("")}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="workspace-empty">
          <p className="muted">{t("home.workspace.empty")}</p>
          <button type="button" onClick={() => void browse()}>
            <FolderOpen size={16} />
            {t("home.workspace.open")}
          </button>
        </div>
      )}

      {isHome && <p className="warn">{t("home.workspace.homeWarning")}</p>}
      {children}

      {others.length > 0 && (
        <div className="recent">
          <h3 className="recent-heading">{t("home.workspace.recent")}</h3>
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

/** The workspace's and the user's agents that can run as a profile (M8-04): readable, with no problems. */
function useProfiles(workspace: string): AgentDefinition[] | null {
  const [profiles, setProfiles] = useState<AgentDefinition[] | null>(null);
  useEffect(() => {
    if (!workspace) {
      setProfiles(null);
      return;
    }
    let live = true;
    request("agents.list", { cwd: workspace })
      .then(({ agents }) => {
        if (!live) return;
        const seen = new Set<string>();
        // A project agent wins over the user's of the same name, as when the sidecar loads it.
        setProfiles(
          agents.filter((a) => !a.error && agentProblems(a).length === 0 && !seen.has(a.name) && seen.add(a.name)),
        );
      })
      .catch(() => live && setProfiles([]));
    return () => {
      live = false;
    };
  }, [workspace]);
  return profiles;
}
