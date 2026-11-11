import type { WorkspaceFiles } from "@agentchainer/protocol";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleCheck,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { FileMenu } from "./FileMenu.tsx";
import { agentEdits, buildTree, filterTree, folderPaths, visibleRows } from "./files.ts";
import { GitPanel } from "./GitPanel.tsx";
import { count } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
import { PreviewPane } from "./PreviewPane.tsx";
import { PANEL_TAB_LABEL, PANEL_TABS, type PanelTab, pickTab, toggleHidden, visibleTabs } from "./panelTabs.ts";
import { SetupSummary } from "./setup/SetupSummary.tsx";
import { request } from "./sidecar.ts";
import type { Item } from "./transcript.ts";
import { FileIcon } from "./ui/FileIcon.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { EmptyState, Section } from "./ui/Section.tsx";
import { FileRow, TreeRow } from "./ui/TreeRow.tsx";
import { menuShortcut } from "./useMenuCommands.ts";

export type { PanelTab } from "./panelTabs.ts";

/**
 * The right panel of a session (UX-03): the changes panel (M1-26) with the agent's edits per turn plus everything git
 * sees as changed, the file tree with git status (M1-25), git (M1-30) and a summary of the workspace setup (M2-08),
 * whose full page (Workspace settings) opens in the main area. Tabs can be hidden from the ⋯ menu or by right-clicking
 * the tab bar (`panelTabs.ts`). Loaded lazily: the file icons are large.
 */
export function WorkspacePanel({
  cwd,
  files,
  error,
  items,
  selected,
  confirm,
  onSelect,
  onOpenFile,
  onRefresh,
  onOpenSetup,
  hiddenTabs,
  onHiddenTabsChange,
  onHidePanel,
  initialTab = "changes",
  preview,
  comments = 0,
  onSendComments,
}: {
  cwd: string;
  files: WorkspaceFiles | null;
  error: string | null;
  items: Item[];
  selected: string | null;
  confirm: Confirm;
  onSelect: (path: string) => void;
  /** Opens a workspace-relative path in the user's editor (M1-28). */
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onOpenSetup: () => void;
  /** Tabs the user hid; shared by every session's panel. */
  hiddenTabs: readonly PanelTab[];
  onHiddenTabsChange: (hidden: PanelTab[]) => void;
  onHidePanel: () => void;
  initialTab?: PanelTab;
  /** The app being built (UX-22): its address, the ones the chat printed, and a count that opens the tab. */
  preview: { url: string | null; detected: readonly string[]; opened: number; onUrlChange: (url: string) => void };
  /** Comments waiting on the diff's lines (CP-05), and how to put them into the chat's message. */
  comments?: number;
  onSendComments?: () => void;
}) {
  const [view, setView] = useState<PanelTab>(initialTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const visible = visibleTabs(hiddenTabs);
  const active = pickTab(view, visible);
  // A failed git init or file-menu action (UX-21), shown above the tabs' content.
  const [actionError, setActionError] = useState<string | null>(null);
  const changed = files?.files.filter((f) => f.status) ?? [];
  // The open tab stays in view when the bar is narrower than its tabs.
  const tabList = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `active` is the trigger; the element is read from the DOM.
  useEffect(() => {
    tabList.current?.querySelector('[data-state="active"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  // "Open preview" switches to the tab, showing it again if it was hidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request opens the tab.
  useEffect(() => {
    if (!preview.opened) return;
    if (hiddenTabs.includes("preview")) onHiddenTabsChange(hiddenTabs.filter((x) => x !== "preview"));
    setView("preview");
  }, [preview.opened]);

  async function initGit() {
    try {
      await request("workspace.gitInit", { cwd });
      onRefresh();
    } catch (err) {
      setActionError(String(err));
    }
  }

  /** A row's right-click menu (UX-21): open, reveal, copy its path. */
  const withMenu = (path: string, row: ReactNode, folder = false) => (
    <FileMenu key={path} cwd={cwd} path={path} folder={folder} onOpenFile={onOpenFile} onError={setActionError}>
      {row}
    </FileMenu>
  );

  const openAction = (path: string) => (
    <IconButton label={t("panel.workspace.openInEditor")} tabIndex={-1} onClick={() => onOpenFile(path)}>
      <ExternalLink size={13} />
    </IconButton>
  );

  return (
    <Tabs.Root className="workspace-panel" value={active} onValueChange={(v) => setView(v as PanelTab)}>
      <div className="panel-tabbar">
        <Tabs.List
          ref={tabList}
          className="panel-tabs"
          aria-label={t("panel.workspace.tabsLabel")}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
        >
          {visible.map((tab) => (
            <Tabs.Trigger key={tab} value={tab}>
              {PANEL_TAB_LABEL[tab]}
              {tab === "changes" && changed.length > 0 && <span className="count">{changed.length}</span>}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <IconButton label={t("panel.workspace.refresh")} onClick={onRefresh}>
          <RefreshCw size={14} />
        </IconButton>
        <TabsMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          hidden={hiddenTabs}
          onChange={onHiddenTabsChange}
          onHidePanel={onHidePanel}
        />
      </div>
      <div className="panel-body">
        {(error || actionError) && <p className="warn">{error ?? actionError}</p>}
        {files && !files.isGitRepo && active !== "preview" && (
          <p className="warn">
            <Rich
              k="panel.workspace.notGit"
              tags={{
                button: (s) => (
                  <button type="button" className="link" onClick={() => void initGit()}>
                    {s}
                  </button>
                ),
              }}
            />
          </p>
        )}
        {visible.includes("changes") && (
          <Tabs.Content value="changes">
            {comments > 0 && onSendComments && (
              <p className="banner diff-comments-pending" role="status">
                <span className="grow">{t("panel.changes.commentsWaiting", { count: comments })}</span>
                <button type="button" className="secondary small" onClick={onSendComments}>
                  {t("panel.changes.addToMessage")}
                </button>
              </p>
            )}
            <ChangesView
              files={changed}
              items={items}
              cwd={cwd}
              selected={selected}
              onSelect={onSelect}
              openAction={openAction}
              withMenu={withMenu}
            />
          </Tabs.Content>
        )}
        {visible.includes("files") && (
          <Tabs.Content value="files" className="files-content">
            <FileTree
              files={files}
              selected={selected}
              onSelect={onSelect}
              openAction={openAction}
              withMenu={withMenu}
            />
          </Tabs.Content>
        )}
        {visible.includes("git") && (
          <Tabs.Content value="git">
            <GitPanel
              cwd={cwd}
              files={files}
              selected={selected}
              confirm={confirm}
              onSelect={onSelect}
              onRefresh={onRefresh}
              openAction={openAction}
            />
          </Tabs.Content>
        )}
        {visible.includes("preview") && (
          // Kept mounted, so the page isn't reloaded when another tab is looked at.
          <Tabs.Content value="preview" forceMount hidden={active !== "preview"} className="preview-content">
            <PreviewPane
              url={preview.url}
              detected={preview.detected}
              visible={active === "preview"}
              onUrlChange={preview.onUrlChange}
            />
          </Tabs.Content>
        )}
        {visible.includes("setup") && (
          <Tabs.Content value="setup">
            <SetupSummary cwd={cwd} onOpen={onOpenSetup} />
          </Tabs.Content>
        )}
      </div>
    </Tabs.Root>
  );
}

/**
 * Which tabs the panel shows (UX-03), like right-clicking VS Code's view bar. Opens from the ⋯ button or a right-click
 * on the tab bar; it stays open while tabs are toggled. The last visible tab can't be hidden.
 */
function TabsMenu({
  open,
  onOpenChange,
  hidden,
  onChange,
  onHidePanel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidden: readonly PanelTab[];
  onChange: (hidden: PanelTab[]) => void;
  onHidePanel: () => void;
}) {
  const shown = visibleTabs(hidden);
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="ghost icon"
          aria-label={t("panel.workspace.customizeTabs")}
          title={t("panel.workspace.customizeTabs")}
        >
          <MoreHorizontal size={14} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu-content" align="end" sideOffset={4}>
          <Menu.Label className="menu-label">{t("panel.workspace.showTabs")}</Menu.Label>
          {PANEL_TABS.map((tab) => {
            const checked = !hidden.includes(tab);
            return (
              <Menu.CheckboxItem
                key={tab}
                className="menu-item menu-check"
                checked={checked}
                disabled={checked && shown.length === 1}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => onChange(toggleHidden(hidden, tab))}
              >
                <span className="menu-check-box">
                  <Menu.ItemIndicator>
                    <Check size={13} />
                  </Menu.ItemIndicator>
                </span>
                {PANEL_TAB_LABEL[tab]}
              </Menu.CheckboxItem>
            );
          })}
          <Menu.Separator className="menu-separator" />
          <Menu.Item className="menu-item" disabled={hidden.length === 0} onSelect={() => onChange([])}>
            {t("panel.workspace.showAllTabs")}
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={onHidePanel}>
            {t("panel.workspace.hidePanel")}
            <kbd>{menuShortcut("toggle-right-panel")}</kbd>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

type OpenAction = (path: string) => ReactNode;
type WithMenu = (path: string, row: ReactNode, folder?: boolean) => ReactNode;

function ChangesView({
  files,
  items,
  cwd,
  selected,
  onSelect,
  openAction,
  withMenu,
}: {
  files: WorkspaceFiles["files"];
  items: Item[];
  cwd: string;
  selected: string | null;
  onSelect: (path: string) => void;
  openAction: OpenAction;
  withMenu: WithMenu;
}) {
  // Latest turn first: that's what the user is reviewing.
  const edits = useMemo(() => agentEdits(items, cwd).reverse(), [items, cwd]);
  const status = new Map(files.map((f) => [f.path, f.status]));
  const outside = (file: string) => file.startsWith("/") || /^[A-Za-z]:\\/.test(file);
  return (
    <div className="changes">
      <Section
        id="changes.agent"
        title={t("panel.changes.agentEdits")}
        count={edits.reduce((n, turn) => n + turn.files.length, 0)}
      >
        {edits.length === 0 ? (
          <EmptyState icon={<Bot size={14} />}>{t("panel.changes.noEdits")}</EmptyState>
        ) : (
          edits.map((turn) => (
            <div key={`${turn.prompt}-${turn.files.join()}`} className="turn-group">
              <div className="turn-label" title={turn.prompt}>
                {turn.prompt || t("panel.changes.earlier")}
              </div>
              {turn.files.map((file) => {
                const row = (
                  <FileRow
                    key={file}
                    path={file}
                    status={status.get(file)}
                    selected={selected === file}
                    outside={outside(file)}
                    onSelect={() => onSelect(file)}
                    {...(outside(file) ? {} : { actions: openAction(file) })}
                  />
                );
                return outside(file) || status.get(file) === "deleted" ? row : withMenu(file, row);
              })}
            </div>
          ))
        )}
      </Section>
      <Section id="changes.git" title={t("panel.changes.uncommitted")} count={files.length}>
        {files.length === 0 ? (
          <EmptyState icon={<CircleCheck size={14} />}>{t("panel.changes.noUncommitted")}</EmptyState>
        ) : (
          files.map((f) => {
            const row = (
              <FileRow
                key={f.path}
                path={f.path}
                status={f.status}
                selected={selected === f.path}
                onSelect={() => onSelect(f.path)}
                {...(f.status === "deleted" ? {} : { actions: openAction(f.path) })}
              />
            );
            return f.status === "deleted" ? row : withMenu(f.path, row);
          })
        )}
      </Section>
    </div>
  );
}

/**
 * The workspace tree, like an editor's explorer: file-type icons, indent guides, git status tints, a filter, and
 * keyboard navigation (↑/↓ to move, ←/→ to collapse and expand, Enter to open).
 */
function FileTree({
  files,
  selected,
  onSelect,
  openAction,
  withMenu,
}: {
  files: WorkspaceFiles | null;
  selected: string | null;
  onSelect: (path: string) => void;
  openAction: OpenAction;
  withMenu: WithMenu;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const tree = useMemo(() => buildTree(files?.files ?? []), [files]);
  const filtered = useMemo(() => filterTree(tree, query), [tree, query]);
  // While filtering, every folder with a match is open.
  const open = useMemo(() => (query.trim() ? new Set(folderPaths(filtered)) : expanded), [query, filtered, expanded]);
  const rows = useMemo(() => visibleRows(filtered, open), [filtered, open]);
  const current = Math.min(focus, Math.max(rows.length - 1, 0));

  if (!files) return <p className="muted">{t("panel.files.loading")}</p>;

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  function move(index: number) {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setFocus(next);
    rowRefs.current.get(next)?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const row = rows[current];
    if (!row) return;
    const folder = row.node.children !== undefined;
    const isOpen = open.has(row.node.path);
    switch (e.key) {
      case "ArrowDown":
        move(current + 1);
        break;
      case "ArrowUp":
        move(current - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (folder && isOpen) move(current + 1);
        else if (folder) toggle(row.node.path);
        break;
      case "ArrowLeft": {
        if (folder && isOpen) {
          toggle(row.node.path);
          break;
        }
        const parent = rows.findIndex((r) => r.node.path === row.node.path.split("/").slice(0, -1).join("/"));
        if (parent >= 0) move(parent);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div className="file-tree">
      <div className="tree-toolbar">
        <label className="tree-filter">
          <Search size={13} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(0);
              }
            }}
            placeholder={t("panel.files.filter")}
            aria-label={t("panel.files.filter")}
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="ghost icon tiny"
              aria-label={t("panel.files.clearFilter")}
              onClick={() => setQuery("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
        <IconButton label={t("panel.files.collapseAll")} onClick={() => setExpanded(new Set())}>
          <ChevronsDownUp size={14} />
        </IconButton>
      </div>
      {files.truncated && (
        <p className="muted small-print">{t("panel.files.truncated", { n: count(files.files.length) })}</p>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={<Search size={14} />}>
          {query ? t("panel.files.noMatch", { query: query.trim() }) : t("panel.files.empty")}
        </EmptyState>
      ) : (
        <div className="tree" role="tree" aria-label={t("panel.files.treeLabel")} onKeyDown={onKeyDown}>
          {rows.map(({ node, depth }, i) => {
            const folder = node.children !== undefined;
            const isOpen = folder && open.has(node.path);
            const deleted = node.file?.status === "deleted";
            const row = (
              <TreeRow
                depth={depth}
                chevron={folder ? isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                icon={<FileIcon path={node.name} folder={folder} />}
                name={node.name}
                status={node.file?.status}
                dot={folder && node.changes > 0}
                selected={selected === node.path}
                title={node.path}
                onClick={() => {
                  setFocus(i);
                  if (folder) toggle(node.path);
                  else onSelect(node.path);
                }}
                buttonRef={(el) => {
                  if (el) rowRefs.current.set(i, el);
                  else rowRefs.current.delete(i);
                }}
                buttonProps={{
                  role: "treeitem",
                  tabIndex: i === current ? 0 : -1,
                  "aria-level": depth + 1,
                  "aria-selected": selected === node.path,
                  ...(folder ? { "aria-expanded": isOpen } : {}),
                }}
                {...(folder || deleted ? {} : { actions: openAction(node.path) })}
              />
            );
            return (
              <div key={node.path} role="none">
                {deleted ? row : withMenu(node.path, row, folder)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
