import type { WorkspaceFiles } from "@agentchainer/protocol";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  CircleCheck,
  ExternalLink,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { agentEdits, buildTree, filterTree, folderPaths, visibleRows } from "./files.ts";
import { GitPanel } from "./GitPanel.tsx";
import { SetupSummary } from "./setup/SetupSummary.tsx";
import { request } from "./sidecar.ts";
import type { Item } from "./transcript.ts";
import { FileIcon } from "./ui/FileIcon.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { EmptyState, Section } from "./ui/Section.tsx";
import { FileRow, TreeRow } from "./ui/TreeRow.tsx";

export type PanelTab = "changes" | "files" | "git" | "permissions" | "setup";

/**
 * The right panel of a session (UX-03): the changes panel (M1-26) with the agent's edits per turn plus everything git
 * sees as changed, the file tree with git status (M1-25), git (M1-30), saved permission rules (M1-20) and a summary of
 * the workspace setup (M2-08), whose full page opens in the main area. Loaded lazily: the file icons are large.
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
  initialTab = "changes",
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
  initialTab?: PanelTab;
}) {
  const [view, setView] = useState<PanelTab>(initialTab);
  const [initError, setInitError] = useState<string | null>(null);
  const changed = files?.files.filter((f) => f.status) ?? [];

  async function initGit() {
    try {
      await request("workspace.gitInit", { cwd });
      onRefresh();
    } catch (err) {
      setInitError(String(err));
    }
  }

  const openAction = (path: string) => (
    <IconButton label="Open in editor" tabIndex={-1} onClick={() => onOpenFile(path)}>
      <ExternalLink size={13} />
    </IconButton>
  );

  return (
    <Tabs.Root className="workspace-panel" value={view} onValueChange={(v) => setView(v as PanelTab)}>
      <div className="panel-tabbar">
        <Tabs.List className="panel-tabs" aria-label="Workspace">
          <Tabs.Trigger value="changes">
            Changes{changed.length > 0 && <span className="count">{changed.length}</span>}
          </Tabs.Trigger>
          <Tabs.Trigger value="files">Files</Tabs.Trigger>
          <Tabs.Trigger value="git">Git</Tabs.Trigger>
          <Tabs.Trigger value="permissions">Rules</Tabs.Trigger>
          <Tabs.Trigger value="setup">Setup</Tabs.Trigger>
        </Tabs.List>
        <IconButton label="Refresh" onClick={onRefresh}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      <div className="panel-body">
        {(error || initError) && <p className="warn">{error ?? initError}</p>}
        {files && !files.isGitRepo && (
          <p className="warn">
            This folder isn't a git repository, so changes can't be reviewed or reverted.{" "}
            <button type="button" className="link" onClick={() => void initGit()}>
              Initialize git
            </button>
          </p>
        )}
        <Tabs.Content value="changes">
          <ChangesView
            files={changed}
            items={items}
            cwd={cwd}
            selected={selected}
            onSelect={onSelect}
            openAction={openAction}
          />
        </Tabs.Content>
        <Tabs.Content value="files" className="files-content">
          <FileTree files={files} selected={selected} onSelect={onSelect} openAction={openAction} />
        </Tabs.Content>
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
        <Tabs.Content value="permissions">
          <PermissionRules cwd={cwd} confirm={confirm} />
        </Tabs.Content>
        <Tabs.Content value="setup">
          <SetupSummary cwd={cwd} onOpen={onOpenSetup} />
        </Tabs.Content>
      </div>
    </Tabs.Root>
  );
}

type OpenAction = (path: string) => ReactNode;

function ChangesView({
  files,
  items,
  cwd,
  selected,
  onSelect,
  openAction,
}: {
  files: WorkspaceFiles["files"];
  items: Item[];
  cwd: string;
  selected: string | null;
  onSelect: (path: string) => void;
  openAction: OpenAction;
}) {
  // Latest turn first: that's what the user is reviewing.
  const edits = useMemo(() => agentEdits(items, cwd).reverse(), [items, cwd]);
  const status = new Map(files.map((f) => [f.path, f.status]));
  const outside = (file: string) => file.startsWith("/") || /^[A-Za-z]:\\/.test(file);
  return (
    <div className="changes">
      <Section id="changes.agent" title="Agent edits" count={edits.reduce((n, t) => n + t.files.length, 0)}>
        {edits.length === 0 ? (
          <EmptyState icon={<Bot size={14} />}>
            No file edits yet. Changes made by shell commands show under Uncommitted.
          </EmptyState>
        ) : (
          edits.map((turn) => (
            <div key={`${turn.prompt}-${turn.files.join()}`} className="turn-group">
              <div className="turn-label" title={turn.prompt}>
                {turn.prompt || "Earlier in the session"}
              </div>
              {turn.files.map((file) => (
                <FileRow
                  key={file}
                  path={file}
                  status={status.get(file)}
                  selected={selected === file}
                  outside={outside(file)}
                  onSelect={() => onSelect(file)}
                  {...(outside(file) ? {} : { actions: openAction(file) })}
                />
              ))}
            </div>
          ))
        )}
      </Section>
      <Section id="changes.git" title="Uncommitted" count={files.length}>
        {files.length === 0 ? (
          <EmptyState icon={<CircleCheck size={14} />}>No uncommitted changes.</EmptyState>
        ) : (
          files.map((f) => (
            <FileRow
              key={f.path}
              path={f.path}
              status={f.status}
              selected={selected === f.path}
              onSelect={() => onSelect(f.path)}
              {...(f.status === "deleted" ? {} : { actions: openAction(f.path) })}
            />
          ))
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
}: {
  files: WorkspaceFiles | null;
  selected: string | null;
  onSelect: (path: string) => void;
  openAction: OpenAction;
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

  if (!files) return <p className="muted">Loading…</p>;

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
            placeholder="Filter files"
            aria-label="Filter files"
            spellCheck={false}
          />
          {query && (
            <button
              type="button"
              className="ghost icon tiny"
              aria-label="Clear the filter"
              onClick={() => setQuery("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
        <IconButton label="Collapse all" onClick={() => setExpanded(new Set())}>
          <ChevronsDownUp size={14} />
        </IconButton>
      </div>
      {files.truncated && (
        <p className="muted small-print">Showing the first {files.files.length.toLocaleString()} files.</p>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={<Search size={14} />}>
          {query ? `No files match “${query.trim()}”.` : "This folder is empty."}
        </EmptyState>
      ) : (
        <div className="tree" role="tree" aria-label="Workspace files" onKeyDown={onKeyDown}>
          {rows.map(({ node, depth }, i) => {
            const folder = node.children !== undefined;
            const isOpen = folder && open.has(node.path);
            return (
              <div key={node.path} role="none">
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
                  {...(folder || node.file?.status === "deleted" ? {} : { actions: openAction(node.path) })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Behavior = "allow" | "ask" | "deny";
const BEHAVIOR_LABEL: Record<Behavior, string> = { allow: "Always allowed", ask: "Always ask", deny: "Always denied" };

/**
 * Permission rules saved by "Always allow" (M1-20), from `.claude/settings.local.json`. Removing one asks first; a
 * running session may keep using a rule it already loaded, so the change is certain from the next session on.
 */
function PermissionRules({ cwd, confirm }: { cwd: string; confirm: Confirm }) {
  const [rules, setRules] = useState<Record<Behavior, string[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRules(await request("permissions.list", { cwd }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(behavior: Behavior, rule: string) {
    const ok = await confirm({
      title: "Remove this rule?",
      body: (
        <p>
          <code>{rule}</code> is removed from <code>.claude/settings.local.json</code>. Claude will ask again for it,
          certainly in new sessions.
        </p>
      ),
      confirmLabel: "Remove rule",
    });
    if (!ok) return;
    try {
      await request("permissions.remove", { cwd, behavior, rule });
      await load();
    } catch (err) {
      setError(String(err));
    }
  }

  if (error) return <p className="warn">{error}</p>;
  if (!rules) return <p className="muted">Loading…</p>;
  const behaviors = (["allow", "ask", "deny"] as const).filter((b) => rules[b].length > 0);
  return (
    <div className="rules">
      {behaviors.length === 0 && (
        <EmptyState icon={<ShieldCheck size={14} />}>
          No saved rules. "Always allow" on an approval saves one here, in <code>.claude/settings.local.json</code> (not
          committed).
        </EmptyState>
      )}
      {behaviors.map((b) => (
        <Section key={b} id={`rules.${b}`} title={BEHAVIOR_LABEL[b]} count={rules[b].length}>
          {rules[b].map((rule) => (
            <div key={rule} className="tree-item">
              <code className="rule-text" title={rule}>
                {rule}
              </code>
              <span className="tree-actions">
                <IconButton label="Remove rule" onClick={() => void remove(b, rule)}>
                  <Trash2 size={13} />
                </IconButton>
              </span>
            </div>
          ))}
        </Section>
      ))}
    </div>
  );
}
