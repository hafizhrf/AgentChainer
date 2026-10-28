import type { WorkspaceFiles } from "@agentchainer/protocol";
import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { agentEdits, buildTree, STATUS_LETTER, type TreeNode } from "./files.ts";
import { request } from "./sidecar.ts";
import type { Item } from "./transcript.ts";

/**
 * Sidebar of a session tab: the workspace file tree with git status (M1-25), and the changes panel (M1-26) with the
 * agent's edits per turn plus everything git sees as changed.
 */
export function WorkspacePanel({
  cwd,
  files,
  error,
  items,
  selected,
  confirm,
  onSelect,
  onRefresh,
}: {
  cwd: string;
  files: WorkspaceFiles | null;
  error: string | null;
  items: Item[];
  selected: string | null;
  confirm: Confirm;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}) {
  const [view, setView] = useState<"files" | "changes" | "permissions">("changes");
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

  return (
    <div className="workspace-panel">
      <div className="panel-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === "changes"} onClick={() => setView("changes")}>
          Changes{changed.length > 0 ? ` (${changed.length})` : ""}
        </button>
        <button type="button" role="tab" aria-selected={view === "files"} onClick={() => setView("files")}>
          Files
        </button>
        <button type="button" role="tab" aria-selected={view === "permissions"} onClick={() => setView("permissions")}>
          Rules
        </button>
        <button type="button" className="refresh" title="Refresh" aria-label="Refresh files" onClick={onRefresh}>
          ↻
        </button>
      </div>
      {files?.branch && <div className="muted branch">⎇ {files.branch}</div>}
      {(error || initError) && <p className="warn">{error ?? initError}</p>}
      {files && !files.isGitRepo && (
        <div className="notice">
          This folder isn't a git repository, so changes can't be reviewed or reverted.{" "}
          <button type="button" className="link" onClick={() => void initGit()}>
            Initialize git
          </button>
        </div>
      )}
      {view === "changes" && (
        <ChangesView files={changed} items={items} cwd={cwd} selected={selected} onSelect={onSelect} />
      )}
      {view === "files" && <FileTree files={files} selected={selected} onSelect={onSelect} />}
      {view === "permissions" && <PermissionRules cwd={cwd} confirm={confirm} />}
    </div>
  );
}

function ChangesView({
  files,
  items,
  cwd,
  selected,
  onSelect,
}: {
  files: WorkspaceFiles["files"];
  items: Item[];
  cwd: string;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const edits = useMemo(() => agentEdits(items, cwd), [items, cwd]);
  return (
    <div className="changes">
      <h3>Working tree</h3>
      {files.length === 0 ? (
        <p className="muted">No uncommitted changes.</p>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f.path}>
              <FileButton path={f.path} label={f.path} selected={selected} onSelect={onSelect} />
              {f.status && <span className={`status ${f.status}`}>{STATUS_LETTER[f.status]}</span>}
            </li>
          ))}
        </ul>
      )}
      <h3>Edited by the agent</h3>
      {edits.length === 0 ? (
        <p className="muted">No file edits in this session yet. Changes made by shell commands only show above.</p>
      ) : (
        edits.map((turn, i) => (
          // Turns have no stable id of their own; their order never changes.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <div key={i} className="turn-edits">
            <div className="muted turn-prompt" title={turn.prompt}>
              {turn.prompt || "(earlier)"}
            </div>
            <ul>
              {turn.files.map((file) => (
                <li key={file}>
                  {file.startsWith("/") || /^[A-Za-z]:\\/.test(file) ? (
                    <span className="muted" title="Outside the workspace">
                      {file}
                    </span>
                  ) : (
                    <FileButton path={file} label={file} selected={selected} onSelect={onSelect} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: WorkspaceFiles | null;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files?.files ?? []), [files]);
  if (!files) return <p className="muted">Loading…</p>;

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((n) =>
      n.children ? (
        <li key={n.path}>
          <button
            type="button"
            className="tree-row folder"
            style={{ paddingLeft: `${depth * 0.8 + 0.3}rem` }}
            aria-expanded={expanded.has(n.path)}
            onClick={() => toggle(n.path)}
          >
            {expanded.has(n.path) ? "▾" : "▸"} {n.name}
            {n.changes > 0 && <span className="status modified">{n.changes}</span>}
          </button>
          {expanded.has(n.path) && <ul>{render(n.children, depth + 1)}</ul>}
        </li>
      ) : (
        <li key={n.path}>
          <FileButton
            path={n.path}
            label={n.name}
            selected={selected}
            onSelect={onSelect}
            style={{ paddingLeft: `${depth * 0.8 + 1.1}rem` }}
          />
          {n.file?.status && <span className={`status ${n.file.status}`}>{STATUS_LETTER[n.file.status]}</span>}
        </li>
      ),
    );

  return (
    <div className="file-tree">
      {files.truncated && <p className="muted">Showing the first {files.files.length.toLocaleString()} files.</p>}
      <ul>{render(tree, 0)}</ul>
    </div>
  );
}

function FileButton({
  path,
  label,
  selected,
  onSelect,
  style,
}: {
  path: string;
  label: string;
  selected: string | null;
  onSelect: (path: string) => void;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      className={`tree-row file${selected === path ? " selected" : ""}`}
      title={path}
      style={style}
      onClick={() => onSelect(path)}
    >
      {label}
    </button>
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
        <p className="muted">
          No saved rules. "Always allow" on an approval saves one here, in <code>.claude/settings.local.json</code> (not
          committed).
        </p>
      )}
      {behaviors.map((b) => (
        <div key={b}>
          <h3>{BEHAVIOR_LABEL[b]}</h3>
          <ul>
            {rules[b].map((rule) => (
              <li key={rule}>
                <code className="grow rule-text" title={rule}>
                  {rule}
                </code>
                <button
                  type="button"
                  className="link"
                  aria-label={`Remove ${rule}`}
                  onClick={() => void remove(b, rule)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <button type="button" className="link" onClick={() => void load()}>
        Reload
      </button>
    </div>
  );
}
