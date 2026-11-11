import type { MemoryFile } from "@agentchainer/protocol";
import { ExternalLink, Loader2, RefreshCw, Save, Sparkles, Undo2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { joinPath } from "../files.ts";
import { count } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Markdown } from "../Markdown.tsx";
import { approxTokens, firstFile, groupFiles } from "../memory/memory.ts";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";

const MarkdownEditor = lazy(() => import("../MarkdownEditor.tsx"));

type View = "edit" | "split" | "preview";
type Loaded = { file: MemoryFile; text: string; sha256: string | null };

const GROUP_TITLE = {
  project: () => t("setup.memory.groupProject"),
  local: () => t("setup.memory.groupLocal"),
  folder: () => t("setup.memory.groupFolders"),
  user: () => t("setup.memory.groupUser"),
} as const;

/** "12 lines · about 340 tokens", or why the file can't be opened, or that it isn't there yet. */
function sizeOf(f: MemoryFile): string {
  if (f.refused) return f.refused;
  if (!f.exists) return t("setup.memory.notYet");
  return t("setup.memory.size", { lines: count(f.lines), tokens: count(approxTokens(f.bytes)) });
}

/**
 * Workspace settings → CLAUDE.md (CP-03): the CLAUDE.md files Claude loads here, in an editor with a live preview. A
 * save is a History run that Roll back undoes; the user's own file, for every project, is only shown (ADR-0013).
 */
export function Memory({
  cwd,
  confirm,
  notLoaded,
  onDirty,
  onChanged,
  onGenerate,
  onOpenFile,
}: {
  cwd: string;
  confirm: Confirm;
  /** A folder of a multi-folder workspace that isn't its primary one: Claude doesn't load its CLAUDE.md there. */
  notLoaded: boolean;
  /** Whether there are unsaved edits, so leaving the section can ask first. */
  onDirty: (dirty: boolean) => void;
  /** After a save: History reloads. */
  onChanged: () => void;
  /** Opens the setup plan on its CLAUDE.md generator. */
  onGenerate: () => void;
  onOpenFile: (file: string) => Promise<void>;
}) {
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<View>("split");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; warnings: string[] } | null>(null);
  const dirty = loaded !== null && draft !== loaded.text;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const open = useCallback(
    async (f: MemoryFile) => {
      setError(null);
      if (f.refused) {
        setLoaded({ file: f, text: "", sha256: null });
        setDraft("");
        return;
      }
      try {
        const r = await request("memory.read", f.kind === "user" ? { cwd, user: true } : { cwd, path: f.path });
        setLoaded({ file: f, text: r.text, sha256: r.sha256 });
        setDraft(r.text);
      } catch (err) {
        setError(String(err));
      }
    },
    [cwd],
  );

  const list = useCallback(async () => {
    try {
      const next = (await request("memory.files", { cwd })).files;
      setFiles(next);
      return next;
    } catch (err) {
      setError(String(err));
      return [];
    }
  }, [cwd]);

  useEffect(() => {
    void list().then((next) => {
      const first = firstFile(next);
      if (first) void open(first);
    });
  }, [list, open]);

  async function pick(f: MemoryFile) {
    if (f.path === loaded?.file.path) return;
    if (dirty && !(await confirmDiscard())) return;
    setNotice(null);
    await open(f);
  }

  const confirmDiscard = () =>
    confirm({
      title: t("setup.memory.discardTitle"),
      body: t("setup.memory.discardBody", { path: loaded?.file.path ?? "" }),
      confirmLabel: t("setup.memory.discard"),
      danger: true,
    });

  async function save() {
    if (!loaded || loaded.file.kind === "user" || !dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await request("memory.save", {
        cwd,
        path: loaded.file.path,
        text: draft,
        baseSha256: loaded.sha256,
      });
      setNotice({ text: t("setup.memory.saved", { path: loaded.file.path }), warnings: r.warnings });
      const next = await list();
      const file = next.find((f) => f.path === loaded.file.path) ?? loaded.file;
      setLoaded({ file, text: draft, sha256: r.sha256 });
      onChanged();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (!loaded) return;
    if (dirty && !(await confirmDiscard())) return;
    setNotice(null);
    await open(loaded.file);
  }

  const file = loaded?.file;
  const readOnly = file?.kind === "user";
  const shownView: View = readOnly ? "preview" : view;
  const absolute = file ? (file.absolute ?? joinPath(cwd, file.path)) : null;
  const lines = draft ? draft.split("\n").length : 0;
  const bytes = new TextEncoder().encode(draft).length;

  return (
    <div className="memory">
      {notLoaded && <p className="callout setup-pad memory-banner">{t("setup.memory.notLoaded")}</p>}
      <div className="plan-split">
        <div className="plan-list">
          {!files && <p className="muted setup-pad">{t("setup.memory.loading")}</p>}
          {files &&
            groupFiles(files).map((g) => (
              <section key={g.kind} className="plugin-group">
                <h4 className="muted">{GROUP_TITLE[g.kind]()}</h4>
                <ul className="plugin-rows">
                  {g.files.map((f) => (
                    <li key={f.path} className={`plan-row${f.path === file?.path ? " focused" : ""}`}>
                      <button
                        type="button"
                        className="plan-row-main"
                        aria-current={f.path === file?.path}
                        onClick={() => void pick(f)}
                      >
                        <span className="plan-title memory-path">{f.path}</span>
                        <span className="plan-meta">{sizeOf(f)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>

        <section className="memory-detail" aria-label={t("setup.memory.details")}>
          {!file && <EmptyState>{t("setup.memory.pick")}</EmptyState>}
          {file && (
            <>
              <div className="memory-bar">
                <code className="memory-path" title={absolute ?? undefined}>
                  {file.path}
                </code>
                {readOnly && <span className="badge">{t("setup.memory.readOnly")}</span>}
                {dirty && <span className="badge tone-busy">{t("setup.memory.unsaved")}</span>}
                <span className="grow" />
                {!readOnly && !file.refused && (
                  <fieldset className="segmented">
                    <legend className="sr-only">{t("setup.memory.view")}</legend>
                    {(["edit", "split", "preview"] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={view === v ? "active" : undefined}
                        aria-pressed={view === v}
                        onClick={() => setView(v)}
                      >
                        {v === "edit"
                          ? t("setup.memory.viewEdit")
                          : v === "split"
                            ? t("setup.memory.viewSplit")
                            : t("setup.memory.viewPreview")}
                      </button>
                    ))}
                  </fieldset>
                )}
                {absolute && file.exists && !file.refused && (
                  <IconButton
                    label={t("setup.memory.openInEditor")}
                    onClick={() => void onOpenFile(absolute).catch((err) => setError(String(err)))}
                  >
                    <ExternalLink size={15} />
                  </IconButton>
                )}
                <IconButton label={t("setup.memory.reload")} onClick={() => void reload()}>
                  <RefreshCw size={15} />
                </IconButton>
              </div>

              <p className="field-help memory-about">
                {file.kind === "project"
                  ? t("setup.memory.aboutProject")
                  : file.kind === "local"
                    ? t("setup.memory.aboutLocal")
                    : file.kind === "folder"
                      ? t("setup.memory.aboutFolder", { folder: file.path.replace(/\/CLAUDE\.md$/, "") })
                      : t("setup.memory.aboutUser")}
              </p>

              {file.refused && <p className="warn">{file.refused}</p>}
              {!file.exists && file.kind === "project" && (
                <div className="callout memory-start">
                  <p>{t("setup.memory.missing")}</p>
                  <button type="button" className="secondary small" onClick={onGenerate}>
                    <Sparkles size={14} />
                    {t("setup.memory.generate")}
                  </button>
                </div>
              )}
              {!file.exists && file.kind === "user" && <p className="muted">{t("setup.memory.noUserFile")}</p>}
              {error && <p className="warn">{error}</p>}
              {notice && (
                <div className="outcome-banner memory-notice">
                  <div className="grow">
                    <p>{notice.text}</p>
                    {notice.warnings.map((w) => (
                      <p key={w} className="warn">
                        {w}
                      </p>
                    ))}
                  </div>
                  <button type="button" className="ghost small" onClick={() => setNotice(null)}>
                    {t("setup.memory.dismiss")}
                  </button>
                </div>
              )}

              {!file.refused && (file.exists || file.kind !== "user") && (
                <div className={`memory-panes view-${shownView}`}>
                  {shownView !== "preview" && (
                    <div className="memory-pane">
                      <Suspense fallback={<p className="muted setup-pad">{t("setup.memory.loading")}</p>}>
                        <MarkdownEditor
                          value={draft}
                          label={t("setup.memory.editorLabel", { path: file.path })}
                          onChange={setDraft}
                          onSave={() => void save()}
                        />
                      </Suspense>
                    </div>
                  )}
                  {shownView !== "edit" && (
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable, so the keyboard can scroll it.
                    <section className="memory-pane memory-preview" aria-label={t("setup.memory.preview")} tabIndex={0}>
                      {draft.trim() ? (
                        <Markdown text={draft} />
                      ) : (
                        <p className="muted">{t("setup.memory.previewEmpty")}</p>
                      )}
                    </section>
                  )}
                </div>
              )}

              {!readOnly && !file.refused && (
                <div className="memory-actions">
                  <span className="muted memory-stats">
                    {t("setup.memory.size", { lines: count(lines), tokens: count(approxTokens(bytes)) })}
                  </span>
                  <span className="grow" />
                  <button
                    type="button"
                    className="secondary small"
                    disabled={!dirty || busy}
                    onClick={() => loaded && setDraft(loaded.text)}
                  >
                    <Undo2 size={14} />
                    {t("setup.memory.discardChanges")}
                  </button>
                  <button type="button" className="primary small" disabled={!dirty || busy} onClick={() => void save()}>
                    {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                    {t("setup.memory.save")}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
