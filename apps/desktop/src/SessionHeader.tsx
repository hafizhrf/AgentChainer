import { Folder, GitBranch, PanelRight, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { shortcut } from "./options.ts";
import { folderName, type Tab } from "./tabs.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";
import { IconButton } from "./ui/IconButton.tsx";

/** The top of a session: title (rename in place), workspace and branch, panel toggles and session actions. */
export function SessionHeader({
  tab,
  branch,
  terminalOpen,
  rightOpen,
  onToggleTerminal,
  onToggleRight,
  onRename,
  onFork,
  onClose,
  onOpenSetup,
}: {
  tab: Tab;
  branch: string | null;
  terminalOpen: boolean;
  rightOpen: boolean;
  onToggleTerminal: () => void;
  onToggleRight: () => void;
  onRename: (title: string) => void;
  onFork: () => void;
  onClose: () => void;
  onOpenSetup: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  function finish(save: boolean) {
    if (save && editing?.trim() && editing.trim() !== tab.title) onRename(editing.trim());
    setEditing(null);
  }

  return (
    <header className="session-header">
      <div className="session-heading">
        {editing !== null ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because the user just asked to rename.
            autoFocus
            className="session-rename"
            value={editing}
            aria-label="Session title"
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") finish(true);
              if (e.key === "Escape") {
                e.stopPropagation();
                finish(false);
              }
            }}
            onBlur={() => finish(true)}
          />
        ) : (
          <button type="button" className="session-name" title="Rename" onClick={() => setEditing(tab.title)}>
            {tab.title}
          </button>
        )}
        <span className="session-meta" title={tab.cwd}>
          <Folder size={12} aria-hidden />
          {folderName(tab.cwd)}
          {branch && (
            <>
              <GitBranch size={12} aria-hidden />
              {branch}
            </>
          )}
          {tab.ended && <span className="badge">ended</span>}
        </span>
      </div>
      <div className="session-tools">
        <IconButton label="Terminal" shortcut={shortcut("J")} pressed={terminalOpen} onClick={onToggleTerminal}>
          <SquareTerminal size={16} />
        </IconButton>
        <IconButton label="Workspace panel" shortcut={shortcut("B")} pressed={rightOpen} onClick={onToggleRight}>
          <PanelRight size={16} />
        </IconButton>
        <ActionMenu
          label="Session actions"
          items={[
            { label: "Rename", onSelect: () => setEditing(tab.title) },
            { label: "Fork into a new session", onSelect: onFork },
            { label: "Workspace setup…", onSelect: onOpenSetup },
            { label: "Close session", shortcut: shortcut("W"), onSelect: onClose },
          ]}
        />
      </div>
    </header>
  );
}
