import type { BootstrapRun } from "@agentchainer/protocol";
import { CircleCheck, CircleX, History as HistoryIcon, Undo2 } from "lucide-react";
import { dateTime } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { EmptyState } from "../ui/Section.tsx";
import { Checks, OutcomeList } from "./PlanView.tsx";
import type { Bootstrap } from "./useBootstrap.tsx";

const STATUS_ICON: Record<BootstrapRun["actions"][number]["status"], typeof CircleCheck> = {
  applied: CircleCheck,
  failed: CircleX,
  "rolled-back": Undo2,
};

/** Past bootstrap runs (M2-16/M2-17), newest first, each one rolled back whole or per action. */
export function History({ bootstrap: b }: { bootstrap: Bootstrap }) {
  const conflict = b.outcome?.some((o) => o.status === "conflict") ?? false;
  return (
    <div className="setup-scroll">
      {b.outcome && <OutcomeList outcome={b.outcome} onDismiss={b.clearOutcome} />}
      {b.runs.length === 0 && <EmptyState icon={<HistoryIcon size={14} />}>{t("setup.history.empty")}</EmptyState>}
      <ol className="timeline">
        {b.runs.map((r) => {
          const live = r.actions.some((a) => a.status === "applied");
          return (
            <li key={r.runId} className="run">
              <header className="run-head">
                <strong>{dateTime(r.startedAt)}</strong>
                <span className="muted">{t("setup.history.catalog", { version: r.catalogVersion })}</span>
                <span className="grow" />
                {live && conflict && (
                  <button
                    type="button"
                    className="danger small"
                    disabled={b.busy}
                    onClick={() => void b.undo(r.runId, undefined, true)}
                  >
                    {t("setup.history.forceRollback")}
                  </button>
                )}
                {live && (
                  <button
                    type="button"
                    className="secondary small"
                    disabled={b.busy}
                    onClick={() => void b.undo(r.runId)}
                  >
                    <Undo2 size={13} />
                    {t("setup.history.rollBackRun")}
                  </button>
                )}
              </header>
              <ul className="run-actions">
                {r.actions.map((a) => {
                  const Icon = STATUS_ICON[a.status];
                  return (
                    <li key={a.id} className={`outcome ${a.status}`}>
                      <Icon size={14} className="run-icon" />
                      <div className="grow">
                        {a.title} <span className="muted">{a.status}</span>
                        {a.error && <div className="muted">{a.error}</div>}
                        {a.warnings.map((w) => (
                          <div key={w} className="warn">
                            {w}
                          </div>
                        ))}
                        {a.checks && <Checks checks={a.checks} />}
                      </div>
                      {a.status === "applied" && (
                        <button
                          type="button"
                          className="ghost small"
                          disabled={b.busy}
                          onClick={() => void b.undo(r.runId, a.id)}
                        >
                          {t("setup.history.rollBack")}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
