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
import { dateTime } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";

type Gates = Methods["task.mergeGates"]["result"];
type Method = Gates["methods"][number];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const HOLDS = new Set<MergeGate["state"]>(["fail", "pending", "missing"]);
const METHOD_LABEL: Record<Method, string> = {
  get merge() {
    return t("tasks.mergeGates.methodMerge");
  },
  get squash() {
    return t("tasks.mergeGates.methodSquash");
  },
  get rebase() {
    return t("tasks.mergeGates.methodRebase");
  },
};

function GateIcon({ state }: { state: MergeGate["state"] }) {
  if (state === "pass") return <CircleCheck size={14} className="ok" aria-label={t("tasks.mergeGates.passed")} />;
  if (state === "fail") return <CircleX size={14} className="err" aria-label={t("tasks.mergeGates.failed")} />;
  if (state === "pending") return <Loader2 size={14} className="spin" aria-label={t("tasks.mergeGates.running")} />;
  if (state === "missing") {
    return <CircleDashed size={14} className="warn-text" aria-label={t("tasks.mergeGates.missing")} />;
  }
  return <CircleMinus size={14} className="muted" aria-label={t("tasks.mergeGates.notRun")} />;
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
        <GitMerge size={14} aria-hidden />{" "}
        <Rich
          k={pr.merged.accepted ? "tasks.mergeGates.mergedAccepted" : "tasks.mergeGates.merged"}
          params={{
            method: pr.merged.method,
            sha: pr.merged.sha.slice(0, 7),
            date: dateTime(pr.merged.at),
            reason: pr.merged.accepted ?? "",
          }}
          tags={{ code: (s) => <code>{s}</code> }}
        />
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
        <strong>{t("tasks.mergeGates.title")}</strong>
        <span className="grow" />
        <button
          type="button"
          className="secondary small"
          disabled={busy !== null || running}
          onClick={() => void check()}
        >
          {busy === "check" ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
          {gates ? t("tasks.mergeGates.checkAgain") : t("tasks.mergeGates.check")}
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      {!gates && <p className="muted">{t("tasks.mergeGates.explain")}</p>}
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
              {t("tasks.mergeGates.review")}
            </button>
          )}
          <span className="grow" />
          <button type="button" className="small" disabled={busy !== null || running} onClick={() => setMerging(true)}>
            <GitMerge size={13} />
            {t("tasks.mergeGates.openMerge")}
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
      title={t("tasks.mergeGates.dialogTitle", { number: String(pr?.number), base: String(pr?.base) })}
      description={t("tasks.mergeGates.dialogDescription", { sha: gates.headSha.slice(0, 7) })}
      role="alertdialog"
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            {t("tasks.mergeGates.cancel")}
          </button>
          <button
            type="button"
            className={held.length ? "danger" : undefined}
            disabled={busy || (held.length > 0 && !reason.trim()) || !gates.methods.length}
            onClick={() => void merge()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <GitMerge size={14} />}
            {held.length ? t("tasks.mergeGates.mergeAnyway") : t("tasks.mergeGates.merge")}
          </button>
        </>
      }
    >
      {error && <p className="warn">{error}</p>}
      <Field label={t("tasks.mergeGates.method")}>
        <Select
          label={t("tasks.mergeGates.methodLabel")}
          value={method}
          options={gates.methods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
          onChange={(v) => setMethod(v as Method)}
        />
      </Field>
      {gates.draft && <p className="muted">{t("tasks.mergeGates.draft")}</p>}
      {held.length > 0 && (
        <>
          <p className="callout">
            {t("tasks.mergeGates.notGreen", { gates: held.map((g) => `${g.label} (${g.detail})`).join("; ") })}
          </p>
          <Field label={t("tasks.mergeGates.why")} help={t("tasks.mergeGates.whyHelp")}>
            <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      )}
    </Modal>
  );
}
