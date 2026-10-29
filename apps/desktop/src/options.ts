import { EFFORTS, type PERMISSION_MODES } from "@agentchainer/protocol";

/** Choices shared by the start screen, the composer and Settings. */

export const MODELS = [
  { value: "", label: "Default model", hint: "From your Claude settings" },
  { value: "haiku", label: "Haiku", hint: "Fast, cheap" },
  { value: "sonnet", label: "Sonnet", hint: "Balanced" },
  { value: "opus", label: "Opus", hint: "Most capable" },
];

/** "Open in editor" targets (M1-28); each needs its command-line launcher on PATH, except the system default. */
export const EDITORS = [
  { value: "system", label: "System default app" },
  { value: "vscode", label: "VS Code (code)" },
  { value: "cursor", label: "Cursor (cursor)" },
  { value: "zed", label: "Zed (zed)" },
  { value: "idea", label: "IntelliJ IDEA (idea)" },
];

export const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type Mode = (typeof PERMISSION_MODES)[number];

/**
 * Permission profiles (M1-18, ARCHITECTURE §6), each one SDK permission mode. The guard's hard denylist applies in
 * all of them. Owner testing showed "auto-accept edits" read as "auto mode", hence the names and explanations.
 */
export const MODE_NAMES: Record<Mode, string> = {
  default: "Safe",
  acceptEdits: "Standard",
  auto: "Autonomous",
  plan: "Plan first",
};

const MODE_SUMMARY: Record<Mode, string> = {
  default: "Asks before edits and commands",
  acceptEdits: "Edits run, commands still ask",
  auto: "Claude decides, asks when unsure",
  plan: "Read-only until you approve a plan",
};

export const MODE_HELP: Record<Mode, string> = {
  default: "Reading is allowed. Every file edit and shell command waits for your approval.",
  acceptEdits:
    "File edits inside the workspace run without asking. Shell commands, web access and MCP tools still ask.",
  auto: "Claude's auto mode: a classifier approves or blocks each action and only asks when unsure. Needs a budget cap. AgentChainer's guard still blocks dangerous commands.",
  plan: "Claude explores and writes a plan without changing anything. You approve the plan, then pick how to run it.",
};

/** Profile choices for a select; Autonomous is disabled without a budget cap. */
export function modeOptions(modes: readonly Mode[], canAutonomous: boolean) {
  return modes.map((m) => ({
    value: m,
    label: MODE_NAMES[m],
    hint: m === "auto" && !canAutonomous ? "Needs a budget cap (Settings)" : MODE_SUMMARY[m],
    disabled: m === "auto" && !canAutonomous,
  }));
}

export const EFFORT_OPTIONS = [
  { value: "", label: "Default effort" },
  ...EFFORTS.map((e) => ({ value: e, label: `${e[0]?.toUpperCase()}${e.slice(1)} effort` })),
];

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** A keyboard shortcut as the platform writes it: "⌘J" on macOS, "Ctrl+J" elsewhere. */
export const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
