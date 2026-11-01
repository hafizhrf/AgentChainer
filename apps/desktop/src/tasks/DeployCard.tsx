import type { DeployRecord, DeployTarget, Task } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleCheck, CircleX, ExternalLink, Loader2, RefreshCw, Rocket } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A hint with its `commands` shown as code. */
const withCode = (text: string) =>
  text.split("`").map((part, i) => (i % 2 ? <code key={`code:${part}`}>{part}</code> : part));

/**
 * Preview deploys of a task (M6-01, M6-03; docs/design/deploy-and-canvas.md §2): the providers the workspace uses,
 * whether their CLIs are ready, a Deploy preview per provider, and the task's deploys with their smoke tests. Always a
 * person's click; production is never deployed from here.
 */
export function DeployCard({ task, cwd, onChanged }: { task: Task; cwd: string; onChanged: () => void }) {
  const [targets, setTargets] = useState<DeployTarget[] | null>(null);
  const [deploys, setDeploys] = useState<DeployRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, d] = await Promise.all([
        request("deploy.targets", { cwd }),
        request("deploy.list", { cwd, taskId: task.id }),
      ]);
      // Fly.io has no previews.
      setTargets(t.targets.filter((x) => x.environments.includes("preview")));
      setDeploys(d.deploys);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [cwd, task.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function preview(adapter: DeployTarget["adapter"]) {
    setBusy(adapter);
    setError(null);
    try {
      await request("deploy.preview", { cwd, id: task.id, adapter });
      await load();
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  if (targets && !targets.length && !deploys.length) return null;
  return (
    <section className="card deploy-card">
      <div className="card-title">
        <Rocket size={16} aria-hidden />
        <h2>Deploy</h2>
        <span className="muted">Previews of this task's branch, with the provider's own CLI.</span>
        <span className="grow" />
        <IconButton label="Check again" onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {error && <p className="warn">{error}</p>}
      {!targets && !error && <p className="muted">Checking the providers…</p>}
      <ul className="deploy-targets">
        {targets?.map((t) => (
          <li key={t.adapter}>
            <strong>{t.label}</strong>
            <code className="muted">{t.config}</code>
            <span className="grow muted">{t.state === "ready" ? "Signed in." : withCode(t.hint ?? "")}</span>
            <button
              type="button"
              className="secondary small"
              disabled={t.state !== "ready" || busy !== null}
              onClick={() => void preview(t.adapter)}
            >
              {busy === t.adapter ? <Loader2 size={13} className="spin" /> : <Rocket size={13} />}
              {busy === t.adapter ? "Deploying…" : "Deploy preview"}
            </button>
          </li>
        ))}
      </ul>
      {deploys.length > 0 && (
        <ul className="deploy-list">
          {deploys.map((d) => (
            <li key={d.id}>
              {d.status === "done" && d.smoke?.ok !== false ? (
                <CircleCheck size={14} className="ok" aria-label="Deployed" />
              ) : (
                <CircleX size={14} className="err" aria-label="Failed" />
              )}
              <span className="deploy-what">
                {d.env} · {d.adapter} · <code>{d.commit.slice(0, 7)}</code> · {new Date(d.startedAt).toLocaleString()}
              </span>
              <span className="grow muted deploy-detail" title={d.error ?? d.smoke?.detail}>
                {d.status === "failed"
                  ? d.error
                  : d.smoke
                    ? `Smoke test ${d.smoke.ok ? "passed" : "failed"}: ${d.smoke.detail}`
                    : ""}
              </span>
              {d.url && (
                <IconButton label="Open the deployment" onClick={() => void openUrl(d.url ?? "")}>
                  <ExternalLink size={13} />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
