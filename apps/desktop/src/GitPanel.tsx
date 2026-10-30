import type { Methods, WorkspaceFiles } from "@agentchainer/protocol";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  GitBranch,
  GitMerge,
  Loader2,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { request } from "./sidecar.ts";
import { ActionMenu, type MenuAction } from "./ui/ActionMenu.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { EmptyState, Section } from "./ui/Section.tsx";
import { FileRow } from "./ui/TreeRow.tsx";

type Branches = Methods["git.branches"]["result"];

/**
 * Git panel (M1-30) on the system git CLI, laid out like an editor's source control view: the branch (a picker to
 * switch, create, check out a remote branch, merge, rename or delete), fetch and pull, a commit box with a message
 * Claude can draft, push, then staged and unstaged files. There is no force push anywhere in the app, and pull is
 * fast-forward only.
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

  async function mergeNow(branch: string) {
    if (!branches?.current) return;
    const ok = await confirm({
      title: `Merge ${branch}?`,
      body: (
        <p>
          Merges <code>{branch}</code> into <code>{branches.current}</code>. If files conflict, the merge stops so you
          can resolve them and commit, or abort it.
        </p>
      ),
      confirmLabel: "Merge",
    });
    if (!ok) return;
    await run("merge", async () => {
      const r = await request("git.merge", { cwd, branch });
      setNote(r.merged ? `Merged ${branch}.` : `Merge stopped on ${count(r.conflicts.length, "conflicted file")}.`);
    });
  }

  async function abortNow() {
    const ok = await confirm({
      title: "Abort the merge?",
      body: (
        <p>
          Puts <code>{branches?.current ?? "the branch"}</code> back as it was before the merge. Conflicts you've
          resolved so far are lost.
        </p>
      ),
      confirmLabel: "Abort merge",
      danger: true,
    });
    if (ok) await run("abort", () => request("git.abortMerge", { cwd }), "Merge aborted.");
  }

  async function deleteNow(branch: string) {
    const ok = await confirm({
      title: `Delete ${branch}?`,
      body: (
        <p>
          Deletes the local branch <code>{branch}</code>. A remote branch of the same name stays.
        </p>
      ),
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await run("delete", async () => {
      if (!(await request("git.deleteBranch", { cwd, branch })).deleted) {
        const force = await confirm({
          title: `${branch} has unmerged commits`,
          body: (
            <p>
              Some of its commits aren't merged into <code>{branches?.current ?? "HEAD"}</code> or its upstream.
              Deleting it anyway loses them.
            </p>
          ),
          confirmLabel: "Delete anyway",
          danger: true,
        });
        if (!force) return;
        await request("git.deleteBranch", { cwd, branch, force: true });
      }
      setNote(`Deleted ${branch}.`);
    });
  }

  if (!files) return <p className="muted">Loading…</p>;
  if (!files.isGitRepo) return <EmptyState icon={<GitBranch size={14} />}>Not a git repository.</EmptyState>;

  const staged = files.files.filter((f) => f.staged);
  const unstaged = files.files.filter((f) => f.unstaged);
  const ahead = branches?.ahead ?? 0;
  const idle = busy === null;
  const stage = (paths: string[]) => void run("stage", () => request("git.stage", { cwd, paths }));
  const unstage = (paths: string[]) => void run("unstage", () => request("git.unstage", { cwd, paths }));

  const merging = branches?.merging;

  return (
    <div className="git-panel">
      <div className="branch-bar">
        <BranchPicker
          branches={branches}
          disabled={!idle}
          onSwitch={(branch) => void run("switch", () => request("git.switch", { cwd, branch }), `On ${branch}.`)}
          onTrack={(remote) =>
            void run(
              "switch",
              () => request("git.switch", { cwd, branch: remote, track: true }),
              `On ${remote.slice(remote.indexOf("/") + 1)}, tracking ${remote}.`,
            )
          }
          onCreate={(branch) =>
            void run("create", () => request("git.switch", { cwd, branch, create: true }), `Created ${branch}.`)
          }
          onRename={(from, to) =>
            void run("rename", () => request("git.renameBranch", { cwd, from, to }), `Renamed to ${to}.`)
          }
          onMerge={(branch) => void mergeNow(branch)}
          onDelete={(branch) => void deleteNow(branch)}
        />
        <IconButton
          label="Fetch from every remote"
          disabled={!idle}
          onClick={() => void run("fetch", () => request("git.fetch", { cwd }), "Fetched.")}
        >
          {busy === "fetch" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
        </IconButton>
        <IconButton
          label={
            branches?.upstream
              ? `Pull from ${branches.upstream} (fast-forward only)`
              : "Pull: this branch has no upstream yet"
          }
          disabled={!idle || !branches?.upstream}
          onClick={() => void run("pull", () => request("git.pull", { cwd }), "Pulled.")}
        >
          {busy === "pull" ? <Loader2 size={14} className="spin" /> : <ArrowDownToLine size={14} />}
        </IconButton>
      </div>

      {merging && (
        <div className="merge-banner" role="status">
          <GitMerge size={14} aria-hidden />
          <span>
            Merging <code>{merging.branch ?? "a branch"}</code>.{" "}
            {merging.conflicts.length
              ? `Resolve ${count(merging.conflicts.length, "conflicted file")}, stage, and commit to finish.`
              : "No conflicts left: commit to finish."}
          </span>
          <button type="button" className="secondary small" disabled={!idle} onClick={() => void abortNow()}>
            Abort
          </button>
        </div>
      )}

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

/** "1 file", "3 files". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The current branch with its sync state. Opens a searchable list of local and remote branches: pick one to switch (a
 * remote one is checked out as a tracking branch), or use a branch's ⋯ menu to merge, rename or delete it. The input
 * doubles as the name field when creating or renaming.
 */
function BranchPicker({
  branches,
  disabled,
  onSwitch,
  onTrack,
  onCreate,
  onRename,
  onMerge,
  onDelete,
}: {
  branches: Branches | null;
  disabled: boolean;
  onSwitch: (branch: string) => void;
  onTrack: (remote: string) => void;
  onCreate: (branch: string) => void;
  onRename: (from: string, to: string) => void;
  onMerge: (branch: string) => void;
  onDelete: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const q = query.trim();
  const matches = (b: string) => b.toLowerCase().includes(q.toLowerCase());
  const local = (branches?.branches ?? []).filter(matches);
  const remote = (branches?.remote ?? []).filter(matches);
  const current = branches?.current ?? null;
  const naming = creating || renaming !== null;

  function close() {
    setOpen(false);
    setQuery("");
    setCreating(false);
    setRenaming(null);
  }

  function pick(branch: string) {
    close();
    if (branch !== current) onSwitch(branch);
  }

  function track(remoteBranch: string) {
    close();
    onTrack(remoteBranch);
  }

  /** Runs an action that continues outside the picker (a confirm dialog), after closing it. */
  function closeThen(action: () => void) {
    close();
    action();
  }

  function submitName() {
    if (!q) return;
    if (renaming !== null) {
      if (q !== renaming) closeThen(() => onRename(renaming, q));
    } else closeThen(() => onCreate(q));
  }

  function actions(b: string): MenuAction[] {
    const rename = {
      label: "Rename…",
      onSelect: () => {
        setRenaming(b);
        setQuery(b);
      },
    };
    if (b === current) {
      const upstream = branches?.upstream;
      // After a pull refused to fast-forward, this is the way to bring the upstream's commits in.
      return upstream && (branches?.behind ?? 0) > 0
        ? [{ label: `Merge ${upstream} into ${b}…`, onSelect: () => closeThen(() => onMerge(upstream)) }, rename]
        : [rename];
    }
    return [
      { label: `Merge into ${current ?? "HEAD"}…`, disabled: !current, onSelect: () => closeThen(() => onMerge(b)) },
      rename,
      { label: "Delete…", danger: true, onSelect: () => closeThen(() => onDelete(b)) },
    ];
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger asChild>
        <button type="button" className="branch-button" disabled={disabled || !branches}>
          <GitBranch size={14} className="branch-icon" />
          <span className="branch-name">{current ?? "Detached HEAD"}</span>
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
            current && <span className="badge">not published</span>
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
              if (naming) submitName();
              else if (local.length === 1 && remote.length === 0 && local[0]) pick(local[0]);
              else if (remote.length === 1 && local.length === 0 && remote[0]) track(remote[0]);
            }}
          >
            {creating ? (
              <Plus size={13} aria-hidden />
            ) : renaming !== null ? (
              <Pencil size={13} aria-hidden />
            ) : (
              <Search size={13} aria-hidden />
            )}
            <input
              // Remounts when the mode changes, so the field takes focus again (also after the ⋯ menu closes).
              key={creating ? "create" : (renaming ?? "search")}
              // biome-ignore lint/a11y/noAutofocus: the picker was just opened, or switched mode, to type in it.
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={creating ? "New branch name" : renaming !== null ? "New name" : "Search branches"}
              aria-label={
                creating ? "New branch name" : renaming !== null ? `New name for ${renaming}` : "Search branches"
              }
              spellCheck={false}
            />
          </form>
          {naming ? (
            <div className="branch-create-hint">
              <span className="muted">
                {renaming !== null ? (
                  <>
                    Rename <code>{renaming}</code>. Enter renames it.
                  </>
                ) : (
                  <>
                    From <code>{current ?? "HEAD"}</code>. Enter creates it and switches to it.
                  </>
                )}
              </span>
              <button type="button" className="small" disabled={!q || q === renaming} onClick={submitName}>
                {renaming !== null ? "Rename branch" : "Create branch"}
              </button>
            </div>
          ) : (
            <>
              <div className="branch-lists">
                {local.length > 0 && remote.length > 0 && <div className="branch-group">Local</div>}
                <ul className="branch-list" aria-label="Local branches">
                  {local.map((b) => (
                    <li key={b} className="branch-row">
                      <button type="button" className="branch-item" onClick={() => pick(b)}>
                        {b === current ? <Check size={14} /> : <span className="branch-check" />}
                        <span>{b}</span>
                      </button>
                      <span className="branch-actions">
                        <ActionMenu label={`Actions for ${b}`} items={actions(b)} />
                      </span>
                    </li>
                  ))}
                  {local.length === 0 && remote.length === 0 && (
                    <li className="muted branch-none">No branch matches.</li>
                  )}
                </ul>
                {remote.length > 0 && (
                  <>
                    <div className="branch-group">Remote</div>
                    <ul className="branch-list" aria-label="Remote branches">
                      {remote.map((b) => (
                        <li key={b} className="branch-row">
                          <button
                            type="button"
                            className="branch-item"
                            title={`Check out as a local branch that tracks ${b}`}
                            onClick={() => track(b)}
                          >
                            <span className="branch-check" />
                            <span>{b}</span>
                          </button>
                          <span className="branch-actions">
                            <ActionMenu
                              label={`Actions for ${b}`}
                              items={[
                                {
                                  label: `Merge into ${current ?? "HEAD"}…`,
                                  disabled: !current,
                                  onSelect: () => closeThen(() => onMerge(b)),
                                },
                              ]}
                            />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
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
