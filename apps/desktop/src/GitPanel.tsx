import type { Methods, WorkspaceFiles } from "@agentchainer/protocol";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  GitBranch,
  Loader2,
  Minus,
  Plus,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { request } from "./sidecar.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { EmptyState, Section } from "./ui/Section.tsx";
import { FileRow } from "./ui/TreeRow.tsx";

type Branches = Methods["git.branches"]["result"];

/**
 * Git panel (M1-30) on the system git CLI, laid out like an editor's source control view: the branch (switch or create
 * from a picker), a commit box with a message Claude can draft, push, then staged and unstaged files. There is no
 * force push anywhere in the app.
 */
export function GitPanel({
  cwd,
  files,
  selected,
  confirm,
  onSelect,
  onRefresh,
  openAction,
}: {
  cwd: string;
  files: WorkspaceFiles | null;
  selected: string | null;
  confirm: Confirm;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  /** The row action that opens a file in the user's editor. */
  openAction: (path: string) => ReactNode;
}) {
  const [branches, setBranches] = useState<Branches | null>(null);
  const [message, setMessage] = useState("");
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
  if (!files.isGitRepo) return <EmptyState icon={<GitBranch size={14} />}>Not a git repository.</EmptyState>;

  const staged = files.files.filter((f) => f.staged);
  const unstaged = files.files.filter((f) => f.unstaged);
  const ahead = branches?.ahead ?? 0;
  const idle = busy === null;
  const stage = (paths: string[]) => void run("stage", () => request("git.stage", { cwd, paths }));
  const unstage = (paths: string[]) => void run("unstage", () => request("git.unstage", { cwd, paths }));

  return (
    <div className="git-panel">
      <BranchPicker
        branches={branches}
        disabled={!idle}
        onSwitch={(branch) => void run("switch", () => request("git.switch", { cwd, branch }), `On ${branch}.`)}
        onCreate={(branch) =>
          void run("create", () => request("git.switch", { cwd, branch, create: true }), `Created ${branch}.`)
        }
      />

      <div className="commit-box">
        <div className="commit-input">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={staged.length ? "Commit message" : "Stage files, then write a message"}
            rows={3}
            aria-label="Commit message"
          />
          <IconButton
            label={busy === "draft" ? "Drafting…" : "Draft with Claude (haiku), from the staged diff"}
            className="commit-draft"
            disabled={staged.length === 0 || !idle}
            onClick={() => void draft()}
          >
            {busy === "draft" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
          </IconButton>
        </div>
        <div className="commit-actions">
          <button
            type="button"
            className="grow"
            disabled={staged.length === 0 || !message.trim() || !idle}
            onClick={() =>
              void run(
                "commit",
                async () => {
                  await request("git.commit", { cwd, message });
                  setMessage("");
                },
                "Committed.",
              )
            }
          >
            <Check size={14} />
            {staged.length ? `Commit ${staged.length} staged` : "Commit"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!branches?.current || !idle || (branches.upstream !== null && ahead === 0)}
            title={branches?.upstream ? `Push to ${branches.upstream}` : "Publish this branch to origin"}
            onClick={() => void pushNow()}
          >
            <Upload size={14} />
            {branches?.upstream ? `Push${ahead ? ` ${ahead}` : ""}` : "Publish"}
          </button>
        </div>
        {(busy || note || error) && (
          <p className={`git-status${error ? " error" : ""}`} role="status">
            {error ?? (busy && busy !== "draft" ? "Working…" : note)}
          </p>
        )}
      </div>

      <Section
        id="git.staged"
        title="Staged"
        count={staged.length}
        actions={
          staged.length > 0 && (
            <IconButton label="Unstage all" disabled={!idle} onClick={() => unstage(staged.map((f) => f.path))}>
              <Minus size={14} />
            </IconButton>
          )
        }
      >
        {staged.length === 0 ? (
          <EmptyState>Nothing staged. Stage files with + below.</EmptyState>
        ) : (
          staged.map((f) => (
            <FileRow
              key={f.path}
              path={f.path}
              status={f.status}
              selected={selected === f.path}
              onSelect={() => onSelect(f.path)}
              actions={
                <>
                  {f.status !== "deleted" && openAction(f.path)}
                  <IconButton label="Unstage" disabled={!idle} onClick={() => unstage([f.path])}>
                    <Minus size={14} />
                  </IconButton>
                </>
              }
            />
          ))
        )}
      </Section>
      <Section
        id="git.changes"
        title="Changes"
        count={unstaged.length}
        actions={
          unstaged.length > 0 && (
            <IconButton label="Stage all" disabled={!idle} onClick={() => stage(unstaged.map((f) => f.path))}>
              <Plus size={14} />
            </IconButton>
          )
        }
      >
        {unstaged.length === 0 ? (
          <EmptyState icon={<CircleCheck size={14} />}>Working tree clean.</EmptyState>
        ) : (
          unstaged.map((f) => (
            <FileRow
              key={f.path}
              path={f.path}
              status={f.status}
              selected={selected === f.path}
              onSelect={() => onSelect(f.path)}
              actions={
                <>
                  {f.status !== "deleted" && openAction(f.path)}
                  <IconButton label="Stage" disabled={!idle} onClick={() => stage([f.path])}>
                    <Plus size={14} />
                  </IconButton>
                </>
              }
            />
          ))
        )}
      </Section>
    </div>
  );
}

/** The current branch with its sync state; opens a searchable list to switch, or a name field to create one. */
function BranchPicker({
  branches,
  disabled,
  onSwitch,
  onCreate,
}: {
  branches: Branches | null;
  disabled: boolean;
  onSwitch: (branch: string) => void;
  onCreate: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const q = query.trim();
  const list = (branches?.branches ?? []).filter((b) => b.toLowerCase().includes(q.toLowerCase()));

  function close() {
    setOpen(false);
    setQuery("");
    setCreating(false);
  }

  function pick(branch: string) {
    close();
    if (branch !== branches?.current) onSwitch(branch);
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger asChild>
        <button type="button" className="branch-button" disabled={disabled || !branches}>
          <GitBranch size={14} className="branch-icon" />
          <span className="branch-name">{branches?.current ?? "Detached HEAD"}</span>
          {branches?.upstream ? (
            <span className="branch-sync" title={`Compared with ${branches.upstream}`}>
              <span>
                <ArrowUp size={12} />
                {branches.ahead}
              </span>
              <span>
                <ArrowDown size={12} />
                {branches.behind}
              </span>
            </span>
          ) : (
            branches?.current && <span className="badge">not published</span>
          )}
          <ChevronDown size={14} className="branch-chevron" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="branch-popover" align="start" sideOffset={4}>
          <form
            className="branch-search"
            onSubmit={(e) => {
              e.preventDefault();
              if (creating && q) {
                close();
                onCreate(q);
              } else if (list.length === 1 && list[0]) pick(list[0]);
            }}
          >
            {creating ? <Plus size={13} aria-hidden /> : <Search size={13} aria-hidden />}
            <input
              // biome-ignore lint/a11y/noAutofocus: the picker was just opened to type in it.
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={creating ? "New branch name" : "Search branches"}
              aria-label={creating ? "New branch name" : "Search branches"}
              spellCheck={false}
            />
          </form>
          {creating ? (
            <div className="branch-create-hint">
              <span className="muted">
                From <code>{branches?.current ?? "HEAD"}</code>. Enter creates it and switches to it.
              </span>
              <button
                type="button"
                className="small"
                disabled={!q}
                onClick={() => {
                  close();
                  onCreate(q);
                }}
              >
                Create branch
              </button>
            </div>
          ) : (
            <>
              <ul className="branch-list" aria-label="Branches">
                {list.map((b) => (
                  <li key={b}>
                    <button type="button" className="branch-item" onClick={() => pick(b)}>
                      {b === branches?.current ? <Check size={14} /> : <span className="branch-check" />}
                      <span>{b}</span>
                    </button>
                  </li>
                ))}
                {list.length === 0 && <li className="muted branch-none">No branch matches.</li>}
              </ul>
              <button type="button" className="branch-item branch-new" onClick={() => setCreating(true)}>
                <Plus size={14} />
                {q ? `New branch “${q}”…` : "New branch…"}
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
