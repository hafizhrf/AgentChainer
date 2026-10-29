import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

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
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export const asMenuCommand = (id: unknown): MenuCommand | null => MENU_COMMANDS.find((c) => c === id) ?? null;

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
