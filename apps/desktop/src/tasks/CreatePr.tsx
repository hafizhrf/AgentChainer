import type { GitHubStatus, Methods, Task } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../Dialog.tsx";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { Markdown } from "../Markdown.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";

type Preview = Methods["task.prPreview"]["result"];

const GUIDE = "https://github.com/hafizhrf/AgentChainer/blob/main/docs/guides/GITHUB_SETUP.md";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What stands between the workspace and a PR when `gh` isn't ready, and how to fix it (ADR-0002: the user signs in). */
function NotReady({ github, onRecheck }: { github: GitHubStatus; onRecheck: () => void }) {
  const text =
    github.state === "missing"
      ? t("tasks.createPr.ghMissing")
      : github.state === "signed-out"
        ? t("tasks.createPr.ghSignedOut", { host: String(github.host) })
        : t("tasks.createPr.noRemote");
  return (
    <div className="pr-not-ready">
      <Markdown text={text} />
      <p className="muted">{t("tasks.createPr.neverSignsIn")}</p>
      <div className="row">
        <button type="button" className="secondary small" onClick={() => void openUrl(GUIDE)}>
          {t("tasks.createPr.setupGuide")}
        </button>
        <button type="button" className="secondary small" onClick={onRecheck}>
          <RefreshCw size={13} />
          {t("tasks.createPr.checkAgain")}
        </button>
      </div>
    </div>
  );
}

/**
 * Create PR (M5-02): shows what will be sent, the title (editable), the base and head, and the body built from the
 * contract and the evidence, then pushes the task's branch and opens the PR through the user's `gh`.
 */
export function CreatePrDialog({
  open,
  task,
  cwd,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  task: Task;
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (task: Task) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const p = await request("task.prPreview", { cwd, id: task.id });
      setPreview(p);
      setTitle((current) => current || p.title);
    } catch (err) {
      setError(message(err));
    }
  }, [cwd, task.id]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await request("task.createPr", { cwd, id: task.id, title: title.trim(), draft }));
      onOpenChange(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const ready = preview?.github.state === "ready";
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("tasks.createPr.title")}
      description={
        preview
          ? preview.github.repo
            ? t("tasks.createPr.branchesOnRepo", {
                head: preview.head,
                base: preview.base,
                repo: preview.github.repo,
              })
            : t("tasks.createPr.branches", { head: preview.head, base: preview.base })
          : t("tasks.createPr.reading")
      }
      actions={
        <>
          <button type="button" className="secondary" onClick={() => onOpenChange(false)}>
            {t("tasks.createPr.cancel")}
          </button>
          <button type="button" disabled={!ready || !title.trim() || busy} onClick={() => void create()}>
            {busy ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />}
            {t("tasks.createPr.push")}
          </button>
        </>
      }
    >
      {error && <p className="warn">{error}</p>}
      {!preview && !error && <p className="muted">{t("tasks.createPr.loading")}</p>}
      {preview && !ready && <NotReady github={preview.github} onRecheck={() => void load()} />}
      {preview && ready && (
        <div className="pr-form">
          <p className="muted">
            <Rich k="tasks.createPr.explain" params={{ head: preview.head }} tags={{ code: (s) => <code>{s}</code> }} />
          </p>
          <Field label={t("tasks.createPr.titleField")}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            <span>{t("tasks.createPr.asDraft")}</span>
          </label>
          <span className="field-label">{t("tasks.createPr.body")}</span>
          <div className="pr-body">
            <Markdown text={preview.body} />
          </div>
        </div>
      )}
    </Modal>
  );
}
