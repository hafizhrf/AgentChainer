import { PERMISSION_MODES } from "@agentchainer/protocol";
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

export const MODE_LABELS: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: "Ask before edits and commands",
  acceptEdits: "Auto-accept file edits (commands still ask)",
  auto: "Auto: Claude decides, asks when unsure",
  plan: "Plan only (no changes)",
};

/** App settings (checklist M1-07). Saving a new Claude CLI path restarts the agent runtime so it takes effect. */
export function SettingsPanel({ settings, onSave }: { settings: Settings; onSave: (next: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
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
    </details>
  );
}
