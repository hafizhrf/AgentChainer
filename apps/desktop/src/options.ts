import { EFFORTS, type ModelOption, type PERMISSION_MODES } from "@agentchainer/protocol";

/** Choices shared by the start screen, the composer and Settings. */

/** Until a chat has started once: the CLI's aliases, which always point at its latest models. */
const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", displayName: "Default (recommended)", description: "From your Claude settings" },
  { value: "opus", displayName: "Opus", description: "The latest Opus" },
  { value: "sonnet", displayName: "Sonnet", description: "The latest Sonnet" },
  { value: "haiku", displayName: "Haiku", description: "The latest Haiku" },
];
const MODELS_KEY = "agentchainer.models";
/** The device's storage, when there is one (not in unit tests). */
const storage = () =>
  (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } })
    .localStorage;
let known: ModelOption[] | null = null;

/**
 * The models the CLI offered in the last chat (UX-12), as its `/model` names them, kept on this device so the start
 * screen and Settings list them too. Storage can be missing or throw; then the CLI's aliases stand in.
 */
export function knownModels(): ModelOption[] {
  if (known) return known;
  try {
    const saved = JSON.parse(storage()?.getItem(MODELS_KEY) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.every((m) => typeof m?.value === "string" && typeof m?.displayName === "string")
    ) {
      known = saved as ModelOption[];
      return known;
    }
  } catch {
    // Not available: use the aliases.
  }
  return FALLBACK_MODELS;
}

export function rememberModels(models: ModelOption[]): void {
  if (!models.length) return;
  known = models;
  try {
    storage()?.setItem(MODELS_KEY, JSON.stringify(models));
  } catch {
    // Kept for this run only.
  }
}

/**
 * Select options for models. The CLI's "default" is the app's "" (no model set). A model picked earlier that the list
 * no longer has stays as an option, so the select still shows it.
 */
export function modelChoices(
  models: ModelOption[] = knownModels(),
  current = "",
): { value: string; label: string; hint?: string }[] {
  const opts = models.map((m) => ({
    value: m.value === "default" ? "" : m.value,
    label: m.displayName,
    ...(m.description ? { hint: m.description } : {}),
  }));
  if (!opts.some((o) => o.value === ""))
    opts.unshift({ value: "", label: "Default (recommended)", hint: "From your Claude settings" });
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
  return opts;
}

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

/** A keyboard shortcut as the platform writes it: "⌘J" or "⇧⌘P" on macOS, "Ctrl+J" or "Ctrl+Shift+P" elsewhere. */
export const shortcut = (key: string, { shift = false }: { shift?: boolean } = {}) =>
  isMac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
