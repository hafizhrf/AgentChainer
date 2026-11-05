import { Bot, ChartGantt, Folder, GitBranch, MessageSquare, Network, PanelRight, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { t } from "./i18n/index.ts";
import { folderName, type Tab } from "./tabs.ts";
import { ActionMenu } from "./ui/ActionMenu.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

/** The centre of a session: the chat, or the agent graph (M4-02). */
export type SessionMode = "chat" | "graph" | "timeline";

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
            aria-label={t("session.header.titleLabel")}
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
          <button
            type="button"
            className="session-name"
            title={t("session.header.rename")}
            onClick={() => setEditing(tab.title)}
          >
            {tab.title}
          </button>
        )}
        <span className="session-meta" title={tab.cwd}>
          <Folder size={12} aria-hidden />
          {folderName(tab.cwd)}
          {tab.folders?.length ? (
            <span className="chip" title={tab.folders.join("\n")}>
              {t("session.header.folders", { count: tab.folders.length })}
            </span>
          ) : null}
          {tab.profile && (
            <span className="chip" title={t("session.header.profileTitle")}>
              <Bot size={11} aria-hidden />
              {tab.profile}
            </span>
          )}
          {branch && (
            <>
              <GitBranch size={12} aria-hidden />
              {branch}
            </>
          )}
          {tab.ended && <span className="badge">{t("session.header.ended")}</span>}
        </span>
      </div>
      <div className="session-tools">
        <fieldset className="segmented" aria-label={t("session.header.viewLabel")}>
          <button type="button" aria-pressed={view === "chat"} onClick={() => onViewChange("chat")}>
            <MessageSquare size={13} aria-hidden />
            {t("session.header.chat")}
          </button>
          <button type="button" aria-pressed={view === "graph"} onClick={() => onViewChange("graph")}>
            <Network size={13} aria-hidden />
            {t("session.header.graph")}
          </button>
          <button type="button" aria-pressed={view === "timeline"} onClick={() => onViewChange("timeline")}>
            <ChartGantt size={13} aria-hidden />
            {t("session.header.timeline")}
          </button>
        </fieldset>
        <IconButton
          label={t("session.header.terminal")}
          shortcut={menuShortcut("toggle-terminal")}
          pressed={terminalOpen}
          onClick={onToggleTerminal}
        >
          <SquareTerminal size={16} />
        </IconButton>
        <IconButton
          label={t("session.header.workspacePanel")}
          shortcut={menuShortcut("toggle-right-panel")}
          pressed={rightOpen}
          onClick={onToggleRight}
        >
          <PanelRight size={16} />
        </IconButton>
        <ActionMenu
          label={t("session.header.actions")}
          items={[
            { label: t("session.header.rename"), onSelect: () => setEditing(tab.title) },
            { label: t("session.header.fork"), onSelect: onFork },
            { label: t("session.header.setup"), onSelect: onOpenSetup },
            { label: t("session.header.close"), shortcut: menuShortcut("close-session"), onSelect: onClose },
          ]}
        />
      </div>
    </header>
  );
}
