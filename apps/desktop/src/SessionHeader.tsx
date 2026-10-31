import { Folder, GitBranch, MessageSquare, Network, PanelRight, SquareTerminal } from "lucide-react";
import { useState } from "react";

import { folderName, type Tab } from "./tabs.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

/** The centre of a session: the chat, or the agent graph (M4-02). */
export type SessionMode = "chat" | "graph";

/**
 * The top of a session: title (rename in place), workspace and branch, the Chat | Graph switch, panel toggles and
 * session actions.
 */
export function SessionHeader({
  tab,
  view,
  onViewChange,
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
  view: SessionMode;
  onViewChange: (view: SessionMode) => void;
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
        <fieldset className="segmented" aria-label="Session view">
          <button type="button" aria-pressed={view === "chat"} onClick={() => onViewChange("chat")}>
            <MessageSquare size={13} aria-hidden />
            Chat
          </button>
          <button type="button" aria-pressed={view === "graph"} onClick={() => onViewChange("graph")}>
            <Network size={13} aria-hidden />
            Graph
          </button>
        </fieldset>
        <IconButton
          label="Terminal"
          shortcut={menuShortcut("toggle-terminal")}
          pressed={terminalOpen}
          onClick={onToggleTerminal}
        >
          <SquareTerminal size={16} />
        </IconButton>
        <IconButton
          label="Workspace panel"
          shortcut={menuShortcut("toggle-right-panel")}
          pressed={rightOpen}
          onClick={onToggleRight}
        >
          <PanelRight size={16} />
        </IconButton>
        <ActionMenu
          label="Session actions"
          items={[
            { label: "Rename", onSelect: () => setEditing(tab.title) },
            { label: "Fork into a new session", onSelect: onFork },
            { label: "Workspace settings…", onSelect: onOpenSetup },
            { label: "Close session", shortcut: menuShortcut("close-session"), onSelect: onClose },
          ]}
        />
      </div>
    </header>
  );
}
