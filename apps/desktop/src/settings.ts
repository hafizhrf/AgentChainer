import { folderKey, type TaskDefaults } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors `settings.rs` (M1-07). No secrets: auth stays in the user's own Claude CLI (ADR-0002). */
export type Settings = {
  claudePath: string | null;
  /** Where the Codex and Antigravity CLIs are, for task steps on them (M9); null finds them automatically. */
  codexPath: string | null;
  agyPath: string | null;
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
  /** The UI's language (X-13): "id" for Bahasa Indonesia; null is English. Takes effect after a restart. */
  language: string | null;
  /** Apply safe setup before each new session (M2-18); null means off. */
  autoApply: boolean | null;
  /** Show "New task" (M3 contract and triage) before tasks can run; null means off. */
  tasksPreview: boolean | null;
  /** Reopen the tabs open when the app last closed (CP-09); null means on. */
  restoreTabs: boolean | null;
  recentWorkspaces: string[];
  /** Named multi-folder workspaces (M8-01), as the New workspace dialog saved them. */
  workspaces: WorkspaceDef[];
  /** Multi-folder sessions' other folders (M8-07), most recent first. */
  sessionFolders: { sessionId: string; folders: string[] }[];
  /** How tasks run unless a task or its workspace chooses: the app-wide level. */
  taskDefaults: TaskDefaults;
};

/** A named set of folders (M8-01): sessions run in `primary` and also reach `folders`. Mirrors `settings.rs`. */
export type WorkspaceDef = { id: string; name: string; primary: string; folders: string[] };

export const loadSettings = () => invoke<Settings>("settings_get");

/** Saves and returns the normalized settings (trimmed, de-duplicated recent list). */
export const saveSettings = (settings: Settings) => invoke<Settings>("settings_set", { settings });

/** Moves `dir` to the front of the recent workspaces. */
export function withRecent(settings: Settings, dir: string): Settings {
  return { ...settings, recentWorkspaces: [dir, ...settings.recentWorkspaces.filter((d) => d !== dir)] };
}

/**
 * Remembers a session's other folders (M8-07), most recent first, so resuming or forking it reaches them again. A
 * single-folder session has no entry.
 */
export function withSessionFolders(settings: Settings, sessionId: string, folders: string[]): Settings {
  const rest = (settings.sessionFolders ?? []).filter((s) => s.sessionId !== sessionId);
  return { ...settings, sessionFolders: folders.length ? [{ sessionId, folders }, ...rest] : rest };
}

/**
 * The folders a stored session reaches besides `cwd` (M8-07): what was recorded when it ran, or else the named
 * workspace whose primary folder it ran in; none for a single-folder session.
 */
export function foldersFor(settings: Settings | null, sessionId: string, cwd: string): string[] {
  const recorded = settings?.sessionFolders?.find((s) => s.sessionId === sessionId);
  if (recorded) return recorded.folders;
  const named = settings?.workspaces.find((w) => folderKey(w.primary) === folderKey(cwd));
  return named?.folders ?? [];
}
