import type { GitHubStatus, Methods, Task } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitPullRequest, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../Dialog.tsx";
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
      ? "The GitHub CLI (gh) isn't installed. Install it, then sign in from a terminal with `gh auth login`."
      : github.state === "signed-out"
        ? `gh isn't signed in to ${github.host}. Run \`gh auth login --hostname ${github.host}\` in a terminal.`
        : "This repository has no origin remote on GitHub, so there is nowhere to open a PR.";
  return (
    <div className="pr-not-ready">
      <Markdown text={text} />
      <p className="muted">AgentChainer never signs in for you or reads gh's credentials.</p>
      <div className="row">
        <button type="button" className="secondary small" onClick={() => void openUrl(GUIDE)}>
          Setup guide
        </button>
        <button type="button" className="secondary small" onClick={onRecheck}>
          <RefreshCw size={13} />
          Check again
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
      setTitle((t) => t || p.title);
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
      title="Create a pull request"
      description={
        preview
          ? `${preview.head} → ${preview.base}${preview.github.repo ? ` on ${preview.github.repo}` : ""}`
          : "Reading the task…"
      }
      actions={
        <>
          <button type="button" className="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" disabled={!ready || !title.trim() || busy} onClick={() => void create()}>
            {busy ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />}
            Push and create PR
          </button>
        </>
      }
    >
      {error && <p className="warn">{error}</p>}
      {!preview && !error && <p className="muted">Loading…</p>}
      {preview && !ready && <NotReady github={preview.github} onRecheck={() => void load()} />}
      {preview && ready && (
        <div className="pr-form">
          <p className="muted">
            What the run left is committed on <code>{preview.head}</code>, its changed files are scanned for secrets,
            and the branch is pushed (never forced). Nothing is merged.
          </p>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            <span>Open it as a draft</span>
          </label>
          <span className="field-label">Body (from the contract and the evidence)</span>
          <div className="pr-body">
            <Markdown text={preview.body} />
          </div>
        </div>
      )}
    </Modal>
  );
}
