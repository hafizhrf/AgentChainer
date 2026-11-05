import type { Methods, WorkspaceFiles } from "@agentchainer/protocol";
import * as Popover from "@radix-ui/react-popover";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  GitBranch,
  GitMerge,
  Loader2,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
import { request } from "./sidecar.ts";
import type { MenuAction } from "./ui/ActionMenu.tsx";
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
    const target = branches.upstream ?? t("panel.git.newUpstream", { branch: branches.current });
    const ok = await confirm({
      title: t("panel.git.pushTitle"),
      body: (
        <p>
          <Rich k="panel.git.pushBody" params={{ branch: branches.current, target }} tags={{ code }} />
        </p>
      ),
      confirmLabel: t("panel.git.push"),
    });
    if (ok) await run("push", () => request("git.push", { cwd }), t("panel.git.pushed"));
  }

  async function mergeNow(branch: string) {
    if (!branches?.current) return;
    const ok = await confirm({
      title: t("panel.git.mergeTitle", { branch }),
      body: (
        <p>
          <Rich k="panel.git.mergeBody" params={{ branch, into: branches.current }} tags={{ code }} />
        </p>
      ),
      confirmLabel: t("panel.git.merge"),
    });
    if (!ok) return;
    await run("merge", async () => {
      const r = await request("git.merge", { cwd, branch });
      setNote(
        r.merged ? t("panel.git.merged", { branch }) : t("panel.git.mergeStopped", { count: r.conflicts.length }),
      );
    });
  }

  async function abortNow() {
    const ok = await confirm({
      title: t("panel.git.abortTitle"),
      body: (
        <p>
          <Rich
            k="panel.git.abortBody"
            params={{ branch: branches?.current ?? t("panel.git.theBranch") }}
            tags={{ code }}
          />
        </p>
      ),
      confirmLabel: t("panel.git.abortConfirm"),
      danger: true,
    });
    if (ok) await run("abort", () => request("git.abortMerge", { cwd }), t("panel.git.aborted"));
  }

  async function deleteNow(branch: string) {
    const ok = await confirm({
      title: t("panel.git.deleteTitle", { branch }),
      body: (
        <p>
          <Rich k="panel.git.deleteBody" params={{ branch }} tags={{ code }} />
        </p>
      ),
      confirmLabel: t("panel.git.delete"),
      danger: true,
    });
    if (!ok) return;
    await run("delete", async () => {
      if (!(await request("git.deleteBranch", { cwd, branch })).deleted) {
        const force = await confirm({
          title: t("panel.git.unmergedTitle", { branch }),
          body: (
            <p>
              <Rich k="panel.git.unmergedBody" params={{ into: branches?.current ?? "HEAD" }} tags={{ code }} />
            </p>
          ),
          confirmLabel: t("panel.git.deleteAnyway"),
          danger: true,
        });
        if (!force) return;
        await request("git.deleteBranch", { cwd, branch, force: true });
      }
      setNote(t("panel.git.deleted", { branch }));
    });
  }

  if (!files) return <p className="muted">{t("panel.git.loading")}</p>;
  if (!files.isGitRepo) return <EmptyState icon={<GitBranch size={14} />}>{t("panel.git.notRepo")}</EmptyState>;

  // A conflicted file has both sides in git's index, but it isn't staged until it's resolved and added.
  const staged = files.files.filter((f) => f.staged && f.status !== "conflicted");
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
          onSwitch={(branch) =>
            void run("switch", () => request("git.switch", { cwd, branch }), t("panel.git.switched", { branch }))
          }
          onTrack={(remote) =>
            void run(
              "switch",
              () => request("git.switch", { cwd, branch: remote, track: true }),
              t("panel.git.tracking", { branch: remote.slice(remote.indexOf("/") + 1), remote }),
            )
          }
          onCreate={(branch) =>
            void run(
              "create",
              () => request("git.switch", { cwd, branch, create: true }),
              t("panel.git.created", { branch }),
            )
          }
          onRename={(from, to) =>
            void run(
              "rename",
              () => request("git.renameBranch", { cwd, from, to }),
              t("panel.git.renamed", { branch: to }),
            )
          }
          onMerge={(branch) => void mergeNow(branch)}
          onDelete={(branch) => void deleteNow(branch)}
        />
        <IconButton
          label={t("panel.git.fetch")}
          disabled={!idle}
          onClick={() => void run("fetch", () => request("git.fetch", { cwd }), t("panel.git.fetched"))}
        >
          {busy === "fetch" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
        </IconButton>
        <IconButton
          label={
            branches?.upstream ? t("panel.git.pull", { upstream: branches.upstream }) : t("panel.git.pullNoUpstream")
          }
          disabled={!idle || !branches?.upstream}
          onClick={() =>
            void run("pull", async () => {
              const r = await request("git.pull", { cwd });
              // git's own output, in English whatever the UI's language.
              setNote(/already up to date/i.test(r.output) ? t("panel.git.upToDate") : t("panel.git.pulled"));
            })
          }
        >
          {busy === "pull" ? <Loader2 size={14} className="spin" /> : <ArrowDownToLine size={14} />}
        </IconButton>
      </div>

      {merging && (
        <div className="merge-banner" role="status">
          <GitMerge size={14} aria-hidden />
          <span>
            {merging.conflicts.length ? (
              <Rich
                k="panel.git.mergingConflicts"
                params={{ branch: merging.branch ?? t("panel.git.aBranch"), count: merging.conflicts.length }}
                tags={{ code }}
              />
            ) : (
              <Rich
                k="panel.git.mergingClean"
                params={{ branch: merging.branch ?? t("panel.git.aBranch") }}
                tags={{ code }}
              />
            )}
          </span>
          <button type="button" className="secondary small" disabled={!idle} onClick={() => void abortNow()}>
            {t("panel.git.abort")}
          </button>
        </div>
      )}

      <div className="commit-box">
        <div className="commit-input">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={staged.length ? t("panel.git.commitPlaceholder") : t("panel.git.stageFirstPlaceholder")}
            rows={3}
            aria-label={t("panel.git.commitMessageLabel")}
          />
          <IconButton
            label={busy === "draft" ? t("panel.git.drafting") : t("panel.git.draft")}
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
                t("panel.git.committed"),
              )
            }
          >
            <Check size={14} />
            {staged.length ? t("panel.git.commitStaged", { n: staged.length }) : t("panel.git.commit")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!branches?.current || !idle || (branches.upstream !== null && ahead === 0)}
            title={
              branches?.upstream ? t("panel.git.pushTo", { upstream: branches.upstream }) : t("panel.git.publishTitle")
            }
            onClick={() => void pushNow()}
          >
            <Upload size={14} />
            {branches?.upstream
              ? ahead
                ? t("panel.git.pushAhead", { n: ahead })
                : t("panel.git.push")
              : t("panel.git.publish")}
          </button>
        </div>
        {(busy || note || error) && (
          <p className={`git-status${error ? " error" : ""}`} role="status">
            {error ?? (busy && busy !== "draft" ? t("panel.git.working") : note)}
          </p>
        )}
      </div>

      <Section
        id="git.staged"
        title={t("panel.git.staged")}
        count={staged.length}
        actions={
          staged.length > 0 && (
            <IconButton
              label={t("panel.git.unstageAll")}
              disabled={!idle}
              onClick={() => unstage(staged.map((f) => f.path))}
            >
              <Minus size={14} />
            </IconButton>
          )
        }
      >
        {staged.length === 0 ? (
          <EmptyState>{t("panel.git.nothingStaged")}</EmptyState>
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
                  <IconButton label={t("panel.git.unstage")} disabled={!idle} onClick={() => unstage([f.path])}>
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
        title={t("panel.git.changes")}
        count={unstaged.length}
        actions={
          unstaged.length > 0 && (
            <IconButton
              label={t("panel.git.stageAll")}
              disabled={!idle}
              onClick={() => stage(unstaged.map((f) => f.path))}
            >
              <Plus size={14} />
            </IconButton>
          )
        }
      >
        {unstaged.length === 0 ? (
          <EmptyState icon={<CircleCheck size={14} />}>{t("panel.git.clean")}</EmptyState>
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
                  <IconButton label={t("panel.git.stage")} disabled={!idle} onClick={() => stage([f.path])}>
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

/** A `<code>` part of a message (`Rich`): branch names and refs. */
const code = (s: string) => <code>{s}</code>;

/**
 * The current branch with its sync state. Opens a searchable list of local and remote branches: pick one to switch (a
 * remote one is checked out as a tracking branch), or use a branch's ⋯ to merge, rename or delete it. The input
 * doubles as the name field when creating or renaming. A branch's actions are a view inside the picker, not a nested
 * menu: a dropdown opened from inside the popover closed the popover, and itself with it.
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
  const [actionsFor, setActionsFor] = useState<string | null>(null);
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
    setActionsFor(null);
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
      label: t("panel.git.renameAction"),
      onSelect: () => {
        setActionsFor(null);
        setRenaming(b);
        setQuery(b);
      },
    };
    const mergeInto = {
      label: t("panel.git.mergeInto", { branch: current ?? "HEAD" }),
      disabled: !current,
      onSelect: () => closeThen(() => onMerge(b)),
    };
    if (remoteBranch(b)) return [mergeInto];
    if (b === current) {
      const upstream = branches?.upstream;
      // After a pull refused to fast-forward, this is the way to bring the upstream's commits in.
      return upstream && (branches?.behind ?? 0) > 0
        ? [
            {
              label: t("panel.git.mergeUpstream", { upstream, branch: b }),
              onSelect: () => closeThen(() => onMerge(upstream)),
            },
            rename,
          ]
        : [rename];
    }
    return [
      mergeInto,
      rename,
      { label: t("panel.git.deleteAction"), danger: true, onSelect: () => closeThen(() => onDelete(b)) },
    ];
  }

  const remoteBranch = (b: string) => branches?.remote.includes(b) ?? false;
  const more = (b: string) => (
    <span className="branch-actions">
      <button
        type="button"
        className="ghost icon"
        aria-label={t("panel.git.actionsFor", { branch: b })}
        title={t("panel.git.actionsFor", { branch: b })}
        onClick={() => setActionsFor(b)}
      >
        <MoreHorizontal size={16} />
      </button>
    </span>
  );

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger asChild>
        <button type="button" className="branch-button" disabled={disabled || !branches}>
          <GitBranch size={14} className="branch-icon" />
          <span className="branch-name">{current ?? t("panel.git.detached")}</span>
          {branches?.upstream ? (
            <span className="branch-sync" title={t("panel.git.comparedWith", { upstream: branches.upstream })}>
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
            current && <span className="badge">{t("panel.git.notPublished")}</span>
          )}
          <ChevronDown size={14} className="branch-chevron" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="branch-popover" align="start" sideOffset={4}>
          {actionsFor !== null ? (
            <div className="branch-lists">
              <button type="button" className="branch-item branch-back" onClick={() => setActionsFor(null)}>
                <ArrowLeft size={14} />
                <span>{actionsFor}</span>
              </button>
              <ul className="branch-list" aria-label={t("panel.git.actionsFor", { branch: actionsFor })}>
                {actions(actionsFor).map((a, i) => (
                  <li key={a.label}>
                    <button
                      type="button"
                      className={`branch-item${a.danger ? " branch-danger" : ""}`}
                      disabled={a.disabled}
                      // biome-ignore lint/a11y/noAutofocus: the view was opened to pick one of these actions.
                      autoFocus={i === 0}
                      onClick={a.onSelect}
                    >
                      <span className="branch-check" />
                      <span>{a.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
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
                  // Remounts when the mode changes, so the field takes focus again (also coming back from a branch's actions).
                  key={creating ? "create" : (renaming ?? "search")}
                  // biome-ignore lint/a11y/noAutofocus: the picker was just opened, or switched mode, to type in it.
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    creating
                      ? t("panel.git.newBranchName")
                      : renaming !== null
                        ? t("panel.git.newName")
                        : t("panel.git.searchBranches")
                  }
                  aria-label={
                    creating
                      ? t("panel.git.newBranchName")
                      : renaming !== null
                        ? t("panel.git.newNameFor", { branch: renaming })
                        : t("panel.git.searchBranches")
                  }
                  spellCheck={false}
                />
              </form>
              {naming ? (
                <div className="branch-create-hint">
                  <span className="muted">
                    {renaming !== null ? (
                      <Rich k="panel.git.renameHint" params={{ branch: renaming }} tags={{ code }} />
                    ) : (
                      <Rich k="panel.git.createHint" params={{ branch: current ?? "HEAD" }} tags={{ code }} />
                    )}
                  </span>
                  <button type="button" className="small" disabled={!q || q === renaming} onClick={submitName}>
                    {renaming !== null ? t("panel.git.renameBranch") : t("panel.git.createBranch")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="branch-lists">
                    {local.length > 0 && remote.length > 0 && (
                      <div className="branch-group">{t("panel.git.local")}</div>
                    )}
                    <ul className="branch-list" aria-label={t("panel.git.localBranches")}>
                      {local.map((b) => (
                        <li key={b} className="branch-row">
                          <button type="button" className="branch-item" onClick={() => pick(b)}>
                            {b === current ? <Check size={14} /> : <span className="branch-check" />}
                            <span>{b}</span>
                          </button>
                          {more(b)}
                        </li>
                      ))}
                      {local.length === 0 && remote.length === 0 && (
                        <li className="muted branch-none">{t("panel.git.noMatch")}</li>
                      )}
                    </ul>
                    {remote.length > 0 && (
                      <>
                        <div className="branch-group">{t("panel.git.remote")}</div>
                        <ul className="branch-list" aria-label={t("panel.git.remoteBranches")}>
                          {remote.map((b) => (
                            <li key={b} className="branch-row">
                              <button
                                type="button"
                                className="branch-item"
                                title={t("panel.git.trackTitle", { branch: b })}
                                onClick={() => track(b)}
                              >
                                <span className="branch-check" />
                                <span>{b}</span>
                              </button>
                              {more(b)}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                  <button type="button" className="branch-item branch-new" onClick={() => setCreating(true)}>
                    <Plus size={14} />
                    {q ? t("panel.git.newBranchNamed", { name: q }) : t("panel.git.newBranch")}
                  </button>
                </>
              )}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
