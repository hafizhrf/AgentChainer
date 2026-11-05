import type { Lesson, Task } from "@agentchainer/protocol";
import { GraduationCap, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { lineDiff } from "../textdiff.ts";

const SOURCE_TEXT: Record<Lesson["sources"][number]["source"], string> = {
  get gate() {
    return t("tasks.lessons.sourceGate");
  },
  get format() {
    return t("tasks.lessons.sourceFormat");
  },
  get review() {
    return t("tasks.lessons.sourceReview");
  },
  get guard() {
    return t("tasks.lessons.sourceGuard");
  },
  get approval() {
    return t("tasks.lessons.sourceApproval");
  },
  get notes() {
    return t("tasks.lessons.sourceNotes");
  },
};

/**
 * Lessons from a finished task (M8-06, docs/design/lessons.md): on request, one small model call words what the run's
 * records point at as CLAUDE.md lines. The person picks the ones to keep, reads the change to CLAUDE.md, and adds them
 * as a History run; the rest are dismissed and never offered again.
 */
export function LessonsCard({ task, cwd }: { task: Task; cwd: string }) {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; before: string; after: string } | null>(null);
  const [busy, setBusy] = useState<"suggest" | "apply" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  // The last suggestions, if any, without a model call.
  useEffect(() => {
    let live = true;
    request("task.lessons", { cwd, id: task.id, stored: true }).then(
      (r) => {
        if (!live || !r.lessons.length) return;
        setLessons(r.lessons);
        setPicked(new Set(r.lessons.map((l) => l.id)));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [cwd, task.id]);

  // The change to CLAUDE.md, again whenever the pick changes.
  const ids = [...picked].sort().join(",");
  useEffect(() => {
    if (!ids) {
      setDiff(null);
      return;
    }
    let live = true;
    request("task.lessonsPreview", { cwd, id: task.id, ids: ids.split(",") }).then(
      (r) => live && setDiff(r),
      (err: unknown) => live && setError(String(err)),
    );
    return () => {
      live = false;
    };
  }, [cwd, task.id, ids]);

  async function suggest() {
    setBusy("suggest");
    setError(null);
    setAdded(null);
    try {
      const r = await request("task.lessons", { cwd, id: task.id });
      setLessons(r.lessons);
      setPicked(new Set(r.lessons.map((l) => l.id)));
      setNote(r.note ?? null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    setBusy("apply");
    setError(null);
    try {
      const r = await request("task.lessonsApply", { cwd, id: task.id, ids: [...picked] });
      setAdded(r.path);
      setLessons([]);
      setPicked(new Set());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function dismissAll() {
    if (!lessons?.length) return;
    setBusy("dismiss");
    try {
      const r = await request("task.lessonsDismiss", { cwd, id: task.id, ids: lessons.map((l) => l.id) });
      setLessons(r.lessons);
      setPicked(new Set());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="card task-lessons">
      <div className="card-title">
        <GraduationCap size={16} aria-hidden />
        <h2>{t("tasks.lessons.title")}</h2>
        <span className="muted">{t("tasks.lessons.subtitle")}</span>
      </div>
      {added && (
        <p className="ok-text">
          <Rich k="tasks.lessons.added" params={{ path: added }} tags={{ code: (s) => <code>{s}</code> }} />
        </p>
      )}
      {error && <p className="warn">{error}</p>}
      {lessons === null || (!lessons.length && !note && !added) ? (
        <div className="card-footer">
          <span className="muted">{t("tasks.lessons.explain")}</span>
          <span className="grow" />
          <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void suggest()}>
            {busy === "suggest" && <Loader2 size={13} className="spin" aria-hidden />}
            {t("tasks.lessons.suggest")}
          </button>
        </div>
      ) : !lessons.length ? (
        note && <p className="muted">{note}</p>
      ) : (
        <>
          <ul className="lesson-list">
            {lessons.map((l) => (
              <li key={l.id}>
                <label className="check">
                  <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                  <span className="lesson-text">{l.text}</span>
                </label>
                <p className="muted lesson-why">{l.why}</p>
                {l.sources.length > 0 && (
                  <div className="lesson-sources">
                    {l.sources.map((s) => (
                      <span key={s.ref} className="chip" title={s.text}>
                        {SOURCE_TEXT[s.source]}: {s.ref.split(":").slice(1).join(":")}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {diff && (
            <div className="preview-file">
              <code className="preview-path">
                {diff.path}
                {diff.before ? "" : ` ${t("tasks.lessons.new")}`}
              </code>
              <pre className="plan-preview inline-diff">
                {lineDiff(diff.before, diff.after)
                  .filter((l) => l.op !== " ")
                  .map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff.
                    <span key={i} className={l.op === "+" ? "add" : "del"}>
                      {l.op} {l.text}
                      {"\n"}
                    </span>
                  ))}
              </pre>
            </div>
          )}
          <div className="card-footer">
            <span className="muted">{t("tasks.lessons.applyNote")}</span>
            <span className="grow" />
            <button type="button" className="ghost small" disabled={busy !== null} onClick={() => void dismissAll()}>
              {t("tasks.lessons.dismissAll")}
            </button>
            <button
              type="button"
              className="small"
              disabled={busy !== null || picked.size === 0}
              onClick={() => void apply()}
            >
              {busy === "apply" && <Loader2 size={13} className="spin" aria-hidden />}
              {t("tasks.lessons.add", { n: picked.size })}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
