import { MAX_CI_FIXES, type Methods, type PrCheck, type Task } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleCheck, CircleMinus, CircleX, ExternalLink, Loader2, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";

type Status = Methods["task.prStatus"]["result"];

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Polls every 30 s, slowing to 2 min while nothing changes; stops once every check has finished (design §6). */
const FIRST_MS = 30_000;
const MAX_MS = 120_000;

/** A GitHub Actions job's check: only those have a log the app can read. */
const isActions = (c: PrCheck) => /\/actions\/runs\/\d+\/job\/\d+/.test(c.link);

function BucketIcon({ bucket }: { bucket: string }) {
  if (bucket === "pass") return <CircleCheck size={14} className="ok" aria-label="Passed" />;
  if (bucket === "fail") return <CircleX size={14} className="err" aria-label="Failed" />;
  if (bucket === "pending") return <Loader2 size={14} className="spin" aria-label="Running" />;
  return <CircleMinus size={14} className="muted" aria-label={bucket === "skipping" ? "Skipped" : "Cancelled"} />;
}

/**
 * The task's PR on GitHub and its CI checks (M5-03), read through the user's `gh` while this page is open. A failing
 * GitHub Actions check offers Fix CI: its log first, then a round only when the user says so.
 */
export function PrChecks({ task, cwd, onChanged }: { task: Task; cwd: string; onChanged: (task: Task) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState<PrCheck | null>(null);
  const delay = useRef(FIRST_MS);
  const last = useRef("");

  const load = useCallback(async () => {
    try {
      const s = await request("task.prStatus", { cwd, id: task.id });
      const key = JSON.stringify(s);
      delay.current = key === last.current ? Math.min(delay.current * 2, MAX_MS) : FIRST_MS;
      last.current = key;
      setStatus(s);
      setError(null);
      return s;
    } catch (err) {
      setError(message(err));
      return null;
    }
  }, [cwd, task.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the task changes (a fix was pushed).
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const s = await load();
      const pending = !s || s.checks.some((c) => c.bucket === "pending") || s.checks.length === 0;
      if (live && pending && s?.state === "OPEN") timer = setTimeout(() => void tick(), delay.current);
    };
    delay.current = FIRST_MS;
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [load, task.updatedAt]);

  const rounds = task.pr?.fixes?.length ?? 0;
  const busy = task.state === "running";
  return (
    <div className="pr-checks">
      <div className="pr-checks-head">
        <strong>Checks</strong>
        {status && (
          <span className="muted">
            {status.state === "OPEN" ? (status.draft ? "Draft" : "Open") : status.state.toLowerCase()}
            {rounds ? ` · Fix CI ${rounds} of ${MAX_CI_FIXES}` : ""}
          </span>
        )}
        <span className="grow" />
        <IconButton label="Check again" onClick={() => void load()}>
          <RefreshCw size={13} />
        </IconButton>
      </div>
      {error && <p className="warn">{error}</p>}
      {status && status.checks.length === 0 && <p className="muted">No checks reported yet.</p>}
      <ul>
        {status?.checks.map((c) => (
          <li key={c.link || c.name}>
            <BucketIcon bucket={c.bucket} />
            <span className="pr-check-name" title={c.workflow}>
              {c.workflow && c.workflow !== c.name ? `${c.workflow} / ${c.name}` : c.name}
            </span>
            {c.bucket === "fail" && isActions(c) && (
              <button
                type="button"
                className="secondary small"
                disabled={busy || rounds >= MAX_CI_FIXES}
                title={rounds >= MAX_CI_FIXES ? `This PR had its ${MAX_CI_FIXES} Fix CI rounds.` : undefined}
                onClick={() => setFixing(c)}
              >
                <Wrench size={13} />
                Fix CI…
              </button>
            )}
            {c.link && (
              <IconButton label="Open the check on GitHub" onClick={() => void openUrl(c.link)}>
                <ExternalLink size={13} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {fixing && (
        <FixCiDialog
          check={fixing}
          task={task}
          cwd={cwd}
          rounds={rounds}
          onClose={() => setFixing(null)}
          onStarted={onChanged}
        />
      )}
    </div>
  );
}

/** Shows the failing log, then starts a round only when the user asks (owner decision 3). */
function FixCiDialog({
  check,
  task,
  cwd,
  rounds,
  onClose,
  onStarted,
}: {
  check: PrCheck;
  task: Task;
  cwd: string;
  rounds: number;
  onClose: () => void;
  onStarted: (task: Task) => void;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    request("task.ciLog", { cwd, id: task.id, link: check.link }).then(
      (r) => setLog(r.log),
      (err) => setError(message(err)),
    );
  }, [cwd, task.id, check.link]);

  async function fix() {
    setBusy(true);
    try {
      onStarted(await request("task.fixCi", { cwd, id: task.id, link: check.link }));
      onClose();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={`Fix CI: ${check.name}`}
      description={`Round ${rounds + 1} of ${MAX_CI_FIXES}. It counts against the task's budget.`}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Not now
          </button>
          <button type="button" disabled={log === null || busy} onClick={() => void fix()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Wrench size={14} />}
            Fix this
          </button>
        </>
      }
    >
      <p className="muted">
        Claude gets this log as data, with the contract and the task's diff, and fixes the code in the task's worktree
        with the same approvals as the run. The gates run again, and only when they pass is the branch pushed (never
        forced).
      </p>
      {error && <p className="warn">{error}</p>}
      {log === null && !error && <p className="muted">Reading the log…</p>}
      {log !== null && <pre className="ci-log">{log || "(The failed steps wrote nothing.)"}</pre>}
    </Modal>
  );
}
