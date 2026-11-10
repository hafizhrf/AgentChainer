import {
  type AgentDefinition,
  agentProblems,
  PERMISSION_MODES,
  type PermissionMode,
  type StepAgent,
} from "@agentchainer/protocol";
import { Folder, FolderOpen, Play } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Modal } from "./Dialog.tsx";
import { pickFolder } from "./HomeView.tsx";
import { t } from "./i18n/index.ts";
import { MODE_HELP, modelChoices, modeOptions } from "./options.ts";
import type { WorkspaceDef } from "./settings.ts";
import { shortPath } from "./shortPath.ts";
import { request } from "./sidecar.ts";
import { asMode, folderName } from "./tabs.ts";
import type { AgentClis } from "./tasks/AgentPickers.tsx";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";

const BROWSE = "\u0000browse";
const TYPE = "\u0000type";
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
  // The other agents' CLIs: Codex is offered when it's installed and signed in (M9-09).
  const [clis, setClis] = useState<AgentClis | null>(null);
  useEffect(() => {
    if (open) void request("agents.available", {}).then(setClis, () => setClis(null));
  }, [open]);
  const onCodex = agent === "codex";
  // A Codex chat has no plan mode: Safe stands in for it.
  useEffect(() => {
    if (onCodex && mode === "plan") onModeChange("default");
  }, [onCodex, mode, onModeChange]);
  const workspace = cwd.trim();
  const profiles = useProfiles(open && ready ? workspace : "");
  // A profile the new folder doesn't have is dropped, so Start never names a missing one.
  useEffect(() => {
    if (profile && profiles && !profiles.some((p) => p.name === profile)) onProfileChange("");
  }, [profile, profiles, onProfileChange]);
  useEffect(() => {
    if (!open) setTyping(false);
  }, [open]);

  const isHome = homeDir !== null && workspace.replace(/[\\/]+$/, "") === homeDir.replace(/[\\/]+$/, "");
  const blocked = !ready
    ? t("home.view.blockedSetup")
    : !workspace
      ? t("home.view.blockedFolder")
      : mode === "auto" && !canAutonomous
        ? t("home.view.blockedBudget")
        : null;

  const folders = [...new Set([...(workspace ? [workspace] : []), ...recent])];
  const folderOptions = [
    ...(workspace ? [] : [{ value: "", label: t("home.newSession.chooseFolder") }]),
    ...folders.map((dir) => ({ value: dir, label: folderName(dir), hint: shortPath(dir, homeDir) })),
    ...workspaces.map((w) => ({
      value: `${WS}${w.id}`,
      label: w.name,
      hint: t("home.newSession.workspaceHint", { count: w.folders.length + 1 }),
    })),
    { value: BROWSE, label: t("home.newSession.browse") },
    { value: TYPE, label: t("home.newSession.typePath") },
  ];

  async function pick(v: string) {
    if (v === BROWSE) {
      const picked = await pickFolder();
      if (picked) onCwdChange(picked);
    } else if (v === TYPE) {
      setTyping(true);
    } else if (v.startsWith(WS)) {
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
        <Field label={t("home.newSession.folder")} help={t("home.newSession.folderHelp")}>
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
          ) : folders.length || workspaces.length ? (
            <Select
              label={t("home.newSession.folder")}
              value={workspace}
              options={folderOptions}
              onChange={(v) => void pick(v)}
            />
          ) : (
            <button type="button" className="secondary" onClick={() => void pick(BROWSE)}>
              <FolderOpen size={14} aria-hidden />
              {t("home.workspace.open")}
            </button>
          )}
        </Field>
        {workspace && !typing && (
          <p className="muted new-session-path" title={workspace}>
            <Folder size={12} aria-hidden /> {shortPath(workspace, homeDir, 80)}
          </p>
        )}
        {isHome && <p className="warn">{t("home.workspace.homeWarning")}</p>}
        {clis?.codex.installed && (
          <Field label={t("home.newSession.agent")} help={onCodex ? t("home.newSession.codexHelp") : undefined}>
            <Select
              label={t("home.newSession.agent")}
              value={agent}
              onChange={(v) => onAgentChange(v as StepAgent)}
              options={[
                { value: "claude", label: t("tasks.agents.claude") },
                {
                  value: "codex",
                  label: clis.codex.signedIn
                    ? t("tasks.agents.codex")
                    : t("tasks.agents.notSignedIn", { agent: t("tasks.agents.codex") }),
                  disabled: !clis.codex.signedIn,
                },
              ]}
            />
          </Field>
        )}
        <div className="field-row">
          <Field label={t("home.view.model")}>
            {onCodex ? (
              <Select
                label={t("home.view.model")}
                value=""
                onChange={() => undefined}
                options={[{ value: "", label: t("home.newSession.codexModel") }]}
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
              options={modeOptions(
                onCodex ? PERMISSION_MODES.filter((m) => m !== "plan") : PERMISSION_MODES,
                canAutonomous,
              )}
            />
          </Field>
        </div>
        <p className="field-help">{MODE_HELP[mode]}</p>
        {!onCodex && profiles && profiles.length > 0 && (
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
      </form>
    </Modal>
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
