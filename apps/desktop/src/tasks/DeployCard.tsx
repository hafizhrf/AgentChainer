import type { DeployRecord, DeployTarget, Task } from "@agentchainer/protocol";
import { redactSecrets } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleCheck, CircleX, ExternalLink, Loader2, RefreshCw, Rocket } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { dateTime } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
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
        <h2>{t("tasks.deploy.title")}</h2>
        <span className="muted">{t("tasks.deploy.subtitle")}</span>
        <span className="grow" />
        <IconButton label={t("tasks.deploy.checkAgain")} onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {error && <p className="warn">{error}</p>}
      {!targets && !error && <p className="muted">{t("tasks.deploy.checking")}</p>}
      <ul className="deploy-targets">
        {targets?.map((target) => (
          <li key={target.adapter}>
            <strong>{target.label}</strong>
            <code className="muted">{target.config}</code>
            <span className="grow muted">
              {target.state === "ready" ? t("tasks.deploy.signedIn") : withCode(target.hint ?? "")}
            </span>
            <button
              type="button"
              className="secondary small"
              disabled={target.state !== "ready" || busy !== null}
              onClick={() => void preview(target.adapter)}
            >
              {busy === target.adapter ? <Loader2 size={13} className="spin" /> : <Rocket size={13} />}
              {busy === target.adapter ? t("tasks.deploy.deploying") : t("tasks.deploy.preview")}
            </button>
          </li>
        ))}
      </ul>
      {deploys.length > 0 && (
        <ul className="deploy-list">
          {deploys.map((d) => (
            <li key={d.id}>
              {d.status === "done" && d.smoke?.ok !== false ? (
                <CircleCheck size={14} className="ok" aria-label={t("tasks.deploy.deployed")} />
              ) : (
                <CircleX size={14} className="err" aria-label={t("tasks.deploy.failed")} />
              )}
              <span className="deploy-what">
                {d.env} · {d.adapter} · <code>{d.commit.slice(0, 7)}</code> · {dateTime(d.startedAt)}
              </span>
              <span className="grow muted deploy-detail" title={redactSecrets(d.error ?? d.smoke?.detail ?? "")}>
                {d.status === "failed"
                  ? redactSecrets(d.error ?? "")
                  : d.smoke
                    ? t(d.smoke.ok ? "tasks.deploy.smokePassed" : "tasks.deploy.smokeFailed", {
                        detail: redactSecrets(d.smoke.detail),
                      })
                    : ""}
              </span>
              {d.url && (
                <IconButton label={t("tasks.deploy.open")} onClick={() => void openUrl(d.url ?? "")}>
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
