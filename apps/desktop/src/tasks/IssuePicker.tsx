import type { IssueSummary, Task } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, CircleDot, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../Dialog.tsx";
import { dateTime } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";

/**
 * A task from one of the workspace's GitHub issues (CP-08): the open issues through the person's own `gh`, searched
 * with gh's own search; picking one prefills the request ("Fix #N: title"), which the person confirms or changes.
 * The sidecar reads the issue itself when the task is made, and only drafting reads its text, as data.
 */
export function IssuePicker({
  open,
  cwd,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: Task) => void;
}) {
  const [search, setSearch] = useState("");
  const [data, setData] = useState<{ issues: IssueSummary[]; capped: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<IssueSummary | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // The list, read when the dialog opens and as the search changes (after a pause in typing).
  useEffect(() => {
    if (!open || !cwd) return;
    let live = true;
    const timer = setTimeout(
      () => {
        setLoading(true);
        request("github.issues", { cwd, ...(search.trim() ? { search: search.trim() } : {}) }).then(
          (r) => {
            if (!live) return;
            setData(r);
            setProblem(null);
            setLoading(false);
          },
          (err: unknown) => {
            if (!live) return;
            setProblem(String(err));
            setLoading(false);
          },
        );
      },
      search ? 350 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, cwd, search]);

  function pick(issue: IssueSummary) {
    setPicked(issue);
    setText(t("tasks.issues.requestFrom", { number: issue.number, title: issue.title }));
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setPicked(null);
      setSearch("");
      setProblem(null);
    }
  }

  async function create() {
    if (!picked || !text.trim()) return;
    setBusy(true);
    try {
      const task = await request("task.createFromIssue", { cwd, number: picked.number, request: text.trim() });
      close(false);
      onCreated(task);
    } catch (err) {
      setProblem(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      size="lg"
      title={t("tasks.issues.title")}
      description={t("tasks.issues.intro")}
      actions={
        <>
          <button type="button" className="secondary" onClick={() => close(false)}>
            {t("tasks.issues.cancel")}
          </button>
          <button type="button" disabled={busy || !picked || !text.trim()} onClick={() => void create()}>
            {busy && <Loader2 size={14} className="spin" />}
            {t("tasks.issues.create")}
          </button>
        </>
      }
    >
      {problem && <p className="warn">{problem}</p>}
      {!picked ? (
        <>
          <Field label={t("tasks.issues.search")}>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("tasks.issues.searchPlaceholder")}
              spellCheck={false}
            />
          </Field>
          {loading && !data && (
            <p className="muted">
              <Loader2 size={14} className="spin" /> {t("tasks.issues.loading")}
            </p>
          )}
          {data && !data.issues.length && <p className="muted">{t("tasks.issues.none")}</p>}
          {data && data.issues.length > 0 && (
            <ul className="issue-list" aria-label={t("tasks.issues.listLabel")} aria-busy={loading}>
              {data.issues.map((issue) => (
                <li key={issue.number}>
                  <button type="button" className="issue-row" onClick={() => pick(issue)}>
                    <CircleDot size={14} className="issue-open" aria-hidden />
                    <span className="issue-number">{t("tasks.issues.number", { number: issue.number })}</span>
                    <span className="issue-title">{issue.title}</span>
                    <span className="issue-meta muted">
                      {issue.labels.slice(0, 3).map((l) => (
                        <span key={l} className="chip">
                          {l}
                        </span>
                      ))}
                      {t("tasks.issues.by", { author: issue.author, date: dateTime(issue.updatedAt) })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data?.capped && <p className="muted">{t("tasks.issues.capped")}</p>}
        </>
      ) : (
        <div className="issue-picked">
          <div className="issue-picked-head">
            <button type="button" className="ghost small" onClick={() => setPicked(null)}>
              <ArrowLeft size={14} />
              {t("tasks.issues.another")}
            </button>
            <span className="grow" />
            <button type="button" className="link" onClick={() => void openUrl(picked.url)}>
              <ExternalLink size={12} aria-hidden /> {t("tasks.issues.onGithub")}
            </button>
          </div>
          <p className="issue-picked-title">
            <strong>{t("tasks.issues.number", { number: picked.number })}</strong> {picked.title}
          </p>
          <Field label={t("tasks.issues.request")} help={t("tasks.issues.requestHelp")}>
            <textarea rows={3} value={text} maxLength={20_000} onChange={(e) => setText(e.target.value)} />
          </Field>
          <ul className="task-fix-facts">
            <li>{t("tasks.issues.asContext")}</li>
            <li>{t("tasks.issues.closes", { number: picked.number })}</li>
          </ul>
        </div>
      )}
    </Modal>
  );
}
