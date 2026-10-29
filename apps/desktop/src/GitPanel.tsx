import type { Methods, WorkspaceFiles } from "@agentchainer/protocol";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { STATUS_LETTER } from "./files.ts";
import { request } from "./sidecar.ts";

type Branches = Methods["git.branches"]["result"];

/**
 * Git panel (M1-30) on the system git CLI: branch switch and create, stage and unstage, commit with a message Claude
 * drafts and the user edits, and push. There is no force push anywhere in the app.
 */
export function GitPanel({
  cwd,
  files,
  selected,
  confirm,
  onSelect,
  onRefresh,
}: {
  cwd: string;
  files: WorkspaceFiles | null;
  selected: string | null;
  confirm: Confirm;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}) {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadBranches = useCallback(async () => {
    try {
      setBranches(await request("git.branches", { cwd }));
    } catch (err) {
      setError(String(err));
    }
  }, [cwd]);

  // Branch and ahead/behind can change with any workspace change (commits from the terminal, the agent's git calls).
  useEffect(() => {
    if (files?.isGitRepo) void loadBranches();
  }, [files, loadBranches]);

  async function run(label: string, action: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await action();
      if (done) setNote(done);
      onRefresh();
      await loadBranches();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function draft() {
    setBusy("draft");
    setError(null);
    try {
      setMessage((await request("git.draftMessage", { cwd })).message);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function pushNow() {
    if (!branches?.current) return;
    const target = branches.upstream ?? `origin/${branches.current} (new, tracked from now on)`;
    const ok = await confirm({
      title: "Push this branch?",
      body: (
        <p>
          Pushes <code>{branches.current}</code> to <code>{target}</code>. A normal push only: if the remote has commits
          you don't have, it fails instead of overwriting them.
        </p>
      ),
      confirmLabel: "Push",
    });
    if (ok) await run("push", () => request("git.push", { cwd }), "Pushed.");
  }

  if (!files) return <p className="muted">Loading…</p>;
  if (!files.isGitRepo) return <p className="muted">Not a git repository. Use "Initialize git" above.</p>;

  const staged = files.files.filter((f) => f.staged);
  const unstaged = files.files.filter((f) => f.unstaged);
  const ahead = branches?.ahead ?? 0;
  const behind = branches?.behind ?? 0;

  return (
    <div className="git-panel">
      <div className="git-branch">
        <select
          value={branches?.current ?? ""}
          aria-label="Branch"
          disabled={busy !== null}
          onChange={(e) =>
            void run("switch", () => request("git.switch", { cwd, branch: e.target.value }), `On ${e.target.value}.`)
          }
        >
          {!branches?.current && <option value="">(detached)</option>}
          {branches?.branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        {branches?.upstream && (
          <span className="muted" title={`Tracking ${branches.upstream}`}>
            ↑{ahead} ↓{behind}
          </span>
        )}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const name = newBranch.trim();
          if (!name) return;
          setNewBranch("");
          void run("create", () => request("git.switch", { cwd, branch: name, create: true }), `Created ${name}.`);
        }}
      >
        <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="New branch name" />
        <button type="submit" className="secondary" disabled={!newBranch.trim() || busy !== null}>
          Create
        </button>
      </form>

      <h3>Staged ({staged.length})</h3>
      <FileList
        files={staged}
        selected={selected}
        onSelect={onSelect}
        action="−"
        actionLabel="Unstage"
        disabled={busy !== null}
        onAction={(paths) => void run("unstage", () => request("git.unstage", { cwd, paths }))}
      />
      <h3>Changes ({unstaged.length})</h3>
      <FileList
        files={unstaged}
        selected={selected}
        onSelect={onSelect}
        action="+"
        actionLabel="Stage"
        disabled={busy !== null}
        onAction={(paths) => void run("stage", () => request("git.stage", { cwd, paths }))}
      />

      <textarea
        className="commit-message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message"
        rows={4}
        aria-label="Commit message"
      />
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={staged.length === 0 || busy !== null}
          title="Claude (haiku) drafts a message from the staged diff; you can edit it"
          onClick={() => void draft()}
        >
          {busy === "draft" ? "Drafting…" : "Draft with Claude"}
        </button>
        <button
          type="button"
          disabled={staged.length === 0 || !message.trim() || busy !== null}
          onClick={() =>
            void run(
              "commit",
              async () => {
                const { sha } = await request("git.commit", { cwd, message });
                setMessage("");
                return sha;
              },
              "Committed.",
            )
          }
        >
          Commit
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!branches?.current || busy !== null || (branches.upstream !== null && ahead === 0)}
          onClick={() => void pushNow()}
        >
          {branches?.upstream ? `Push${ahead ? ` (${ahead})` : ""}` : "Publish branch"}
        </button>
      </div>
      {busy && busy !== "draft" && <p className="muted">Working…</p>}
      {note && <p className="muted">{note}</p>}
      {error && <p className="warn">{error}</p>}
    </div>
  );
}

function FileList({
  files,
  selected,
  onSelect,
  action,
  actionLabel,
  disabled,
  onAction,
}: {
  files: WorkspaceFiles["files"];
  selected: string | null;
  onSelect: (path: string) => void;
  action: string;
  actionLabel: string;
  disabled: boolean;
  onAction: (paths: string[]) => void;
}) {
  if (files.length === 0) return <p className="muted">None.</p>;
  return (
    <ul>
      {files.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            className={`tree-row file${selected === f.path ? " selected" : ""}`}
            title={f.path}
            onClick={() => onSelect(f.path)}
          >
            {f.path}
          </button>
          {f.status && <span className={`status ${f.status}`}>{STATUS_LETTER[f.status]}</span>}
          <button
            type="button"
            className="link"
            aria-label={`${actionLabel} ${f.path}`}
            title={actionLabel}
            disabled={disabled}
            onClick={() => onAction([f.path])}
          >
            {action}
          </button>
        </li>
      ))}
      {files.length > 1 && (
        <li>
          <button type="button" className="link" disabled={disabled} onClick={() => onAction(files.map((f) => f.path))}>
            {actionLabel} all
          </button>
        </li>
      )}
    </ul>
  );
}
