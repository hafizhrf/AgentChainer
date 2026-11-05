import type { DeployPlan, DeployRecord, DeployTarget } from "@agentchainer/protocol";
import { redactSecrets } from "@agentchainer/protocol";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleCheck, CircleX, ExternalLink, Loader2, RefreshCw, Rocket, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../Dialog.tsx";
import { dateTime } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { EmptyState } from "../ui/Section.tsx";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A hint with its `commands` shown as code. */
const withCode = (text: string) =>
  text.split("`").map((part, i) => (i % 2 ? <code key={`code:${part}`}>{part}</code> : part));

const code = (s: string) => <code>{s}</code>;
const strong = (s: string) => <strong>{s}</strong>;

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
      const [found, d] = await Promise.all([request("deploy.targets", { cwd }), request("deploy.list", { cwd })]);
      setTargets(found.targets);
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
    Boolean(d.previous?.deploymentId) || Boolean(targets?.find((x) => x.adapter === d.adapter)?.rollbackWithoutRecord);

  // The live production deploy of each provider: the newest one that worked.
  const live = new Set(
    (targets ?? []).flatMap((target) => {
      const r = deploys.find((d) => d.adapter === target.adapter && d.env === "production" && d.status === "done");
      return r ? [r.id] : [];
    }),
  );

  return (
    <div className="setup-scroll">
      <p className="muted">{t("setup.deploys.intro")}</p>
      <section className="card deploy-card">
        <div className="card-title">
          <Rocket size={16} aria-hidden />
          <h2>{t("setup.deploys.providers")}</h2>
          <span className="grow" />
          <IconButton label={t("setup.deploys.checkAgain")} onClick={() => void load()}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
        {error && <p className="warn">{error}</p>}
        {!targets && !error && <p className="muted">{t("setup.deploys.checking")}</p>}
        {targets?.length === 0 && (
          <p className="muted">
            <Rich k="setup.deploys.noConfig" tags={{ code }} />
          </p>
        )}
        <ul className="deploy-targets">
          {targets?.map((target) => (
            <li key={target.adapter} className="deploy-target">
              <div className="deploy-target-row">
                <strong>{target.label}</strong>
                <code className="muted">{target.config}</code>
                {target.project && <span>{target.project}</span>}
                <span className="grow muted">
                  {target.state === "ready"
                    ? target.adapter === "docker"
                      ? t("setup.deploys.dockerRunning")
                      : t("setup.deploys.signedIn")
                    : withCode(target.hint ?? "")}
                </span>
                <button
                  type="button"
                  className="secondary small"
                  disabled={target.state !== "ready" || planning !== null}
                  onClick={() => void open(target.adapter)}
                >
                  {planning === target.adapter ? <Loader2 size={13} className="spin" /> : <Rocket size={13} />}
                  {t("setup.deploys.deployToProductionEllipsis")}
                </button>
              </div>
              {target.adapter === "docker" && (
                <DockerImage cwd={cwd} image={target.project ?? ""} onSaved={() => void load()} />
              )}
            </li>
          ))}
        </ul>
      </section>

      {deploys.length === 0 ? (
        <EmptyState icon={<Rocket size={14} />}>{t("setup.deploys.noDeploys")}</EmptyState>
      ) : (
        <section className="card deploy-card">
          <div className="card-title">
            <h2>{t("setup.deploys.history")}</h2>
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
  const what = d.rollbackOf ? t("setup.deploys.rollbackChip") : d.env;
  return (
    <li>
      {d.status === "done" && d.smoke?.ok !== false ? (
        <CircleCheck size={14} className="ok" aria-label={t("setup.deploys.deployed")} />
      ) : (
        <CircleX size={14} className="err" aria-label={t("setup.deploys.failed")} />
      )}
      <span className="deploy-what">
        <span className={`chip${d.env === "production" ? " on" : ""}`}>{what}</span> {d.adapter}
        {d.commit && (
          <>
            {" "}
            · <code>{d.commit.slice(0, 7)}</code>
          </>
        )}
        {d.branch && <> · {d.branch}</>} · {dateTime(d.startedAt)}
        {live && <strong> · {t("setup.deploys.live")}</strong>}
        {d.rolledBackBy && <span className="muted"> · {t("setup.deploys.rolledBack")}</span>}
      </span>
      <span className="grow muted deploy-detail" title={redactSecrets(d.error ?? d.smoke?.detail ?? "")}>
        {d.status === "failed"
          ? redactSecrets(d.error ?? "")
          : d.smoke
            ? d.smoke.ok
              ? t("setup.deploys.smokePassed", { detail: redactSecrets(d.smoke.detail) })
              : t("setup.deploys.smokeFailed", { detail: redactSecrets(d.smoke.detail) })
            : d.adapter === "docker" && d.deploymentId
              ? t("setup.deploys.pushed", { id: d.deploymentId })
              : ""}
      </span>
      {d.url && (
        <IconButton label={t("setup.deploys.openDeployment")} onClick={() => void openUrl(d.url ?? "")}>
          <ExternalLink size={13} />
        </IconButton>
      )}
      {live && canRollBack && (
        <button type="button" className="ghost small" disabled={busy} onClick={onRollback}>
          {planning ? <Loader2 size={13} className="spin" /> : <Undo2 size={13} />}
          {t("setup.deploys.rollBackEllipsis")}
        </button>
      )}
    </li>
  );
}

/**
 * The image a Docker deploy pushes to (`.agentchainer/docker.json`). The registry login stays with `docker login`;
 * this is only the name.
 */
function DockerImage({ cwd, image, onSaved }: { cwd: string; image: string; onSaved: () => void }) {
  const [value, setValue] = useState(image);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setValue(image), [image]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await request("deploy.setDockerImage", { cwd, image: value.trim() || null });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="deploy-image"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label={t("setup.deploys.image")} help={<Rich k="setup.deploys.imageHelp" tags={{ code }} />}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("setup.deploys.imagePlaceholder")}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <button type="submit" className="secondary small" disabled={busy || value.trim() === image}>
        {busy && <Loader2 size={13} className="spin" />}
        {t("setup.deploys.save")}
      </button>
      {error && <p className="warn">{error}</p>}
    </form>
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
        setError(r.error ?? t("setup.deploys.cliFailed"));
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
      title={
        rollback
          ? t("setup.deploys.rollbackTitle", { project: plan.project, provider: plan.label })
          : t("setup.deploys.deployTitle", { project: plan.project })
      }
      description={
        plan.adapter === "docker"
          ? rollback
            ? t("setup.deploys.dockerRollbackDescription")
            : t("setup.deploys.dockerDeployDescription")
          : rollback
            ? t("setup.deploys.rollbackDescription")
            : t("setup.deploys.deployDescription")
      }
      role="alertdialog"
      actions={
        <>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t("setup.deploys.cancel")}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy || Boolean(blocked) || typed.trim() !== plan.project}
            onClick={() => void go()}
          >
            {busy ? <Loader2 size={14} className="spin" /> : rollback ? <Undo2 size={14} /> : <Rocket size={14} />}
            {busy
              ? t("setup.deploys.working")
              : rollback
                ? t("setup.deploys.rollBackProduction")
                : t("setup.deploys.deployToProduction")}
          </button>
        </>
      }
    >
      {error && <p className="warn">{error}</p>}
      {blocked && <p className="callout">{blocked}</p>}
      <dl className="deploy-plan">
        <dt>{t("setup.deploys.provider")}</dt>
        <dd>
          <Rich
            k="setup.deploys.providerProject"
            params={{ provider: plan.label, project: plan.project }}
            tags={{ strong }}
          />
        </dd>
        {rollback ? (
          <>
            <dt>{t("setup.deploys.nowLive")}</dt>
            <dd>
              {rollback.deploymentId ?? rollback.url ?? "—"}
              {rollback.commit && <code> {rollback.commit.slice(0, 7)}</code>}
            </dd>
            <dt>{t("setup.deploys.backTo")}</dt>
            <dd>
              {to?.deploymentId || to?.url ? (
                <>
                  {to.deploymentId ?? to.url}
                  {to.commit && <code> {to.commit.slice(0, 7)}</code>}
                </>
              ) : (
                t("setup.deploys.previousUnrecorded")
              )}
            </dd>
          </>
        ) : (
          <>
            <dt>{t("setup.deploys.from")}</dt>
            <dd>
              <Rich
                k="setup.deploys.branchAt"
                params={{ branch: plan.branch, commit: plan.commit.slice(0, 7) }}
                tags={{ code }}
              />
            </dd>
            <dt>{t("setup.deploys.command")}</dt>
            <dd>
              <code>{plan.command}</code>
            </dd>
            {plan.current && (
              <>
                <dt>{t("setup.deploys.liveNow")}</dt>
                <dd>{plan.current.url ?? plan.current.deploymentId}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {!blocked && (
        <Field label={<Rich k="setup.deploys.typeToConfirm" params={{ project: plan.project }} tags={{ strong }} />}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      )}
    </Modal>
  );
}
