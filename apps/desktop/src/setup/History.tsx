import type { BootstrapRun } from "@agentchainer/protocol";
import { CircleCheck, CircleX, History as HistoryIcon, Undo2 } from "lucide-react";
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
      {b.runs.length === 0 && (
        <EmptyState icon={<HistoryIcon size={14} />}>
          Nothing applied yet. Each apply is recorded here and can be rolled back.
        </EmptyState>
      )}
      <ol className="timeline">
        {b.runs.map((r) => {
          const live = r.actions.some((a) => a.status === "applied");
          return (
            <li key={r.runId} className="run">
              <header className="run-head">
                <strong>{new Date(r.startedAt).toLocaleString()}</strong>
                <span className="muted">catalog {r.catalogVersion}</span>
                <span className="grow" />
                {live && conflict && (
                  <button
                    type="button"
                    className="danger small"
                    disabled={b.busy}
                    onClick={() => void b.undo(r.runId, undefined, true)}
                  >
                    Force rollback
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
                    Roll back run
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
                          Roll back
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
