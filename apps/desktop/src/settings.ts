import { invoke } from "@tauri-apps/api/core";

/** Mirrors `settings.rs` (M1-07). No secrets: auth stays in the user's own Claude CLI (ADR-0002). */
export type Settings = {
  claudePath: string | null;
  defaultModel: string | null;
  defaultMode: string | null;
  /** "Open in editor" target: system, vscode, cursor, zed, idea (M1-28). */
  editor: string | null;
  /** Effort for new sessions, or null for the model's default (M1-15). */
  defaultEffort: string | null;
  /** Spend cap per session in USD (M1-32); the Autonomous profile requires one. */
  budgetUsd: number | null;
  /** Stream summaries of Claude's thinking (M1-10); null means on. */
  showThinking: boolean | null;
  /** "light" or "dark"; null follows the OS (UX-02). */
  theme: string | null;
  recentWorkspaces: string[];
};

export const loadSettings = () => invoke<Settings>("settings_get");

/** Saves and returns the normalized settings (trimmed, de-duplicated recent list). */
export const saveSettings = (settings: Settings) => invoke<Settings>("settings_set", { settings });

/** Moves `dir` to the front of the recent workspaces. */
export function withRecent(settings: Settings, dir: string): Settings {
  return { ...settings, recentWorkspaces: [dir, ...settings.recentWorkspaces.filter((d) => d !== dir)] };
}
