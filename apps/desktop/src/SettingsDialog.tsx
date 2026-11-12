import { EFFORTS, type EnvCheck, type Methods, PERMISSION_MODES } from "@agentchainer/protocol";
import * as Tabs from "@radix-ui/react-tabs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { Bot, Download, Info, ListChecks, Palette, RefreshCw, SlidersHorizontal, SquareTerminal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { applyTheme } from "./appearance.ts";
import { Modal, useConfirm } from "./Dialog.tsx";
import { asLanguage, LANGUAGES, t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
import { EDITORS, EFFORT_OPTIONS, MODE_HELP, modelChoices, modeOptions, THEMES } from "./options.ts";
import { SettingsAgents } from "./SettingsAgents.tsx";
import type { Settings } from "./settings.ts";
import { request } from "./sidecar.ts";
import { asMode } from "./tabs.ts";
import type { AgentClis } from "./tasks/AgentPickers.tsx";
import { TaskDefaultsFields } from "./tasks/TaskDefaultsFields.tsx";
import { asTheme } from "./theme.ts";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

type Hello = Methods["system.hello"]["result"];

const PRIVACY = "https://github.com/hafizhrf/AgentChainer/blob/main/docs/PRIVACY.md";

const PAGES: { id: Page; label: () => string; icon: ReactNode }[] = [
  { id: "general", label: () => t("home.settings.pageGeneral"), icon: <Palette size={15} aria-hidden /> },
  { id: "sessions", label: () => t("home.settings.pageSessions"), icon: <SquareTerminal size={15} aria-hidden /> },
  { id: "tasks", label: () => t("home.settings.pageTasks"), icon: <ListChecks size={15} aria-hidden /> },
  { id: "agents", label: () => t("home.settings.pageAgents"), icon: <Bot size={15} aria-hidden /> },
  { id: "tools", label: () => t("home.settings.pageTools"), icon: <SlidersHorizontal size={15} aria-hidden /> },
  { id: "about", label: () => t("home.settings.pageAbout"), icon: <Info size={15} aria-hidden /> },
];

export type SettingsPage = "general" | "sessions" | "tasks" | "agents" | "tools" | "about";
type Page = SettingsPage;

/**
 * App settings (M1-07, UX-02) in a dialog, as pages beside a list of them (UX-23): General, Sessions, Tasks, Agents,
 * Limits and tools, About. The theme previews while picking and reverts on Cancel. Saving a new CLI path restarts the
 * agent runtime so it takes effect; a new language (X-13) asks to restart the app, or applies at the next start.
 */
export function SettingsDialog({
  settings,
  hello,
  env,
  checking,
  onRecheck,
  appVersion,
  onSave,
  onExportDiagnostics,
  onCheckUpdates,
  onClose,
  initialPage = "general",
}: {
  settings: Settings;
  hello: Hello | null;
  /** Claude's CLI as the readiness check found it, for the Agents page. */
  env: EnvCheck | null;
  checking: boolean;
  /** Checks the CLIs again: the readiness check, then the other agents. */
  onRecheck: () => void;
  appVersion: string | null;
  onSave: (next: Settings) => Promise<void>;
  /** Returns where the bundle was saved, or null when cancelled. */
  onExportDiagnostics: () => Promise<string | null>;
  onCheckUpdates: () => void;
  onClose: () => void;
  /** The page it opens on. */
  initialPage?: Page;
}) {
  const [draft, setDraft] = useState(settings);
  // The other agents' CLIs, so the task defaults offer only agents this computer has (M9).
  const [clis, setClis] = useState<AgentClis | null>(null);
  const loadClis = useCallback(() => {
    void request("agents.available", {}).then(setClis, () => setClis(null));
  }, []);
  useEffect(loadClis, [loadClis]);
  const [page, setPage] = useState<Page>(initialPage);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const mode = asMode(draft.defaultMode);
  const muted = (s: string) => <span className="muted">{s}</span>;

  function cancel() {
    applyTheme(asTheme(settings.theme));
    onClose();
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
      const language = asLanguage(draft.language);
      if (
        language !== asLanguage(settings.language) &&
        (await confirm({
          title: t("home.settings.restartTitle"),
          body: t("home.settings.restartBody", { language: LANGUAGES[language] }),
          confirmLabel: t("home.settings.restartNow"),
        }))
      ) {
        await relaunch();
        return;
      }
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function exportBundle() {
    try {
      const path = await onExportDiagnostics();
      if (path) setExported(t("home.settings.exported", { path }));
    } catch (err) {
      setExported(t("home.settings.exportFailed", { error: String(err) }));
    }
  }

  return (
    <>
      <Modal
        open
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
        title={t("home.settings.title")}
        size="lg"
        actions={
          <>
            {error && <span className="dialog-error">{error}</span>}
            <button type="button" className="secondary" onClick={cancel}>
              {t("shell.dialog.cancel")}
            </button>
            <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? t("home.settings.saving") : t("home.settings.save")}
            </button>
          </>
        }
      >
        <Tabs.Root
          className="settings settings-tabs"
          orientation="vertical"
          value={page}
          onValueChange={(v) => setPage(v as Page)}
        >
          <Tabs.List className="settings-nav" aria-label={t("home.settings.pages")}>
            {PAGES.map((p) => (
              <Tabs.Trigger key={p.id} value={p.id} className="settings-nav-item">
                {p.icon}
                {p.label()}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <Tabs.Content value="general" className="settings-page">
            <section className="settings-section">
              <h3>{t("home.settings.appearance")}</h3>
              <Field label={t("home.settings.theme")}>
                <Select
                  label={t("home.settings.theme")}
                  value={asTheme(draft.theme)}
                  options={THEMES}
                  onChange={(value) => {
                    const theme = asTheme(value);
                    applyTheme(theme);
                    setDraft({ ...draft, theme: theme === "system" ? null : theme });
                  }}
                />
              </Field>
              <Field label={t("home.settings.language")}>
                <Select
                  label={t("home.settings.language")}
                  value={asLanguage(draft.language)}
                  options={Object.entries(LANGUAGES).map(([value, label]) => ({ value, label }))}
                  onChange={(value) => setDraft({ ...draft, language: value === "id" ? "id" : null })}
                />
              </Field>
            </section>
          </Tabs.Content>
          <Tabs.Content value="sessions" className="settings-page">
            <section className="settings-section">
              <h3>{t("home.settings.newSessions")}</h3>
              <div className="field-row">
                <Field label={t("home.settings.model")}>
                  <Select
                    label={t("home.settings.defaultModel")}
                    value={draft.defaultModel ?? ""}
                    options={modelChoices()}
                    onChange={(value) => setDraft({ ...draft, defaultModel: value || null })}
                  />
                </Field>
                <Field label={t("home.settings.effort")}>
                  <Select
                    label={t("home.settings.defaultEffort")}
                    value={EFFORTS.find((e) => e === draft.defaultEffort) ?? ""}
                    options={EFFORT_OPTIONS}
                    onChange={(value) => setDraft({ ...draft, defaultEffort: value || null })}
                  />
                </Field>
              </div>
              <Field label={t("home.settings.permissionProfile")} help={MODE_HELP[mode]}>
                <Select
                  label={t("home.settings.defaultPermissionProfile")}
                  value={mode}
                  options={modeOptions(PERMISSION_MODES, true)}
                  onChange={(value) => setDraft({ ...draft, defaultMode: value })}
                />
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.showThinking !== false}
                  onChange={(e) => setDraft({ ...draft, showThinking: e.target.checked })}
                />
                <span>
                  <Rich k="home.settings.showThinking" tags={{ muted }} />
                </span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.autoApply === true}
                  onChange={(e) => setDraft({ ...draft, autoApply: e.target.checked || null })}
                />
                <span>{t("home.settings.autoApply")}</span>
              </label>
              <p className="field-help">{t("home.settings.autoApplyHelp")}</p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.restoreTabs !== false}
                  onChange={(e) => setDraft({ ...draft, restoreTabs: e.target.checked ? null : false })}
                />
                <span>{t("home.settings.restoreTabs")}</span>
              </label>
              <p className="field-help">{t("home.settings.restoreTabsHelp")}</p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.tasksPreview === true}
                  onChange={(e) => setDraft({ ...draft, tasksPreview: e.target.checked || null })}
                />
                <span>
                  <Rich k="home.settings.tasksPreview" tags={{ muted }} />
                </span>
              </label>
              <p className="field-help">
                {t("home.settings.tasksPreviewHelp", { keys: menuShortcut("new-task") ?? "" })}
              </p>
            </section>
          </Tabs.Content>
          <Tabs.Content value="tasks" className="settings-page">
            <section className="settings-section">
              <h3>{t("home.settings.taskDefaults")}</h3>
              <p className="muted">{t("home.settings.taskDefaultsHelp")}</p>
              <TaskDefaultsFields
                value={draft.taskDefaults ?? {}}
                onChange={(next) => setDraft({ ...draft, taskDefaults: next })}
                clis={clis}
              />
            </section>
          </Tabs.Content>
          <Tabs.Content value="agents" className="settings-page">
            <section className="settings-section">
              <h3>{t("home.settings.agents")}</h3>
              <SettingsAgents
                env={env}
                clis={clis}
                checking={checking}
                onRecheck={() => {
                  onRecheck();
                  loadClis();
                }}
                draft={draft}
                onDraft={setDraft}
              />
            </section>
          </Tabs.Content>
          <Tabs.Content value="tools" className="settings-page">
            <section className="settings-section">
              <h3>{t("home.settings.limits")}</h3>
              <Field label={t("home.settings.budget")} help={t("home.settings.budgetHelp")}>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={draft.budgetUsd ?? ""}
                  onChange={(e) => setDraft({ ...draft, budgetUsd: e.target.value ? Number(e.target.value) : null })}
                  placeholder={t("home.settings.budgetPlaceholder")}
                />
              </Field>
            </section>
            <section className="settings-section">
              <h3>{t("home.settings.tools")}</h3>
              <Field label={t("home.settings.editor")} help={t("home.settings.editorHelp")}>
                <Select
                  label={t("home.settings.editor")}
                  value={draft.editor ?? "system"}
                  options={EDITORS}
                  onChange={(value) => setDraft({ ...draft, editor: value })}
                />
              </Field>
            </section>
          </Tabs.Content>
          <Tabs.Content value="about" className="settings-page">
            <section className="settings-section">
              <h3>{t("home.settings.about")}</h3>
              <dl className="about">
                <dt>{t("home.settings.aboutApp")}</dt>
                <dd>{appVersion ?? "…"}</dd>
                <dt>{t("home.settings.aboutCli")}</dt>
                <dd>{hello ? (hello.claudeVersion ?? t("home.settings.notFound")) : "…"}</dd>
                <dt>{t("home.settings.aboutSdk")}</dt>
                <dd>{hello?.sdkVersion ?? "…"}</dd>
                <dt>{t("home.settings.aboutNode")}</dt>
                <dd>{hello?.nodeVersion ?? "…"}</dd>
              </dl>
              <div className="row">
                <button type="button" className="secondary" onClick={onCheckUpdates}>
                  <RefreshCw size={14} />
                  {t("home.settings.checkUpdates")}
                </button>
                <button type="button" className="secondary" onClick={() => void exportBundle()}>
                  <Download size={14} />
                  {t("home.settings.exportDiagnostics")}
                </button>
              </div>
              <p className="field-help">
                <Rich
                  k="home.settings.diagnosticsHelp"
                  tags={{
                    link: (s) => (
                      <button type="button" className="link" onClick={() => void openUrl(PRIVACY)}>
                        {s}
                      </button>
                    ),
                  }}
                />
              </p>
              {exported && <p className="field-help">{exported}</p>}
            </section>
          </Tabs.Content>
        </Tabs.Root>
      </Modal>
      {confirmDialog}
    </>
  );
}
