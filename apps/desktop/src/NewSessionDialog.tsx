import { type AgentDefinition, agentProblems, type PermissionMode, type StepAgent } from "@agentchainer/protocol";
import { Folder, FolderOpen, FolderPlus, Loader2, Play } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Modal } from "./Dialog.tsx";
import { pickFolder } from "./HomeView.tsx";
import { t } from "./i18n/index.ts";
import { agentModes, fitMode, MODE_HELP, modelChoices, modeOptions } from "./options.ts";
import type { WorkspaceDef } from "./settings.ts";
import { shortPath } from "./shortPath.ts";
import { request } from "./sidecar.ts";
import { asMode, folderName } from "./tabs.ts";
import type { AgentClis } from "./tasks/AgentPickers.tsx";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";

const WS = "\u0000ws:";

/**
 * New session (UX-20), like an IDE's: one dialog with the folder (recent ones, a named workspace, Browse or a typed
 * path), the model, the permission profile and the agent profile, then Start. Opened by New, Ctrl+N and the welcome
 * page; it says why Start can't run yet instead of leaving the button dead.
 */
export function NewSessionDialog({
  open,
  onOpenChange,
  ready,
  homeDir,
  cwd,
  onCwdChange,
  recent,
  workspaces,
  onPickWorkspace,
  model,
  onModelChange,
  mode,
  onModeChange,
  profile,
  onProfileChange,
  canAutonomous,
  onStart,
  agent,
  onAgentChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The CLI is installed, recent enough and signed in. */
  ready: boolean;
  homeDir: string | null;
  cwd: string;
  onCwdChange: (dir: string) => void;
  recent: string[];
  workspaces: WorkspaceDef[];
  onPickWorkspace: (def: WorkspaceDef) => void;
  model: string;
  onModelChange: (alias: string) => void;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  profile: string;
  onProfileChange: (name: string) => void;
  canAutonomous: boolean;
  onStart: () => void;
  /** The agent the chat runs on (M9-09). */
  agent: StepAgent;
  onAgentChange: (agent: StepAgent) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [creating, setCreating] = useState(false);
  // The other agents' CLIs: Codex is offered when it's installed and signed in (M9-09).
  const [clis, setClis] = useState<AgentClis | null>(null);
  useEffect(() => {
    if (open) void request("agents.available", {}).then(setClis, () => setClis(null));
  }, [open]);
  const onCodex = agent === "codex";
  const onAgy = agent === "agy";
  // Each agent's own modes: Safe stands in for Codex's plan, Standard for agy's missing ones.
  useEffect(() => {
    const fit = fitMode(agent, mode);
    if (fit !== mode) onModeChange(fit);
  }, [agent, mode, onModeChange]);
  const workspace = cwd.trim();
  const profiles = useProfiles(open && ready ? workspace : "");
  // A profile the new folder doesn't have is dropped, so Start never names a missing one.
  useEffect(() => {
    if (profile && profiles && !profiles.some((p) => p.name === profile)) onProfileChange("");
  }, [profile, profiles, onProfileChange]);
  useEffect(() => {
    if (!open) {
      setTyping(false);
      setCreating(false);
    }
  }, [open]);

  const isHome = homeDir !== null && workspace.replace(/[\\/]+$/, "") === homeDir.replace(/[\\/]+$/, "");
  const blocked = !ready
    ? t("home.view.blockedSetup")
    : !workspace
      ? t("home.view.blockedFolder")
      : mode === "auto" && !canAutonomous
        ? t("home.view.blockedBudget")
        : null;

  const folders = [...new Set(recent)];
  // Recent folders and named workspaces only; Browse, New folder and Type a path are buttons of their own.
  const recentOptions = [
    { value: "", label: t("home.newSession.recentPick") },
    ...folders.map((dir) => ({ value: dir, label: folderName(dir), hint: shortPath(dir, homeDir) })),
    ...workspaces.map((w) => ({
      value: `${WS}${w.id}`,
      label: w.name,
      hint: t("home.newSession.workspaceHint", { count: w.folders.length + 1 }),
    })),
  ];

  async function browse() {
    const picked = await pickFolder();
    if (picked) onCwdChange(picked);
  }

  function pick(v: string) {
    if (!v) return;
    if (v.startsWith(WS)) {
      const def = workspaces.find((w) => w.id === v.slice(WS.length));
      if (def) onPickWorkspace(def);
    } else {
      onCwdChange(v);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (blocked === null) onStart();
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("home.newSession.title")}
      description={t("home.newSession.description")}
      actions={
        <>
          {blocked && <span className="muted new-session-blocked">{blocked}</span>}
          <button type="button" className="secondary" onClick={() => onOpenChange(false)}>
            {t("shell.dialog.cancel")}
          </button>
          <button type="submit" form="new-session-form" disabled={blocked !== null}>
            <Play size={14} aria-hidden />
            {t("home.view.start")}
          </button>
        </>
      }
    >
      <form id="new-session-form" className="new-session-form" onSubmit={submit}>
        <section className="new-session-group" aria-labelledby="new-session-where">
          <h3 id="new-session-where" className="new-session-heading">
            {t("home.newSession.where")}
          </h3>
          <div className={`folder-card${workspace ? "" : " empty"}`}>
            {workspace ? (
              <Folder size={18} className="folder-card-icon" aria-hidden />
            ) : (
              <FolderOpen size={18} className="folder-card-icon" aria-hidden />
            )}
            <div className="folder-card-text">
              <strong>{workspace ? folderName(workspace) : t("home.newSession.noFolder")}</strong>
              <span className="muted" title={workspace || undefined}>
                {workspace ? shortPath(workspace, homeDir, 80) : t("home.newSession.noFolderHint")}
              </span>
            </div>
          </div>
          {typing ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: the field appears because the person just asked to type a path.
              autoFocus
              value={cwd}
              onChange={(e) => onCwdChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setTyping(false);
                }
              }}
              placeholder={
                homeDir ? t("home.workspace.pathExample", { home: homeDir }) : t("home.workspace.pathPlaceholder")
              }
              spellCheck={false}
              aria-label={t("home.workspace.folderLabel")}
            />
          ) : (
            <div className="folder-actions">
              {(folders.length > 0 || workspaces.length > 0) && (
                <div className="folder-recent">
                  <Select
                    label={t("home.newSession.recent")}
                    value={folders.includes(workspace) ? workspace : ""}
                    options={recentOptions}
                    onChange={pick}
                  />
                </div>
              )}
              <button type="button" className="secondary small" onClick={() => void browse()}>
                <FolderOpen size={14} aria-hidden />
                {t("home.newSession.browse")}
              </button>
              <button type="button" className="secondary small" onClick={() => setCreating(true)} disabled={creating}>
                <FolderPlus size={14} aria-hidden />
                {t("home.newSession.newFolder")}
              </button>
              <button type="button" className="link" onClick={() => setTyping(true)}>
                {t("home.newSession.typePath")}
              </button>
            </div>
          )}
          {creating && (
            <NewFolder
              start={workspace ? workspace.replace(/[\\/]+[^\\/]+[\\/]*$/, "") || workspace : (homeDir ?? "")}
              homeDir={homeDir}
              onCreated={(dir) => {
                setCreating(false);
                onCwdChange(dir);
              }}
              onCancel={() => setCreating(false)}
            />
          )}
          <p className="field-help">{t("home.newSession.folderHelp")}</p>
          {isHome && <p className="warn">{t("home.workspace.homeWarning")}</p>}
        </section>
        <section className="new-session-group" aria-labelledby="new-session-how">
          <h3 id="new-session-how" className="new-session-heading">
            {t("home.newSession.how")}
          </h3>
          {(clis?.codex.installed || clis?.agy.installed) && (
            <fieldset className="agent-choice">
              <legend className="field-label">{t("home.newSession.agent")}</legend>
              <div className="agent-options">
                {(
                  [
                    { id: "claude", installed: true, signedIn: ready },
                    { id: "codex", installed: clis.codex.installed, signedIn: clis.codex.signedIn },
                    { id: "agy", installed: clis.agy.installed, signedIn: clis.agy.signedIn },
                  ] as const
                )
                  .filter((o) => o.installed)
                  .map((o) => (
                    <label
                      key={o.id}
                      className={`agent-option${agent === o.id ? " active" : ""}${o.signedIn ? "" : " disabled"}`}
                    >
                      <input
                        type="radio"
                        name="new-session-agent"
                        value={o.id}
                        checked={agent === o.id}
                        disabled={!o.signedIn}
                        onChange={() => onAgentChange(o.id)}
                      />
                      <span className={`agent-mark small agent-${o.id}`} aria-hidden>
                        {t(`tasks.agents.${o.id}`).slice(0, 1)}
                      </span>
                      <span className="agent-option-text">
                        <strong>{t(`tasks.agents.${o.id}`)}</strong>
                        <span className="muted">
                          {o.signedIn ? t("home.newSession.agentReady") : t("home.newSession.agentSignIn")}
                        </span>
                      </span>
                    </label>
                  ))}
              </div>
              {(onCodex || onAgy) && (
                <span className="field-help">
                  {onCodex ? t("home.newSession.codexHelp") : t("home.newSession.agyHelp")}
                </span>
              )}
            </fieldset>
          )}
          <div className="field-row">
            <Field label={t("home.view.model")}>
              {onCodex || onAgy ? (
                <Select
                  label={t("home.view.model")}
                  value=""
                  onChange={() => undefined}
                  options={[
                    { value: "", label: onAgy ? t("home.newSession.agyModel") : t("home.newSession.codexModel") },
                  ]}
                  disabled
                />
              ) : (
                <Select
                  label={t("home.view.model")}
                  value={model}
                  onChange={onModelChange}
                  options={modelChoices(undefined, model)}
                />
              )}
            </Field>
            <Field label={t("home.view.permissionProfile")}>
              <Select
                label={t("home.view.permissionProfile")}
                value={mode}
                onChange={(m) => onModeChange(asMode(m))}
                options={modeOptions(agentModes(agent), canAutonomous)}
              />
            </Field>
          </div>
          {/* agy never asks, so the Claude wording of a mode doesn't fit: its own help above says what each does. */}
          {!onAgy && <p className="field-help">{MODE_HELP[mode]}</p>}
          {agent === "claude" && profiles && profiles.length > 0 && (
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
        </section>
      </form>
    </Modal>
  );
}

/**
 * New folder… (UX-23): a new, empty folder for the session, inside one the person picks, with a git repository by
 * default (tasks need one). Nothing that exists is reused or overwritten.
 */
function NewFolder({
  start,
  homeDir,
  onCreated,
  onCancel,
}: {
  start: string;
  homeDir: string | null;
  onCreated: (dir: string) => void;
  onCancel: () => void;
}) {
  const [parent, setParent] = useState(start);
  const [name, setName] = useState("");
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim() || !parent || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated((await request("workspace.create", { parent, name: name.trim(), git })).path);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="new-folder">
      <legend className="sr-only">{t("home.newSession.newFolderTitle")}</legend>
      <div className="new-folder-row">
        <span className="field-label">{t("home.newSession.newFolderInside")}</span>
        <code className="new-folder-parent" title={parent}>
          {parent ? shortPath(parent, homeDir, 60) : t("home.newSession.noFolder")}
        </code>
        <button type="button" className="ghost small" onClick={() => void pickFolder().then((p) => p && setParent(p))}>
          {t("home.newSession.newFolderChange")}
        </button>
      </div>
      <Field label={t("home.newSession.newFolderName")}>
        <input
          // biome-ignore lint/a11y/noAutofocus: the form opens because the person asked to make a folder.
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
          placeholder={t("home.newSession.newFolderNamePlaceholder")}
          spellCheck={false}
        />
      </Field>
      <label className="check">
        <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
        <span>
          {t("home.newSession.newFolderGit")} <span className="muted">{t("home.newSession.newFolderGitHint")}</span>
        </span>
      </label>
      {error && <p className="warn">{error}</p>}
      <div className="new-folder-actions">
        <button
          type="button"
          className="primary small"
          disabled={!name.trim() || !parent || busy}
          onClick={() => void create()}
        >
          {busy ? <Loader2 size={14} className="spin" aria-hidden /> : <FolderPlus size={14} aria-hidden />}
          {t("home.newSession.newFolderCreate")}
        </button>
        <button type="button" className="ghost small" onClick={onCancel}>
          {t("shell.dialog.cancel")}
        </button>
      </div>
    </fieldset>
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
