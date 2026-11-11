import type { FileDiff } from "@agentchainer/protocol";
import { ArrowLeft, ExternalLink, MessageSquarePlus, Send, Trash2, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { type DiffComment, isStale } from "./diffComments.ts";
import { t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
import { languageFor, monaco, monacoTheme } from "./monaco.ts";
import { request } from "./sidecar.ts";
import { IconButton } from "./ui/IconButton.tsx";

/** Lines picked in one side of the diff. */
type Picked = { side: DiffComment["side"]; start: number; end: number };

/**
 * HEAD vs working tree for one file in a read-only Monaco diff (M1-27), with revert per file or per hunk through
 * git, each after a confirmation. Re-reads the file whenever `version` changes (the workspace listing refreshed).
 * Lines picked in either side can be commented on (CP-05); the chat's comments, on every file, go into its message
 * together.
 */
export default function DiffView({
  cwd,
  path,
  version,
  confirm,
  onClose,
  onOpenInEditor,
  comments = [],
  onComment,
  onRemoveComment,
  onSendComments,
}: {
  cwd: string;
  path: string;
  version: unknown;
  confirm: Confirm;
  onClose: () => void;
  onOpenInEditor: (line?: number) => void;
  /** The chat's comments on every file; this file's are shown and marked in the diff. */
  comments?: readonly DiffComment[];
  onComment?: (comment: Omit<DiffComment, "id">) => void;
  onRemoveComment?: (id: string) => void;
  /** Puts every comment into the chat's message. */
  onSendComments?: () => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const shownPath = useRef<string | null>(null);
  const marks = useRef<{
    old: monaco.editor.IEditorDecorationsCollection;
    new: monaco.editor.IEditorDecorationsCollection;
  } | null>(null);
  const mine = useMemo(() => comments.filter((c) => c.path === path), [comments, path]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the refresh trigger.
  useEffect(() => {
    let current = true;
    request("workspace.diff", { cwd, path })
      .then((d) => {
        if (!current) return;
        setDiff(d);
        setError(null);
      })
      .catch((err: unknown) => current && setError(String(err)));
    return () => {
      current = false;
    };
  }, [cwd, path, version]);

  useEffect(() => {
    if (!host.current) return;
    const ed = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      theme: monacoTheme(),
    });
    editor.current = ed;
    const sides = { old: ed.getOriginalEditor(), new: ed.getModifiedEditor() };
    marks.current = { old: sides.old.createDecorationsCollection(), new: sides.new.createDecorationsCollection() };
    // The lines picked last, in either side: a click picks one line, a drag or Shift+arrows several.
    const watch = (side: DiffComment["side"]) =>
      sides[side].onDidChangeCursorSelection((e) => {
        const s = e.selection;
        // A selection that ends at the start of a line doesn't take that line.
        const end = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
        setPicked({ side, start: s.startLineNumber, end });
      });
    const watchers = [watch("old"), watch("new")];
    return () => {
      for (const w of watchers) w.dispose();
      marks.current = null;
      const model = ed.getModel();
      ed.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    const ed = editor.current;
    if (!ed || !diff) return;
    const previous = ed.getModel();
    const original = diff.original ?? "";
    const modified = diff.modified ?? "";
    // A refresh with the same text keeps the models; one with new text keeps where the reader was.
    if (previous?.original.getValue() === original && previous.modified.getValue() === modified) return;
    // Only the same file keeps its scroll position; another file starts at the top.
    const view = previous && shownPath.current === path ? ed.saveViewState() : null;
    shownPath.current = path;
    const language = languageFor(path);
    ed.setModel({
      original: monaco.editor.createModel(original, language),
      modified: monaco.editor.createModel(modified, language),
    });
    if (view) ed.restoreViewState(view);
    previous?.original.dispose();
    previous?.modified.dispose();
    if (!view) {
      setPicked(null);
      setDraft(null);
    }
  }, [diff, path]);

  // This file's comments, marked on the lines they're about; set again when a new diff replaces the models.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `diff` is the trigger: decorations belong to a model.
  useEffect(() => {
    const m = marks.current;
    if (!m) return;
    const decorate = (side: DiffComment["side"]) =>
      mine
        .filter((c) => c.side === side)
        .map((c) => ({
          range: new monaco.Range(c.start, 1, c.end, 1),
          options: {
            isWholeLine: true,
            className: "diff-comment-line",
            linesDecorationsClassName: "diff-comment-gutter",
          },
        }));
    m.old.set(decorate("old"));
    m.new.set(decorate("new"));
  }, [mine, diff]);

  /** The text of one side now, to quote from and to tell a comment that's out of date. */
  const sideText = (side: DiffComment["side"]) => (side === "old" ? (diff?.original ?? "") : (diff?.modified ?? ""));

  function addComment() {
    if (!picked || !draft?.trim() || !onComment) return;
    const quote = sideText(picked.side)
      .split("\n")
      .slice(picked.start - 1, picked.end)
      .join("\n");
    onComment({ path, side: picked.side, start: picked.start, end: picked.end, quote, text: draft.trim() });
    setDraft(null);
  }

  const pickedLabel = picked
    ? picked.side === "old"
      ? t("panel.diff.pickedOld", { start: picked.start, end: picked.end, count: picked.end - picked.start + 1 })
      : t("panel.diff.pickedNew", { start: picked.start, end: picked.end, count: picked.end - picked.start + 1 })
    : "";

  async function revertFile() {
    if (!diff) return;
    const removes = diff.status === "untracked" || diff.status === "added";
    const ok = await confirm({
      title: removes ? t("panel.diff.deleteTitle") : t("panel.diff.revertTitle"),
      body: (
        <p>
          <Rich k={removes ? "panel.diff.deleteBody" : "panel.diff.revertBody"} params={{ path }} tags={{ code }} />
        </p>
      ),
      confirmLabel: removes ? t("panel.diff.deleteFile") : t("panel.diff.revertFile"),
      danger: true,
    });
    if (ok) await run(() => request("workspace.revert", { cwd, path }));
  }

  async function revertHunk(index: number) {
    const hunk = diff?.hunks[index];
    if (!hunk) return;
    const ok = await confirm({
      title: t("panel.diff.revertHunkTitle"),
      body: (
        <p>
          <Rich
            k="panel.diff.revertHunkBody"
            params={{ from: hunk.newStart, to: hunk.newStart + Math.max(hunk.newLines, 1) - 1, path }}
            tags={{ code }}
          />
        </p>
      ),
      confirmLabel: t("panel.diff.revertHunk"),
      danger: true,
    });
    if (ok) await run(() => request("workspace.revert", { cwd, path, hunk: index }));
  }

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setDiff(await request("workspace.diff", { cwd, path }));
    } catch (err) {
      setError(String(err));
    }
  }

  const unchanged = diff !== null && !diff.status;
  return (
    <div className="diff-view">
      <header className="diff-header">
        <button type="button" className="ghost small" onClick={onClose} aria-label={t("panel.diff.backLabel")}>
          <ArrowLeft size={14} />
          {t("panel.diff.back")}
        </button>
        <code className="grow diff-path" title={path}>
          {path}
        </code>
        {diff?.status && <span className="badge">{diff.status}</span>}
      </header>
      <div className="diff-actions">
        <button type="button" className="ghost small" onClick={() => onOpenInEditor(diff?.hunks[0]?.newStart)}>
          <ExternalLink size={14} />
          {t("panel.diff.openInEditor")}
        </button>
        {diff?.status && (
          <button type="button" className="ghost small" onClick={() => void revertFile()}>
            <Undo2 size={14} />
            {t("panel.diff.revertFile")}
          </button>
        )}
      </div>
      {error && <p className="warn">{error}</p>}
      {onComment && diff && !diff.binary && !diff.tooLarge && (
        <div className="diff-comments">
          {draft === null ? (
            <div className="diff-comment-bar">
              <span className="muted">{picked ? pickedLabel : t("panel.diff.pickLines")}</span>
              <span className="grow" />
              {picked && (
                <button type="button" className="ghost small" onClick={() => setDraft("")}>
                  <MessageSquarePlus size={14} />
                  {t("panel.diff.comment")}
                </button>
              )}
              {comments.length > 0 && onSendComments && (
                <button type="button" className="secondary small" onClick={onSendComments}>
                  <Send size={14} />
                  {t("panel.diff.addToMessage", { count: comments.length })}
                </button>
              )}
            </div>
          ) : (
            <form
              className="diff-comment-form"
              onSubmit={(e) => {
                e.preventDefault();
                addComment();
              }}
            >
              <label className="field">
                <span className="field-label">{t("panel.diff.commentOn", { lines: pickedLabel })}</span>
                <textarea
                  rows={3}
                  // biome-ignore lint/a11y/noAutofocus: the form opens on the person's click, to type in.
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      // The form's own Escape: it doesn't stop the chat's turn.
                      e.preventDefault();
                      e.stopPropagation();
                      setDraft(null);
                    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      addComment();
                    }
                  }}
                />
                <span className="field-help">{t("panel.diff.commentHint")}</span>
              </label>
              <div className="diff-comment-actions">
                <button type="submit" className="primary small" disabled={!draft.trim()}>
                  {t("panel.diff.addComment")}
                </button>
                <button type="button" className="ghost small" onClick={() => setDraft(null)}>
                  {t("panel.diff.cancelComment")}
                </button>
              </div>
            </form>
          )}
          {mine.length > 0 && (
            <ul className="diff-comment-list" aria-label={t("panel.diff.commentsLabel")}>
              {mine.map((c) => (
                <li key={c.id}>
                  <div className="diff-comment-head">
                    <span className="diff-comment-where">
                      {c.side === "old"
                        ? t("panel.diff.pickedOld", { start: c.start, end: c.end, count: c.end - c.start + 1 })
                        : t("panel.diff.pickedNew", { start: c.start, end: c.end, count: c.end - c.start + 1 })}
                    </span>
                    {isStale(c, sideText(c.side)) && <span className="badge">{t("panel.diff.changedSince")}</span>}
                    <span className="grow" />
                    {onRemoveComment && (
                      <IconButton label={t("panel.diff.removeComment")} onClick={() => onRemoveComment(c.id)}>
                        <Trash2 size={13} />
                      </IconButton>
                    )}
                  </div>
                  <p className="diff-comment-text">{c.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {diff?.binary && <p className="muted">{t("panel.diff.binary")}</p>}
      {diff?.tooLarge && <p className="muted">{t("panel.diff.tooLarge")}</p>}
      {unchanged && <p className="muted">{t("panel.diff.unchanged")}</p>}
      {diff && diff.hunks.length > 1 && (
        <ul className="hunks">
          {diff.hunks.map((h, i) => (
            <li key={h.header}>
              <code>{h.header.replace(/^(@@[^@]*@@).*$/, "$1")}</code>
              <button type="button" className="link" onClick={() => void revertHunk(i)}>
                {t("panel.diff.revert")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="diff-editor" ref={host} hidden={!!diff && (diff.binary || diff.tooLarge)} />
    </div>
  );
}

/** A `<code>` part of a message (`Rich`): the file's path. */
const code = (s: string) => <code>{s}</code>;
