import { invoke } from "@tauri-apps/api/core";

/** Mirrors `settings.rs` (M1-07). No secrets: auth stays in the user's own Claude CLI (ADR-0002). */
export type Settings = {
  claudePath: string | null;
  defaultModel: string | null;
  defaultMode: string | null;
  recentWorkspaces: string[];
};

export const loadSettings = () => invoke<Settings>("settings_get");

/** Saves and returns the normalized settings (trimmed, de-duplicated recent list). */
export const saveSettings = (settings: Settings) => invoke<Settings>("settings_set", { settings });

/** Moves `dir` to the front of the recent workspaces. */
export function withRecent(settings: Settings, dir: string): Settings {
  return { ...settings, recentWorkspaces: [dir, ...settings.recentWorkspaces.filter((d) => d !== dir)] };
}
