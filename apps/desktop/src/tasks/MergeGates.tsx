import type { MergeGate, Methods, Task } from "@agentchainer/protocol";
import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  GitMerge,
  Loader2,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { Modal } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";

type Gates = Methods["task.mergeGates"]["result"];
type Method = Gates["methods"][number];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const HOLDS = new Set<MergeGate["state"]>(["fail", "pending", "missing"]);
const METHOD_LABEL: Record<Method, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

function GateIcon({ state }: { state: MergeGate["state"] }) {
  if (state === "pass") return <CircleCheck size={14} className="ok" aria-label="Passed" />;
  if (state === "fail") return <CircleX size={14} className="err" aria-label="Failed" />;
  if (state === "pending") return <Loader2 size={14} className="spin" aria-label="Running" />;
  if (state === "missing") return <CircleDashed size={14} className="warn-text" aria-label="Missing" />;
  return <CircleMinus size={14} className="muted" aria-label="Not run" />;
}

/**
 * The merge gates of the task's PR (M5-04) and the person's Merge (M5-05). The gates are worked out when asked: the
 * run, the review of the current head, gitleaks, semgrep and trivy when installed, and CI. Merge asks for a
 * confirmation, and for a reason while a gate holds it back. The app never merges on its own.
 */
export function MergeGates({ task, cwd, onChanged }: { task: Task; cwd: string; onChanged: (task: Task) => void }) {
  const [gates, setGates] = useState<Gates | null>(null);
  const [busy, setBusy] = useState<"check" | "review" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const pr = task.pr;
  if (!pr) return null;

  if (pr.merged) {
    return (
      <p className="pr-merged">
        <GitMerge size={14} aria-hidden /> Merged by you ({pr.merged.method}) at{" "}
        <code>{pr.merged.sha.slice(0, 7)}</code>, {new Date(pr.merged.at).toLocaleString()}.
        {pr.merged.accepted ? ` Gates not green, accepted: ${pr.merged.accepted}` : ""} Pull it into your branch to get
        it locally.
      </p>
    );
  }

  async function check() {
    setBusy("check");
    setError(null);
    try {
      setGates(await request("task.mergeGates", { cwd, id: task.id }));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function review() {
    setBusy("review");
    setError(null);
    try {
      onChanged(await request("task.reviewPr", { cwd, id: task.id }));
      setGates(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const running = task.state === "running";
  const reviewGate = gates?.gates.find((g) => g.id === "review");
  return (
    <div className="merge-gates">
      <div className="pr-checks-head">
        <strong>Merge gates</strong>
        <span className="grow" />
        <button
          type="button"
          className="secondary small"
          disabled={busy !== null || running}
          onClick={() => void check()}
        >
          {busy === "check" ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
          {gates ? "Check again" : "Check the gates"}
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      {!gates && <p className="muted">Runs the scanners on the task's worktree and reads the PR's checks.</p>}
      {gates && (
        <ul>
          {gates.gates.map((g) => (
            <li key={g.id}>
              <GateIcon state={g.state} />
              <span className="merge-gate-label">{g.label}</span>
              <span className="muted merge-gate-detail" title={g.detail}>
                {g.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
      {gates && (
        <div className="row">
          {reviewGate && reviewGate.state !== "pass" && (
            <button
              type="button"
              className="secondary small"
              disabled={busy !== null || running}
              onClick={() => void review()}
            >
              {busy === "review" ? <Loader2 size={13} className="spin" /> : <ScanSearch size={13} />}
              Review the PR
            </button>
          )}
          <span className="grow" />
          <button type="button" className="small" disabled={busy !== null || running} onClick={() => setMerging(true)}>
            <GitMerge size={13} />
            Merge…
          </button>
        </div>
      )}
      {merging && gates && (
        <MergeDialog
          gates={gates}
          task={task}
          cwd={cwd}
          onClose={() => setMerging(false)}
          onMerged={(t) => {
            setMerging(false);
            onChanged(t);
          }}
        />
      )}
    </div>
  );
}

function MergeDialog({
  gates,
  task,
  cwd,
  onClose,
  onMerged,
}: {
  gates: Gates;
  task: Task;
  cwd: string;
  onClose: () => void;
  onMerged: (task: Task) => void;
}) {
  const [method, setMethod] = useState<Method>(gates.defaultMethod);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const held = gates.gates.filter((g) => HOLDS.has(g.state));
  const pr = task.pr;

  async function merge() {
    setBusy(true);
    setError(null);
    try {
      onMerged(
        await request("task.mergePr", {
          cwd,
          id: task.id,
          method,
          headSha: gates.headSha,
          ...(held.length ? { acceptReason: reason.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Merge #${pr?.number} into ${pr?.base}?`}
      description={`On GitHub, at ${gates.headSha.slice(0, 7)}: a newer push makes this merge fail instead of slipping in.`}
      role="alertdialog"
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={held.length ? "danger" : undefined}
            disabled={busy || (held.length > 0 && !reason.trim()) || !gates.methods.length}
            onClick={() => void merge()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <GitMerge size={14} />}
            {held.length ? "Merge anyway" : "Merge"}
          </button>
        </>
      }
    >
      {error && <p className="warn">{error}</p>}
      <Field label="Method">
        <Select
          label="Merge method"
          value={method}
          options={gates.methods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
          onChange={(v) => setMethod(v as Method)}
        />
      </Field>
      {gates.draft && <p className="muted">It's a draft: it is marked ready for review first.</p>}
      {held.length > 0 && (
        <>
          <p className="callout">Not green: {held.map((g) => `${g.label} (${g.detail})`).join("; ")}</p>
          <Field label="Why merge anyway?" help="Kept with the task and in its evidence report.">
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      )}
    </Modal>
  );
}
