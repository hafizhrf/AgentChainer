import * as Menubar from "@radix-ui/react-menubar";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Minus, PanelBottom, PanelLeft, PanelRight, Search, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "./BrandMark.tsx";
import { isMac, shortcut } from "./options.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { commandForKey, type MenuCommand, menuShortcut } from "./useMenuCommands.ts";

type Item =
  | { kind: "command"; id: MenuCommand; label: string }
  | { kind: "help"; id: string; label: string }
  | { kind: "edit"; id: EditAction; label: string; keys?: string }
  | { kind: "quit"; label: string }
  | { kind: "separator" };

type EditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

/** The same menus as `menu.rs` builds natively on macOS, with the same ids and shortcuts. */
function menus(tasks: boolean): { label: string; items: Item[] }[] {
  const sep: Item = { kind: "separator" };
  return [
    {
      label: "File",
      items: [
        { kind: "command", id: "new-session", label: "New Session" },
        ...(tasks ? [{ kind: "command", id: "new-task", label: "New Task" } as const] : []),
        { kind: "command", id: "open-folder", label: "Open Folder…" },
        sep,
        { kind: "command", id: "close-session", label: "Close Session" },
        sep,
        { kind: "command", id: "settings", label: "Settings…" },
        sep,
        { kind: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      items: [
        { kind: "edit", id: "undo", label: "Undo", keys: shortcut("Z") },
        { kind: "edit", id: "redo", label: "Redo", keys: shortcut("Y") },
        sep,
        { kind: "edit", id: "cut", label: "Cut", keys: shortcut("X") },
        { kind: "edit", id: "copy", label: "Copy", keys: shortcut("C") },
        { kind: "edit", id: "paste", label: "Paste", keys: shortcut("V") },
        { kind: "edit", id: "selectAll", label: "Select All", keys: shortcut("A") },
      ],
    },
    {
      label: "View",
      items: [
        { kind: "command", id: "command-palette", label: "Command Palette…" },
        sep,
        { kind: "command", id: "toggle-sidebar", label: "Toggle Sidebar" },
        { kind: "command", id: "toggle-right-panel", label: "Toggle Workspace Panel" },
        { kind: "command", id: "toggle-terminal", label: "Toggle Terminal" },
      ],
    },
    {
      label: "Help",
      items: [
        { kind: "help", id: "help-getting-started", label: "Getting Started" },
        { kind: "help", id: "help-report-issue", label: "Report an Issue" },
        sep,
        { kind: "command", id: "export-diagnostics", label: "Export Diagnostics…" },
        { kind: "command", id: "check-updates", label: "Check for Updates…" },
      ],
    },
  ];
}

/**
 * Runs an Edit item on whatever had focus before the menu opened. The webview's own editing commands do the work;
 * Paste reads the clipboard's text through the app (the webview's own clipboard API waits on a permission prompt)
 * and inserts it as typed text.
 */
async function edit(action: EditAction, target: Element | null) {
  if (target instanceof HTMLElement) target.focus();
  if (action === "paste") {
    const text = await readText().catch(() => "");
    if (text) document.execCommand("insertText", false, text);
    return;
  }
  document.execCommand(action);
}

/**
 * The window's title bar (UX-15), like an IDE's: the mark and the menus on the left, a search field in the middle that
 * opens the command palette, then the panel toggles and the window buttons. On macOS the native menu bar and the
 * traffic lights stay, so only the middle and the toggles show. The bar itself drags the window, and a double-click
 * maximizes it.
 */
export function TitleBar({
  title,
  tasks,
  sidebarOpen,
  rightOpen,
  terminalOpen,
  onCommand,
}: {
  /** What the search field names: the open workspace. */
  title: string;
  /** Whether New Task is offered (the Tasks preview). */
  tasks: boolean;
  sidebarOpen: boolean;
  rightOpen: boolean;
  /** null when no session is open, so there's no terminal to toggle. */
  terminalOpen: boolean | null;
  onCommand: (command: MenuCommand) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState("");
  /** What had focus before a menu opened, for the Edit items. */
  const focused = useRef<Element | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isMac) return;
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized, () => undefined);
    sync();
    const off = win.onResized(sync);
    return () => void off.then((unlisten) => unlisten());
  }, []);

  // Without a native menu there are no native accelerators: the menus' shortcuts are caught here.
  const command = useRef(onCommand);
  command.current = onCommand;
  useEffect(() => {
    if (isMac) return;
    const onKey = (e: KeyboardEvent) => {
      const c = commandForKey(e);
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      command.current(c);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Alt alone opens the menus from the keyboard, as in a native menu bar.
  useEffect(() => {
    if (isMac) return;
    let alone = false;
    const down = (e: KeyboardEvent) => {
      alone = e.key === "Alt" && !e.repeat;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Alt" || !alone) return;
      alone = false;
      focused.current = document.activeElement;
      bar.current?.querySelector<HTMLButtonElement>(".titlebar-menu")?.focus();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);

  const pick = (item: Item) => {
    if (item.kind === "command") onCommand(item.id);
    else if (item.kind === "help") void invoke("menu_select", { id: item.id });
    // After the menu closed and gave focus back (below), so the edit lands where the person was typing.
    else if (item.kind === "edit") setTimeout(() => void edit(item.id, focused.current), 0);
    else if (item.kind === "quit") void invoke("quit_app");
  };

  const win = isMac ? null : getCurrentWindow();
  return (
    <div className={`titlebar${isMac ? " mac" : ""}`} ref={bar} data-tauri-drag-region>
      {!isMac && (
        <>
          <span className="titlebar-mark" data-tauri-drag-region>
            <BrandMark size={16} />
          </span>
          <Menubar.Root
            className="titlebar-menus"
            value={menu}
            onValueChange={setMenu}
            onPointerDownCapture={() => {
              if (!menu) focused.current = document.activeElement;
            }}
          >
            {menus(tasks).map((m) => (
              <Menubar.Menu key={m.label} value={m.label}>
                <Menubar.Trigger className="titlebar-menu">{m.label}</Menubar.Trigger>
                <Menubar.Portal>
                  <Menubar.Content
                    className="menu-content"
                    align="start"
                    sideOffset={2}
                    // Focus goes back to where it was before the menu, not to the menu's button, like a native menu.
                    onCloseAutoFocus={(e) => {
                      const before = focused.current;
                      if (before instanceof HTMLElement && before !== document.body) {
                        e.preventDefault();
                        before.focus();
                      }
                    }}
                  >
                    {m.items.map((item, i) =>
                      item.kind === "separator" ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
                        <Menubar.Separator key={`sep-${i}`} className="menu-separator" />
                      ) : (
                        <Menubar.Item key={item.label} className="menu-item" onSelect={() => pick(item)}>
                          {item.label}
                          <span className="menu-shortcut">
                            {item.kind === "command" ? menuShortcut(item.id) : item.kind === "edit" ? item.keys : ""}
                          </span>
                        </Menubar.Item>
                      ),
                    )}
                  </Menubar.Content>
                </Menubar.Portal>
              </Menubar.Menu>
            ))}
          </Menubar.Root>
        </>
      )}
      <span className="grow" data-tauri-drag-region />
      <button type="button" className="titlebar-search" onClick={() => onCommand("command-palette")}>
        <Search size={13} aria-hidden />
        <span className="titlebar-search-text">{title}</span>
        <kbd>{menuShortcut("command-palette")}</kbd>
      </button>
      <span className="grow" data-tauri-drag-region />
      <div className="titlebar-toggles">
        <IconButton
          label="Toggle Sidebar"
          shortcut={menuShortcut("toggle-sidebar")}
          pressed={sidebarOpen}
          onClick={() => onCommand("toggle-sidebar")}
        >
          <PanelLeft size={15} />
        </IconButton>
        {terminalOpen !== null && (
          <IconButton
            label="Toggle Terminal"
            shortcut={menuShortcut("toggle-terminal")}
            pressed={terminalOpen}
            onClick={() => onCommand("toggle-terminal")}
          >
            <PanelBottom size={15} />
          </IconButton>
        )}
        <IconButton
          label="Toggle Workspace Panel"
          shortcut={menuShortcut("toggle-right-panel")}
          pressed={rightOpen}
          onClick={() => onCommand("toggle-right-panel")}
        >
          <PanelRight size={15} />
        </IconButton>
      </div>
      {win && (
        <div className="titlebar-window">
          <button type="button" aria-label="Minimize" onClick={() => void win.minimize()}>
            <Minus size={15} />
          </button>
          <button
            type="button"
            aria-label={maximized ? "Restore" : "Maximize"}
            onClick={() => void win.toggleMaximize()}
          >
            {maximized ? <Copy size={13} /> : <Square size={12} />}
          </button>
          <button type="button" className="close" aria-label="Close" onClick={() => void win.close()}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
