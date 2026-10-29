import { EFFORTS, type Methods, PERMISSION_MODES } from "@agentchainer/protocol";
import { Download } from "lucide-react";
import { useState } from "react";
import { applyTheme } from "./appearance.ts";
import { Modal } from "./Dialog.tsx";
import { EDITORS, EFFORT_OPTIONS, MODE_HELP, MODELS, modeOptions, THEMES } from "./options.ts";
import type { Settings } from "./settings.ts";
import { asMode } from "./tabs.ts";
import { asTheme } from "./theme.ts";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";

type Hello = Methods["system.hello"]["result"];

/**
 * App settings (M1-07, UX-02) in a dialog. The theme previews while picking and reverts on Cancel. Saving a new Claude
 * CLI path restarts the agent runtime so it takes effect.
 */
export function SettingsDialog({
  settings,
  hello,
  appVersion,
  onSave,
  onExportDiagnostics,
  onClose,
}: {
  settings: Settings;
  hello: Hello | null;
  appVersion: string | null;
  onSave: (next: Settings) => Promise<void>;
  /** Returns where the bundle was saved, or null when cancelled. */
  onExportDiagnostics: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const mode = asMode(draft.defaultMode);

  function cancel() {
    applyTheme(asTheme(settings.theme));
    onClose();
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
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
      if (path) setExported(`Saved to ${path}. Secrets, emails and your home folder are masked; check before sharing.`);
    } catch (err) {
      setExported(`Export failed: ${err}`);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      title="Settings"
      size="lg"
      actions={
        <>
          {error && <span className="dialog-error">{error}</span>}
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
          <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="settings">
        <section className="settings-section">
          <h3>Appearance</h3>
          <Field label="Theme">
            <Select
              label="Theme"
              value={asTheme(draft.theme)}
              options={THEMES}
              onChange={(value) => {
                const theme = asTheme(value);
                applyTheme(theme);
                setDraft({ ...draft, theme: theme === "system" ? null : theme });
              }}
            />
          </Field>
        </section>

        <section className="settings-section">
          <h3>New sessions</h3>
          <div className="field-row">
            <Field label="Model">
              <Select
                label="Default model"
                value={draft.defaultModel ?? ""}
                options={MODELS}
                onChange={(value) => setDraft({ ...draft, defaultModel: value || null })}
              />
            </Field>
            <Field label="Effort">
              <Select
                label="Default effort"
                value={EFFORTS.find((e) => e === draft.defaultEffort) ?? ""}
                options={EFFORT_OPTIONS}
                onChange={(value) => setDraft({ ...draft, defaultEffort: value || null })}
              />
            </Field>
          </div>
          <Field label="Permission profile" help={MODE_HELP[mode]}>
            <Select
              label="Default permission profile"
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
              Show summaries of Claude's thinking <span className="muted">(no extra cost)</span>
            </span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.autoApply === true}
              onChange={(e) => setDraft({ ...draft, autoApply: e.target.checked || null })}
            />
            <span>Apply safe setup automatically before a new session</span>
          </label>
          <p className="field-help">
            Only reviewed first-party and official catalog items, plus fixes that only add lines (env rules in
            .gitignore, importing AGENTS.md). Never generators, git changes, or vendor and community items. What was
            applied shows in the session, and Workspace setup → History can roll it back.
          </p>
        </section>

        <section className="settings-section">
          <h3>Limits</h3>
          <Field
            label="Budget cap per session (USD)"
            help="Leave empty for no cap. The Autonomous profile needs one. Applies to sessions started after saving."
          >
            <input
              type="number"
              min="0"
              step="0.5"
              value={draft.budgetUsd ?? ""}
              onChange={(e) => setDraft({ ...draft, budgetUsd: e.target.value ? Number(e.target.value) : null })}
              placeholder="e.g. 5"
            />
          </Field>
        </section>

        <section className="settings-section">
          <h3>Tools</h3>
          <Field label="Open files in" help="Editors other than the system default need their command-line launcher.">
            <Select
              label="Open files in"
              value={draft.editor ?? "system"}
              options={EDITORS}
              onChange={(value) => setDraft({ ...draft, editor: value })}
            />
          </Field>
          <Field
            label="Claude CLI path"
            help="Leave empty to find it automatically. Changing it restarts the agent runtime."
          >
            <input
              value={draft.claudePath ?? ""}
              onChange={(e) => setDraft({ ...draft, claudePath: e.target.value || null })}
              placeholder="e.g. /Users/you/.local/bin/claude"
              spellCheck={false}
            />
          </Field>
        </section>

        <section className="settings-section">
          <h3>About</h3>
          <dl className="about">
            <dt>AgentChainer</dt>
            <dd>{appVersion ?? "…"}</dd>
            <dt>Claude CLI</dt>
            <dd>{hello ? (hello.claudeVersion ?? "not found") : "…"}</dd>
            <dt>Agent SDK</dt>
            <dd>{hello?.sdkVersion ?? "…"}</dd>
            <dt>Node</dt>
            <dd>{hello?.nodeVersion ?? "…"}</dd>
          </dl>
          <div className="row">
            <button type="button" className="secondary" onClick={() => void exportBundle()}>
              <Download size={14} />
              Export diagnostics…
            </button>
          </div>
          <p className="field-help">
            Versions, settings, the setup check and recent logs, for bug reports. No credentials or account details.
          </p>
          {exported && <p className="field-help">{exported}</p>}
        </section>
      </div>
    </Modal>
  );
}
