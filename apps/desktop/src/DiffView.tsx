import type { FileDiff } from "@agentchainer/protocol";
import { ArrowLeft, ExternalLink, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { languageFor, monaco, monacoTheme } from "./monaco.ts";
import { request } from "./sidecar.ts";

/**
 * HEAD vs working tree for one file in a read-only Monaco diff (M1-27), with revert per file or per hunk through
 * git, each after a confirmation. Re-reads the file whenever `version` changes (the workspace listing refreshed).
 */
export default function DiffView({
  cwd,
  path,
  version,
  confirm,
  onClose,
  onOpenInEditor,
}: {
  cwd: string;
  path: string;
  version: unknown;
  confirm: Confirm;
  onClose: () => void;
  onOpenInEditor: (line?: number) => void;
}) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const shownPath = useRef<string | null>(null);

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
    return () => {
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
  }, [diff, path]);

  async function revertFile() {
    if (!diff) return;
    const removes = diff.status === "untracked" || diff.status === "added";
    const ok = await confirm({
      title: removes ? "Delete this new file?" : "Revert this file?",
      body: (
        <p>
          <code>{path}</code>{" "}
          {removes
            ? "isn't in the last commit, so reverting deletes it."
            : "goes back to how it is in the last commit (HEAD). Staged changes to it are dropped too."}
        </p>
      ),
      confirmLabel: removes ? "Delete file" : "Revert file",
      danger: true,
    });
    if (ok) await run(() => request("workspace.revert", { cwd, path }));
  }

  async function revertHunk(index: number) {
    const hunk = diff?.hunks[index];
    if (!hunk) return;
    const ok = await confirm({
      title: "Revert this change?",
      body: (
        <p>
          Lines {hunk.newStart}–{hunk.newStart + Math.max(hunk.newLines, 1) - 1} of <code>{path}</code> go back to the
          last commit. The rest of the file stays as it is.
        </p>
      ),
      confirmLabel: "Revert change",
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
        <button type="button" className="ghost small" onClick={onClose} aria-label="Back to the workspace panel">
          <ArrowLeft size={14} />
          Back
        </button>
        <code className="grow diff-path" title={path}>
          {path}
        </code>
        {diff?.status && <span className="badge">{diff.status}</span>}
      </header>
      <div className="diff-actions">
        <button type="button" className="ghost small" onClick={() => onOpenInEditor(diff?.hunks[0]?.newStart)}>
          <ExternalLink size={14} />
          Open in editor
        </button>
        {diff?.status && (
          <button type="button" className="ghost small" onClick={() => void revertFile()}>
            <Undo2 size={14} />
            Revert file
          </button>
        )}
      </div>
      {error && <p className="warn">{error}</p>}
      {diff?.binary && <p className="muted">Binary file: no text diff.</p>}
      {diff?.tooLarge && <p className="muted">This file is too large to diff here. Open it in your editor.</p>}
      {unchanged && <p className="muted">No changes since the last commit.</p>}
      {diff && diff.hunks.length > 1 && (
        <ul className="hunks">
          {diff.hunks.map((h, i) => (
            <li key={h.header}>
              <code>{h.header.replace(/^(@@[^@]*@@).*$/, "$1")}</code>
              <button type="button" className="link" onClick={() => void revertHunk(i)}>
                Revert
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="diff-editor" ref={host} hidden={!!diff && (diff.binary || diff.tooLarge)} />
    </div>
  );
}
