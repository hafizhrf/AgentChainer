/**
 * The right panel's tabs (UX-03), in order. Which ones show is a per-device choice, like VS Code's views: people who
 * only want the chat can hide Git or Files, and ⌘B hides the whole panel. At least one tab always stays.
 */
export const PANEL_TABS = ["changes", "files", "git", "setup"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export const PANEL_TAB_LABEL: Record<PanelTab, string> = {
  changes: "Changes",
  files: "Files",
  git: "Git",
  setup: "Setup",
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
