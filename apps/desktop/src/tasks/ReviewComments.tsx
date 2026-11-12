import type { ReviewThread, Task } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Loader2, MessagesSquare, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";

/** Where a thread is: its file, and its lines unless it's on the whole file. */
function whereOf(th: ReviewThread): string {
  if (th.fileLevel || th.end === undefined) return th.path;
  return th.start !== undefined && th.start !== th.end ? `${th.path}:${th.start}–${th.end}` : `${th.path}:${th.end}`;
}

/** The round each thread was sent in, from the task's GitHub rounds (CP-07). */
function sentRounds(task: Task): Map<string, number> {
  const sent = new Map<string, number>();
  for (const [i, round] of (task.run?.feedback ?? []).entries()) {
    if (round.source !== "github") continue;
    for (const id of round.threads ?? []) sent.set(id, i + 1);
  }
  return sent;
}

/**
 * The PR's review comments back to the agent (CP-07): the unresolved review threads, read through the person's own
 * `gh` when the PR area opens or on Refresh. The person picks which to send; a round fixes them like Fix as commented,
 * with the reviewers' words as data, and pushes to the PR when it ends Done. Nothing is posted to GitHub.
 */
export function ReviewComments({
  task,
  cwd,
  onChanged,
  onError,
}: {
  task: Task;
  cwd: string;
  onChanged: (task: Task) => void;
  onError: (message: string) => void;
}) {
  const [data, setData] = useState<{ threads: ReviewThread[]; capped: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const sent = sentRounds(task);

  const load = useCallback(() => {
    setLoading(true);
    request("task.reviewThreads", { cwd, id: task.id }).then(
      (r) => {
        setData(r);
        setProblem(null);
        // Unresolved threads are ticked, unless they're outdated (on an earlier commit).
        setPicked(new Set(r.threads.filter((th) => !th.resolved && !th.outdated).map((th) => th.id)));
        setLoading(false);
      },
      (err: unknown) => {
        setProblem(String(err));
        setLoading(false);
      },
    );
  }, [cwd, task.id]);

  // Read when the PR area opens; Refresh reads again. No polling: each read is a call to GitHub's API.
  useEffect(load, [load]);

  const open = data?.threads.filter((th) => !th.resolved) ?? [];
  const toggle = (id: string) =>
    setPicked((all) => {
      const next = new Set(all);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function start() {
    setBusy(true);
    try {
      const started = await request("task.fixReviewComments", {
        cwd,
        id: task.id,
        threads: [...picked],
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setAsking(false);
      setNote("");
      onChanged(started);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="review-comments" aria-labelledby={`review-comments-${task.id}`}>
      <div className="review-comments-head">
        <MessagesSquare size={14} aria-hidden />
        <strong id={`review-comments-${task.id}`}>{t("tasks.reviewComments.title")}</strong>
        <span className="grow" />
        <button type="button" className="ghost small" disabled={loading} onClick={load}>
          {loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
          {t("tasks.reviewComments.refresh")}
        </button>
      </div>
      {problem && <p className="muted">{t("tasks.reviewComments.cantRead", { error: problem })}</p>}
      {data && !open.length && <p className="muted">{t("tasks.reviewComments.none")}</p>}
      {open.length > 0 && (
        <ul className="review-thread-list">
          {open.map((th) => {
            const first = th.comments[0];
            const round = sent.get(th.id);
            return (
              <li key={th.id} className="review-thread">
                <div className="review-thread-head">
                  <label className="review-thread-pick">
                    <input type="checkbox" checked={picked.has(th.id)} onChange={() => toggle(th.id)} />
                    <code>{whereOf(th)}</code>
                  </label>
                  {th.outdated && <span className="badge tone-warn">{t("tasks.reviewComments.outdated")}</span>}
                  {round !== undefined && <span className="badge">{t("tasks.reviewComments.sent", { n: round })}</span>}
                  <span className="grow" />
                  {first && (
                    <button type="button" className="link" onClick={() => void openUrl(first.url)}>
                      <ExternalLink size={12} aria-hidden /> {t("tasks.reviewComments.onGithub")}
                    </button>
                  )}
                </div>
                {first && (
                  <p className="review-thread-body">
                    <strong>{first.author}</strong> {first.body}
                  </p>
                )}
                {th.comments.length > 1 && (
                  <span className="muted">{t("tasks.reviewComments.replies", { count: th.comments.length - 1 })}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data?.capped && <p className="muted">{t("tasks.reviewComments.capped")}</p>}
      {open.length > 0 && (
        <div className="review-comments-foot">
          <span className="muted">{t("tasks.reviewComments.readOnly")}</span>
          <span className="grow" />
          <button type="button" disabled={!picked.size} onClick={() => setAsking(true)}>
            <Wrench size={14} />
            {t("tasks.reviewComments.fix", { count: picked.size })}
          </button>
        </div>
      )}
      <Modal
        open={asking}
        onOpenChange={setAsking}
        title={t("tasks.reviewComments.dialogTitle")}
        description={t("tasks.reviewComments.dialogIntro", { count: picked.size })}
        actions={
          <>
            <button type="button" className="secondary" onClick={() => setAsking(false)}>
              {t("tasks.reviewComments.cancel")}
            </button>
            <button type="button" disabled={busy || !picked.size} onClick={() => void start()}>
              {busy ? <Loader2 size={14} className="spin" /> : <Wrench size={14} />}
              {t("tasks.reviewComments.start")}
            </button>
          </>
        }
      >
        <Field label={t("tasks.reviewComments.note")} help={t("tasks.reviewComments.noteHelp")}>
          <textarea rows={3} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ul className="task-fix-facts">
          <li>{t("tasks.reviewComments.asData")}</li>
          <li>{t("tasks.reviewComments.pushes", { number: task.pr?.number ?? 0 })}</li>
          <li>{t("tasks.reviewComments.nothingPosted")}</li>
        </ul>
      </Modal>
    </section>
  );
}
