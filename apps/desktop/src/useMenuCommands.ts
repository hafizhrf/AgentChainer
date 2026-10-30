import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { shortcut } from "./options.ts";

/** Native menu items that reach the UI (UX-07). Keep in sync with `UI_COMMANDS` in `src-tauri/src/menu.rs`. */
export const MENU_COMMANDS = [
  "new-session",
  "open-folder",
  "close-session",
  "settings",
  "toggle-sidebar",
  "toggle-right-panel",
  "toggle-terminal",
  "export-diagnostics",
  "check-updates",
  "command-palette",
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export const asMenuCommand = (id: unknown): MenuCommand | null => MENU_COMMANDS.find((c) => c === id) ?? null;

/**
 * The menu's accelerators, for showing them in the UI (`shortcut()`); a test checks them against `menu.rs`, so a
 * displayed shortcut is always the one that works.
 */
export const MENU_SHORTCUTS: Partial<Record<MenuCommand, { key: string; shift?: boolean }>> = {
  "new-session": { key: "N" },
  "open-folder": { key: "O" },
  "close-session": { key: "W" },
  settings: { key: "," },
  "toggle-sidebar": { key: "\\" },
  "toggle-right-panel": { key: "B" },
  "toggle-terminal": { key: "J" },
  "command-palette": { key: "P", shift: true },
};

/** Runs the handler for each `menu` event from the Rust core. Handlers may change every render. */
export function useMenuCommands(handlers: Record<MenuCommand, () => void>): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    const off = listen<string>("menu", (e) => {
      const command = asMenuCommand(e.payload);
      if (command) current.current[command]();
    });
    return () => void off.then((unlisten) => unlisten());
  }, []);
}

/** How a menu command's shortcut is written on this platform, if it has one. */
export function menuShortcut(command: MenuCommand): string | undefined {
  const s = MENU_SHORTCUTS[command];
  return s ? shortcut(s.key, { shift: s.shift ?? false }) : undefined;
}
