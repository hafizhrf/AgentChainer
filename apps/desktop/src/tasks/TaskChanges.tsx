import type { Task, TaskFileChange } from "@agentchainer/protocol";
import { FileDiff, FileMinus, FilePlus, Loader2, MessageSquareText, Wrench } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { type Confirm, Modal } from "../Dialog.tsx";
import { type DiffComment, toFeedback } from "../diffComments.ts";
import { joinPath } from "../files.ts";
import { approxUsd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { agentLabel } from "./stepAgent.ts";

const DiffView = lazy(() => import("../DiffView.tsx"));

/** A task's comments while the app runs, per task: leaving its page and coming back keeps them. */
const kept = new Map<string, DiffComment[]>();

/** The states a "Fix as commented" round can follow (the sidecar checks the same). */
const FIXABLE = new Set<Task["state"]>(["done", "accepted", "failed", "unverified", "cancelled"]);

const usd = (n: number) => approxUsd(n, n < 0.1 ? 4 : 2);
const fileKey = (f: { path: string; folder?: string | undefined }) => (f.folder ? `${f.folder}:${f.path}` : f.path);
const commentKey = (c: DiffComment) => fileKey({ path: c.path, folder: c.dir });

const STATUS = {
  new: { icon: FilePlus, word: () => t("tasks.changes.statusNew") },
  modified: { icon: FileDiff, word: () => t("tasks.changes.statusModified") },
  deleted: { icon: FileMinus, word: () => t("tasks.changes.statusDeleted") },
} as const;

/** Why the person can't fix this task as commented, or null when they can. */
function readOnlyReason(task: Task): string | null {
  if (task.parent || task.subtasks?.length) return t("tasks.changes.readOnlyXl");
  if (task.variantOf || task.variants?.length) return t("tasks.changes.readOnlyVariant");
  if (task.mergedInto || task.pr?.merged) return t("tasks.changes.readOnlyMerged");
  if (!FIXABLE.has(task.state)) return t("tasks.changes.readOnlyState");
  return null;
}

/**
 * A task's changes against its base (CP-05 part 2): the files it changed, each opening a diff whose lines can be
 * commented on, and **Fix as commented**, a round in which the implementer gets the comments (built like Fix CI's).
 */
export function TaskChanges({
  task,
  cwd,
  confirm,
  onChanged,
  onError,
  onOpenFile,
}: {
  task: Task;
  cwd: string;
  confirm: Confirm;
  onChanged: (task: Task) => void;
  onError: (message: string) => void;
  onOpenFile: (file: string, line?: number) => void;
}) {
  const key = `${cwd}\0${task.id}`;
  const [files, setFiles] = useState<TaskFileChange[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<TaskFileChange | null>(null);
  const [comments, setCommentsNow] = useState<DiffComment[]>(() => kept.get(key) ?? []);
  const [asking, setAsking] = useState(false);
  const readOnly = readOnlyReason(task);

  const setComments = (update: (all: DiffComment[]) => DiffComment[]) =>
    setCommentsNow((all) => {
      const next = update(all);
      kept.set(key, next);
      return next;
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the task changes.
  useEffect(() => {
    let live = true;
    request("task.changes", { cwd, id: task.id }).then(
      (r) => {
        if (!live) return;
        setFiles(r.files);
        setProblem(null);
      },
      (err: unknown) => live && setProblem(String(err)),
    );
    return () => {
      live = false;
    };
  }, [cwd, task.id, task.updatedAt]);

  const commented = new Set(comments.map(commentKey));
  const countOn = (f: TaskFileChange) => comments.filter((c) => commentKey(c) === fileKey(f)).length;

  return (
    <section className="card task-changes" aria-labelledby={`changes-${task.id}`}>
      <div className="card-title">
        <FileDiff size={16} aria-hidden />
        <h2 id={`changes-${task.id}`}>{t("tasks.changes.title")}</h2>
        <span className="muted">{readOnly ? t("tasks.changes.subtitleReadOnly") : t("tasks.changes.subtitle")}</span>
      </div>
      {problem && <p className="warn">{problem}</p>}
      {!files && !problem && (
        <p className="muted">
          <Loader2 size={14} className="spin" /> {t("tasks.changes.loading")}
        </p>
      )}
      {files && !files.length && <p className="muted">{t("tasks.changes.none")}</p>}

      {open ? (
        <div className="task-diff">
          <Suspense fallback={<Loader2 size={16} className="spin" />}>
            <DiffView
              cwd={open.dir}
              path={open.path}
              version={task.updatedAt}
              confirm={confirm}
              canRevert={false}
              load={() =>
                request("task.fileDiff", {
                  cwd,
                  id: task.id,
                  path: open.path,
                  ...(open.folder ? { folder: open.folder } : {}),
                })
              }
              onClose={() => setOpen(null)}
              onOpenInEditor={(line) => onOpenFile(joinPath(open.dir, open.path), line)}
              comments={comments.filter((c) => (c.dir ?? "") === (open.folder ?? ""))}
              {...(readOnly
                ? {}
                : {
                    onComment: (c: Omit<DiffComment, "id">) =>
                      setComments((all) => [
                        ...all,
                        { ...c, id: crypto.randomUUID(), ...(open.folder ? { dir: open.folder } : {}) },
                      ]),
                    onRemoveComment: (id: string) => setComments((all) => all.filter((c) => c.id !== id)),
                  })}
            />
          </Suspense>
        </div>
      ) : (
        files &&
        files.length > 0 && (
          <ul className="task-change-list" aria-label={t("tasks.changes.listLabel")}>
            {files.map((f) => {
              const s = STATUS[f.status];
              const n = countOn(f);
              return (
                <li key={fileKey(f)}>
                  <button type="button" className="task-change" onClick={() => setOpen(f)}>
                    <s.icon size={14} className={`task-change-icon is-${f.status}`} aria-hidden />
                    <span className="sr-only">{s.word()}</span>
                    <span className="task-change-path">
                      {f.folder && <span className="muted">{t("tasks.changes.inFolder", { folder: f.folder })}</span>}
                      <code>{f.path}</code>
                    </span>
                    <span className="grow" />
                    {commented.has(fileKey(f)) && (
                      <span className="badge">
                        <MessageSquareText size={12} aria-hidden />
                        {t("tasks.changes.comments", { count: n })}
                      </span>
                    )}
                    <span className="muted task-change-counts">
                      {f.added === null
                        ? t("tasks.changes.binary")
                        : t("tasks.changes.counts", { added: f.added, removed: f.removed ?? 0 })}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      )}

      <div className="card-footer">
        {readOnly ? (
          <span className="muted">{readOnly}</span>
        ) : (
          <span className="muted">
            {comments.length ? t("tasks.changes.waiting", { count: comments.length }) : t("tasks.changes.howTo")}
          </span>
        )}
        <span className="grow" />
        {comments.length > 0 && (
          <button type="button" className="ghost" onClick={() => setComments(() => [])}>
            {t("tasks.changes.clear")}
          </button>
        )}
        {!readOnly && (
          <button type="button" disabled={!comments.length} onClick={() => setAsking(true)}>
            <Wrench size={14} />
            {comments.length ? t("tasks.changes.fix", { count: comments.length }) : t("tasks.changes.fixNone")}
          </button>
        )}
      </div>
      <FixDialog
        open={asking}
        task={task}
        cwd={cwd}
        comments={comments}
        onOpenChange={setAsking}
        onStarted={(started) => {
          setComments(() => []);
          setOpen(null);
          onChanged(started);
        }}
        onError={onError}
      />
    </section>
  );
}

/** What a "Fix as commented" round will do, with an optional note, before it starts. */
function FixDialog({
  open,
  task,
  cwd,
  comments,
  onOpenChange,
  onStarted,
  onError,
}: {
  open: boolean;
  task: Task;
  cwd: string;
  comments: DiffComment[];
  onOpenChange: (open: boolean) => void;
  onStarted: (task: Task) => void;
  onError: (message: string) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const implementer = [...(task.run?.steps ?? [])].reverse().find((s) => s.kind === "agent" && s.role === "implement");
  const budget = task.triage?.budgetUsd;
  const pr = task.pr && !task.pr.merged ? task.pr : null;
  async function start() {
    setBusy(true);
    try {
      const started = await request("task.feedback", {
        cwd,
        id: task.id,
        comments: toFeedback(comments),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      onOpenChange(false);
      onStarted(started);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("tasks.changes.dialogTitle")}
      description={t("tasks.changes.dialogIntro")}
      actions={
        <>
          <button type="button" className="secondary" onClick={() => onOpenChange(false)}>
            {t("tasks.changes.cancel")}
          </button>
          <button type="button" disabled={busy || !comments.length} onClick={() => void start()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Wrench size={14} />}
            {t("tasks.changes.start")}
          </button>
        </>
      }
    >
      <p>{t("tasks.changes.summary", { count: comments.length })}</p>
      <ul className="task-fix-comments">
        {comments.map((c) => (
          <li key={c.id} className="task-fix-comment">
            <code>{commentKey(c)}</code>
            <span className="muted">
              {c.side === "old"
                ? t("panel.diff.pickedOld", { start: c.start, end: c.end, count: c.end - c.start + 1 })
                : t("panel.diff.pickedNew", { start: c.start, end: c.end, count: c.end - c.start + 1 })}
            </span>
            <p className="task-fix-comment-text">{c.text}</p>
          </li>
        ))}
      </ul>
      <Field label={t("tasks.changes.note")} help={t("tasks.changes.noteHelp")}>
        <textarea
          rows={3}
          value={note}
          maxLength={4000}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("tasks.changes.notePlaceholder")}
        />
      </Field>
      <ul className="task-fix-facts">
        {implementer && (
          <li>{t("tasks.changes.runsOn", { agent: agentLabel(implementer.agent, implementer.model) })}</li>
        )}
        <li>
          {budget === null || budget === undefined
            ? t("tasks.changes.noBudget")
            : t("tasks.changes.budgetLeft", { amount: usd(Math.max(0, budget - task.costUsd)) })}
        </li>
        <li>{pr ? t("tasks.changes.afterPr", { number: pr.number }) : t("tasks.changes.afterLocal")}</li>
      </ul>
    </Modal>
  );
}
