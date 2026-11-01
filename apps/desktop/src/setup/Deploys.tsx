import type { DeployPlan, DeployRecord, DeployTarget } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleCheck, CircleX, ExternalLink, Loader2, RefreshCw, Rocket, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A hint with its `commands` shown as code. */
const withCode = (text: string) =>
  text.split("`").map((part, i) => (i % 2 ? <code key={`code:${part}`}>{part}</code> : part));

/** What the dialog is for: a production deploy, or rolling the live one back. */
type Pending = { kind: "deploy"; plan: DeployPlan } | { kind: "rollback"; plan: DeployPlan; record: DeployRecord };

/**
 * The workspace's Deploy page (M6-02, M6-03; docs/design/deploy-and-canvas.md §5–7): production deploys of the
 * current branch, behind a dialog where the person types the project's name, every deploy with its smoke test, and
 * Roll back on the live production deploy. Previews are made from a task's page.
 */
export function Deploys({ cwd }: { cwd: string }) {
  const [targets, setTargets] = useState<DeployTarget[] | null>(null);
  const [deploys, setDeploys] = useState<DeployRecord[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [planning, setPlanning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, d] = await Promise.all([request("deploy.targets", { cwd }), request("deploy.list", { cwd })]);
      setTargets(t.targets);
      setDeploys(d.deploys);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(adapter: DeployTarget["adapter"], record?: DeployRecord) {
    setPlanning(record?.id ?? adapter);
    setError(null);
    try {
      const plan = await request("deploy.plan", { cwd, adapter });
      setPending(record ? { kind: "rollback", plan, record } : { kind: "deploy", plan });
    } catch (err) {
      setError(message(err));
    } finally {
      setPlanning(null);
    }
  }

  // Fly.io and Firebase roll back only to a deploy the app recorded; the others know their own previous one.
  const canRollBack = (d: DeployRecord) =>
    Boolean(d.previous?.deploymentId) || Boolean(targets?.find((t) => t.adapter === d.adapter)?.rollbackWithoutRecord);

  // The live production deploy of each provider: the newest one that worked.
  const live = new Set(
    (targets ?? []).flatMap((t) => {
      const r = deploys.find((d) => d.adapter === t.adapter && d.env === "production" && d.status === "done");
      return r ? [r.id] : [];
    }),
  );

  return (
    <div className="setup-scroll">
      <p className="muted">
        Production deploys of the workspace's current branch, with the provider's own CLI. Previews are made from a
        task's page.
      </p>
      <section className="card deploy-card">
        <div className="card-title">
          <Rocket size={16} aria-hidden />
          <h2>Providers</h2>
          <span className="grow" />
          <IconButton label="Check again" onClick={() => void load()}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
        {error && <p className="warn">{error}</p>}
        {!targets && !error && <p className="muted">Checking the providers…</p>}
        {targets?.length === 0 && (
          <p className="muted">
            No deploy config found. Vercel needs <code>.vercel/project.json</code> (<code>vercel link</code>);
            Cloudflare Workers need <code>wrangler.toml</code>, <code>wrangler.json</code> or{" "}
            <code>wrangler.jsonc</code>; Firebase Hosting needs <code>firebase.json</code> with a default project;
            Fly.io needs <code>fly.toml</code>.
          </p>
        )}
        <ul className="deploy-targets">
          {targets?.map((t) => (
            <li key={t.adapter}>
              <strong>{t.label}</strong>
              <code className="muted">{t.config}</code>
              <span className="grow muted">{t.state === "ready" ? "Signed in." : withCode(t.hint ?? "")}</span>
              <button
                type="button"
                className="secondary small"
                disabled={t.state !== "ready" || planning !== null}
                onClick={() => void open(t.adapter)}
              >
                {planning === t.adapter ? <Loader2 size={13} className="spin" /> : <Rocket size={13} />}
                Deploy to production…
              </button>
            </li>
          ))}
        </ul>
      </section>

      {deploys.length === 0 ? (
        <EmptyState icon={<Rocket size={14} />}>
          No deploys yet. Each one is recorded here with its smoke test.
        </EmptyState>
      ) : (
        <section className="card deploy-card">
          <div className="card-title">
            <h2>History</h2>
          </div>
          <ul className="deploy-list">
            {deploys.map((d) => (
              <DeployRow
                key={d.id}
                d={d}
                live={live.has(d.id)}
                canRollBack={canRollBack(d)}
                busy={planning !== null}
                planning={planning === d.id}
                onRollback={() => void open(d.adapter, d)}
              />
            ))}
          </ul>
        </section>
      )}

      {pending && (
        <ConfirmDeploy
          cwd={cwd}
          pending={pending}
          onClose={() => setPending(null)}
          onDone={() => {
            setPending(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function DeployRow({
  d,
  live,
  canRollBack,
  busy,
  planning,
  onRollback,
}: {
  d: DeployRecord;
  live: boolean;
  canRollBack: boolean;
  busy: boolean;
  planning: boolean;
  onRollback: () => void;
}) {
  const what = d.rollbackOf ? "rollback" : d.env;
  return (
    <li>
      {d.status === "done" && d.smoke?.ok !== false ? (
        <CircleCheck size={14} className="ok" aria-label="Deployed" />
      ) : (
        <CircleX size={14} className="err" aria-label="Failed" />
      )}
      <span className="deploy-what">
        <span className={`chip${d.env === "production" ? " on" : ""}`}>{what}</span> {d.adapter}
        {d.commit && (
          <>
            {" "}
            · <code>{d.commit.slice(0, 7)}</code>
          </>
        )}
        {d.branch && <> · {d.branch}</>} · {new Date(d.startedAt).toLocaleString()}
        {live && <strong> · live</strong>}
        {d.rolledBackBy && <span className="muted"> · rolled back</span>}
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
      {live && canRollBack && (
        <button type="button" className="ghost small" disabled={busy} onClick={onRollback}>
          {planning ? <Loader2 size={13} className="spin" /> : <Undo2 size={13} />}
          Roll back…
        </button>
      )}
    </li>
  );
}

/**
 * The production dialog (design §5): what will run, where and from which commit, and a field where the person types
 * the project's name before the button turns on. Never automatic; the sidecar checks the name and the commit again.
 */
function ConfirmDeploy({
  cwd,
  pending,
  onClose,
  onDone,
}: {
  cwd: string;
  pending: Pending;
  onClose: () => void;
  onDone: () => void;
}) {
  const { plan } = pending;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rollback = pending.kind === "rollback" ? pending.record : null;
  const blocked = rollback ? undefined : plan.problem;

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = rollback
        ? await request("deploy.rollback", { cwd, id: rollback.id, confirm: typed })
        : await request("deploy.production", { cwd, adapter: plan.adapter, confirm: typed, commit: plan.commit });
      if (r.status === "failed") {
        setError(r.error ?? "The provider's CLI failed.");
        setBusy(false);
        return;
      }
      onDone();
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  const to = rollback?.previous;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={rollback ? `Roll back ${plan.project} on ${plan.label}?` : `Deploy ${plan.project} to production?`}
      description={
        rollback
          ? "Production goes back to the deploy before this one, with the provider's own rollback. The smoke test runs again."
          : "This deploys the workspace as it is now to the provider's production. The smoke test runs on the result."
      }
      role="alertdialog"
      actions={
        <>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy || Boolean(blocked) || typed.trim() !== plan.project}
            onClick={() => void go()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : rollback ? <Undo2 size={14} /> : <Rocket size={14} />}
            {busy ? "Working…" : rollback ? "Roll back production" : "Deploy to production"}
          </button>
        </>
      }
    >
      {error && <p className="warn">{error}</p>}
      {blocked && <p className="callout">{blocked}</p>}
      <dl className="deploy-plan">
        <dt>Provider</dt>
        <dd>
          {plan.label} · project <strong>{plan.project}</strong>
        </dd>
        {rollback ? (
          <>
            <dt>Now live</dt>
            <dd>
              {rollback.deploymentId ?? rollback.url ?? "—"}
              {rollback.commit && <code> {rollback.commit.slice(0, 7)}</code>}
            </dd>
            <dt>Back to</dt>
            <dd>
              {to?.deploymentId || to?.url ? (
                <>
                  {to.deploymentId ?? to.url}
                  {to.commit && <code> {to.commit.slice(0, 7)}</code>}
                </>
              ) : (
                "The provider's previous production deploy (the app has no record of it)."
              )}
            </dd>
          </>
        ) : (
          <>
            <dt>From</dt>
            <dd>
              {plan.branch} at <code>{plan.commit.slice(0, 7)}</code>
            </dd>
            <dt>Command</dt>
            <dd>
              <code>{plan.command}</code>
            </dd>
            {plan.current && (
              <>
                <dt>Live now</dt>
                <dd>{plan.current.url ?? plan.current.deploymentId}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {!blocked && (
        <Field
          label={
            <>
              Type <strong>{plan.project}</strong> to confirm
            </>
          }
        >
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      )}
    </Modal>
  );
}
