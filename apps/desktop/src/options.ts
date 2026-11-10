import {
  EFFORTS,
  type Effort,
  type ModelOption,
  PERMISSION_MODES,
  type PermissionMode,
  type StepAgent,
} from "@agentchainer/protocol";
import { type MessageKey, t } from "./i18n/index.ts";

/** Choices shared by the start screen, the composer and Settings. */

/**
 * The permission modes a chat on each agent has (M9-09). Codex can't be asked to only plan. agy never asks, so it
 * edits (Standard) or, with Plan, only reads.
 */
export function agentModes(agent: StepAgent | undefined): readonly PermissionMode[] {
  if (agent === "codex") return PERMISSION_MODES.filter((m) => m !== "plan");
  if (agent === "agy") return ["acceptEdits", "plan"];
  return PERMISSION_MODES;
}

/** `mode` when the agent has it, else the nearest it has: Safe for Codex's plan, Standard for agy. */
export function fitMode(agent: StepAgent | undefined, mode: PermissionMode): PermissionMode {
  if (agentModes(agent).includes(mode)) return mode;
  return agent === "agy" ? "acceptEdits" : "default";
}

/** Until a chat has started once: the CLI's aliases, which always point at its latest models. */
const fallbackModels = (): ModelOption[] => [
  { value: "default", displayName: t("shell.options.modelDefault"), description: t("shell.options.modelDefaultHint") },
  { value: "opus", displayName: t("shell.options.modelOpus"), description: t("shell.options.modelOpusHint") },
  { value: "sonnet", displayName: t("shell.options.modelSonnet"), description: t("shell.options.modelSonnetHint") },
  { value: "haiku", displayName: t("shell.options.modelHaiku"), description: t("shell.options.modelHaikuHint") },
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
  return fallbackModels();
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
  /** Whose default "" means; another agent's isn't from the Claude settings (M9-09). */
  agent = "Claude",
): { value: string; label: string; hint?: string }[] {
  const opts = models.map((m) => ({
    value: m.value === "default" ? "" : m.value,
    label: m.displayName,
    ...(m.description ? { hint: m.description } : {}),
  }));
  if (!opts.some((o) => o.value === ""))
    opts.unshift({
      value: "",
      label: t("shell.options.modelDefault"),
      hint:
        agent === "Claude" ? t("shell.options.modelDefaultHint") : t("shell.options.modelDefaultHintAgent", { agent }),
    });
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: current });
  return opts;
}

/** "Open in editor" targets (M1-28); each needs its command-line launcher on PATH, except the system default. */
export const EDITORS = [
  {
    value: "system",
    get label() {
      return t("shell.options.editorSystem");
    },
  },
  {
    value: "vscode",
    get label() {
      return t("shell.options.editorVscode");
    },
  },
  {
    value: "cursor",
    get label() {
      return t("shell.options.editorCursor");
    },
  },
  {
    value: "zed",
    get label() {
      return t("shell.options.editorZed");
    },
  },
  {
    value: "idea",
    get label() {
      return t("shell.options.editorIdea");
    },
  },
];

export const THEMES = [
  {
    value: "system",
    get label() {
      return t("shell.options.themeSystem");
    },
  },
  {
    value: "light",
    get label() {
      return t("shell.options.themeLight");
    },
  },
  {
    value: "dark",
    get label() {
      return t("shell.options.themeDark");
    },
  },
];

type Mode = (typeof PERMISSION_MODES)[number];

/**
 * Permission profiles (M1-18, ARCHITECTURE §6), each one SDK permission mode. The guard's hard denylist applies in
 * all of them. Owner testing showed "auto-accept edits" read as "auto mode", hence the names and explanations. Each
 * text is looked up in the catalogs when it's read (X-13).
 */
export const MODE_NAMES: Record<Mode, string> = {
  get default() {
    return t("shell.options.modeDefaultName");
  },
  get acceptEdits() {
    return t("shell.options.modeAcceptEditsName");
  },
  get auto() {
    return t("shell.options.modeAutoName");
  },
  get plan() {
    return t("shell.options.modePlanName");
  },
};

const MODE_SUMMARY: Record<Mode, string> = {
  get default() {
    return t("shell.options.modeDefaultSummary");
  },
  get acceptEdits() {
    return t("shell.options.modeAcceptEditsSummary");
  },
  get auto() {
    return t("shell.options.modeAutoSummary");
  },
  get plan() {
    return t("shell.options.modePlanSummary");
  },
};

export const MODE_HELP: Record<Mode, string> = {
  get default() {
    return t("shell.options.modeDefaultHelp");
  },
  get acceptEdits() {
    return t("shell.options.modeAcceptEditsHelp");
  },
  get auto() {
    return t("shell.options.modeAutoHelp");
  },
  get plan() {
    return t("shell.options.modePlanHelp");
  },
};

/** Profile choices for a select; Autonomous is disabled without a budget cap. */
export function modeOptions(modes: readonly Mode[], canAutonomous: boolean) {
  return modes.map((m) => ({
    value: m,
    label: MODE_NAMES[m],
    hint: m === "auto" && !canAutonomous ? t("shell.options.needsBudget") : MODE_SUMMARY[m],
    disabled: m === "auto" && !canAutonomous,
  }));
}

const EFFORT_LABELS: Record<Effort, MessageKey> = {
  low: "shell.options.effortLow",
  medium: "shell.options.effortMedium",
  high: "shell.options.effortHigh",
  xhigh: "shell.options.effortXhigh",
  max: "shell.options.effortMax",
};

export const EFFORT_OPTIONS = [
  {
    value: "",
    get label() {
      return t("shell.options.effortDefault");
    },
  },
  ...EFFORTS.map((e) => ({
    value: e,
    get label() {
      return t(EFFORT_LABELS[e]);
    },
  })),
];

/** macOS keeps the native menu bar; Windows and Linux get the app's own title bar with its menus (UX-15). */
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** A keyboard shortcut as the platform writes it: "⌘J" or "⇧⌘P" on macOS, "Ctrl+J" or "Ctrl+Shift+P" elsewhere. */
export const shortcut = (key: string, { shift = false }: { shift?: boolean } = {}) =>
  isMac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
