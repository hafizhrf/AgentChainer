import { t } from "./i18n/index.ts";

/**
 * The right panel's tabs (UX-03), in order. Which ones show is a per-device choice, like VS Code's views: people who
 * only want the chat can hide Git or Files, and ⌘B hides the whole panel. At least one tab always stays.
 */
export const PANEL_TABS = ["changes", "files", "git", "setup"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** Each tab's name; getters, so it's read in the UI's language when shown (X-13). */
export const PANEL_TAB_LABEL: Record<PanelTab, string> = {
  get changes() {
    return t("panel.tabs.changes");
  },
  get files() {
    return t("panel.tabs.files");
  },
  get git() {
    return t("panel.tabs.git");
  },
  get setup() {
    return t("panel.tabs.setup");
  },
};

const isPanelTab = (v: string): v is PanelTab => (PANEL_TABS as readonly string[]).includes(v);

/** The tabs to show, in order. Never none: a list that hides everything shows everything. */
export function visibleTabs(hidden: readonly PanelTab[]): PanelTab[] {
  const shown = PANEL_TABS.filter((t) => !hidden.includes(t));
  return shown.length ? shown : [...PANEL_TABS];
}

/** Hides `tab`, or shows it again. Hiding the last visible tab is refused. */
export function toggleHidden(hidden: readonly PanelTab[], tab: PanelTab): PanelTab[] {
  if (hidden.includes(tab)) return hidden.filter((t) => t !== tab);
  const next = [...hidden, tab];
  return PANEL_TABS.every((t) => next.includes(t)) ? [...hidden] : next;
}

/** The tab to open: `current` while it's visible, else the first visible one. */
export const pickTab = (current: PanelTab, visible: readonly PanelTab[]): PanelTab =>
  visible.includes(current) ? current : (visible[0] ?? PANEL_TABS[0]);

/** The hidden list as stored (comma-separated). Unknown names and duplicates are dropped. */
export function parseHidden(raw: string): PanelTab[] {
  const tabs = [...new Set(raw.split(",").filter(isPanelTab))];
  return PANEL_TABS.every((t) => tabs.includes(t)) ? [] : tabs;
}

export const serializeHidden = (hidden: readonly PanelTab[]) => hidden.join(",");
