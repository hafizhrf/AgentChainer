import * as ContextMenu from "@radix-ui/react-context-menu";
import { invoke } from "@tauri-apps/api/core";
import { AppWindow, Copy, ExternalLink, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
import { joinPath, systemPath } from "./files.ts";
import { t } from "./i18n/index.ts";
import { isMac } from "./options.ts";

const isWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/** What the reveal item is called on each system: Explorer, Finder, or the file manager. */
export function revealLabel(): string {
  if (isWindows) return t("panel.fileMenu.revealWindows");
  if (isMac) return t("panel.fileMenu.revealMac");
  return t("panel.fileMenu.revealLinux");
}

/**
 * The Files and Changes rows' own right-click menu (UX-21), in place of the WebView's: open in the editor or with the
 * system's default app (the same safe rules as the editor's: programs and scripts open as text or are refused), show
 * the item in the file manager, and copy its path. Shift+F10 and the menu key open it too, on the focused row.
 */
export function FileMenu({
  cwd,
  path,
  folder = false,
  onOpenFile,
  onError,
  children,
}: {
  cwd: string;
  /** Relative to `cwd`. */
  path: string;
  folder?: boolean;
  onOpenFile: (path: string) => void;
  /** A failed action's message; null clears the last one when the next starts. */
  onError: (message: string | null) => void;
  children: ReactNode;
}) {
  const abs = systemPath(joinPath(cwd, path), isWindows);
  const run = (action: () => Promise<unknown>) => {
    onError(null);
    action().catch((err: unknown) => onError(String(err)));
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div className="file-menu-trigger">{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content" aria-label={t("panel.fileMenu.label", { path })}>
          {!folder && (
            <>
              <ContextMenu.Item className="menu-item" onSelect={() => onOpenFile(path)}>
                <ExternalLink size={13} aria-hidden />
                {t("panel.fileMenu.openInEditor")}
              </ContextMenu.Item>
              <ContextMenu.Item
                className="menu-item"
                onSelect={() => run(() => invoke("open_in_editor", { file: abs, line: null, editor: "system" }))}
              >
                <AppWindow size={13} aria-hidden />
                {t("panel.fileMenu.openDefault")}
              </ContextMenu.Item>
            </>
          )}
          <ContextMenu.Item className="menu-item" onSelect={() => run(() => invoke("reveal_in_folder", { path: abs }))}>
            <FolderOpen size={13} aria-hidden />
            {revealLabel()}
          </ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item className="menu-item" onSelect={() => run(() => navigator.clipboard.writeText(abs))}>
            <Copy size={13} aria-hidden />
            {t("panel.fileMenu.copyPath")}
          </ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => run(() => navigator.clipboard.writeText(path))}>
            <Copy size={13} aria-hidden />
            {t("panel.fileMenu.copyRelativePath")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
