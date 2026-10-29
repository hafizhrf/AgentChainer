import { EFFORTS, PERMISSION_MODES } from "@agentchainer/protocol";
import { useState } from "react";
import type { Settings } from "./settings.ts";

export const MODELS = [
  { value: "", label: "Default (from your Claude settings)" },
  { value: "haiku", label: "Haiku (fast, cheap)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

/** "Open in editor" targets (M1-28); each needs its command-line launcher on PATH, except the system default. */
export const EDITORS = [
  { value: "system", label: "System default app" },
  { value: "vscode", label: "VS Code (code)" },
  { value: "cursor", label: "Cursor (cursor)" },
  { value: "zed", label: "Zed (zed)" },
  { value: "idea", label: "IntelliJ IDEA (idea)" },
];

/**
 * Permission profiles (M1-18, ARCHITECTURE §6), each one SDK permission mode. The guard's hard denylist applies in
 * all of them. Owner testing showed "auto-accept edits" read as "auto mode", hence the names and explanations.
 */
export const MODE_LABELS: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: "Safe: asks before edits and commands",
  acceptEdits: "Standard: edits run, commands still ask",
  auto: "Autonomous: Claude decides, asks when unsure",
  plan: "Plan first: read-only until you approve a plan",
};

export const MODE_HELP: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: "Reading is allowed. Every file edit and shell command waits for your approval.",
  acceptEdits:
    "File edits inside the workspace run without asking. Shell commands, web access and MCP tools still ask.",
  auto: "Claude's auto mode: a classifier approves or blocks each action and only asks when unsure. Needs a budget cap. AgentChainer's guard still blocks dangerous commands.",
  plan: "Claude explores and writes a plan without changing anything. You approve the plan, then pick how to run it.",
};

const asModeOrDefault = (m: string | null) => PERMISSION_MODES.find((x) => x === m) ?? "default";

/** App settings (checklist M1-07). Saving a new Claude CLI path restarts the agent runtime so it takes effect. */
export function SettingsPanel({
  settings,
  onSave,
  onExportDiagnostics,
}: {
  settings: Settings;
  onSave: (next: Settings) => Promise<void>;
  /** Returns where the bundle was saved, or null when cancelled. */
  onExportDiagnostics: () => Promise<string | null>;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  async function exportBundle() {
    try {
      const path = await onExportDiagnostics();
      if (path) setExported(`Saved to ${path}. Secrets, emails and your home folder are masked; check before sharing.`);
    } catch (err) {
      setExported(`Export failed: ${err}`);
    }
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  async function save() {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="settings">
      <summary>Settings</summary>
      <label>
        Claude CLI path <span className="muted">(leave empty to detect automatically)</span>
        <input
          value={draft.claudePath ?? ""}
          onChange={(e) => setDraft({ ...draft, claudePath: e.target.value || null })}
          placeholder="e.g. /Users/you/.local/bin/claude"
          spellCheck={false}
        />
      </label>
      <label>
        Default model
        <select
          value={draft.defaultModel ?? ""}
          onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value || null })}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Default permission mode
        <select
          value={draft.defaultMode ?? "default"}
          onChange={(e) => setDraft({ ...draft, defaultMode: e.target.value })}
        >
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
        <span className="muted">{MODE_HELP[asModeOrDefault(draft.defaultMode)]}</span>
      </label>
      <label>
        Default effort
        <select
          value={draft.defaultEffort ?? ""}
          onChange={(e) => setDraft({ ...draft, defaultEffort: e.target.value || null })}
        >
          <option value="">Model default</option>
          {EFFORTS.map((ef) => (
            <option key={ef} value={ef}>
              {ef}
            </option>
          ))}
        </select>
      </label>
      <label>
        Budget cap per session, USD <span className="muted">(empty for none; required for Autonomous)</span>
        <input
          type="number"
          min="0"
          step="0.5"
          value={draft.budgetUsd ?? ""}
          onChange={(e) => setDraft({ ...draft, budgetUsd: e.target.value ? Number(e.target.value) : null })}
          placeholder="e.g. 5"
        />
      </label>
      <label>
        Open files in
        <select value={draft.editor ?? "system"} onChange={(e) => setDraft({ ...draft, editor: e.target.value })}>
          {EDITORS.map((ed) => (
            <option key={ed.value} value={ed.value}>
              {ed.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save settings"}
      </button>
      <hr />
      <button type="button" className="secondary" onClick={() => void exportBundle()}>
        Export diagnostics…
      </button>
      <span className="muted">
        Versions, settings, the readiness check and recent logs, for bug reports. No credentials or account details.
      </span>
      {exported && <p className="muted">{exported}</p>}
    </details>
  );
}
