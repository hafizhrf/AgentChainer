import { describeRequest, type PermissionRequest, type RiskLevel } from "@agentchainer/protocol";
import { ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { t } from "../i18n/index.ts";
import { type PermissionAnswer, PermissionDialog } from "../PermissionDialog.tsx";

const RISK_LABEL: Record<RiskLevel, string> = {
  get low() {
    return t("tasks.approval.riskLow");
  },
  get medium() {
    return t("tasks.approval.riskMedium");
  },
  get high() {
    return t("tasks.approval.riskHigh");
  },
};

/**
 * A task step's approval as a card in its thread (UX-13), where the step is: what it wants to do, in plain words, with
 * its risk; Allow once, Deny, or Stop the task. Details opens the full approval (edit the input, always allow).
 */
export function ApprovalCard({
  request,
  cwd,
  onAnswer,
  onStopTask,
}: {
  request: PermissionRequest;
  cwd: string;
  onAnswer: (answer: PermissionAnswer) => void;
  onStopTask: () => void;
}) {
  const [details, setDetails] = useState(false);
  const d = describeRequest(request.toolName, request.input, cwd, request.defaultToNo === true);
  const risky = d.risk.level === "high";
  const what =
    d.kind === "command"
      ? d.command
      : d.kind === "edit"
        ? d.path
        : d.kind === "read" || d.kind === "web"
          ? d.target
          : request.toolName;
  return (
    <section className={`card thread-card approval-card risk-${d.risk.level}`} aria-label={t("tasks.approval.label")}>
      <div className="card-title">
        <ShieldQuestion size={16} aria-hidden />
        <h2>{request.title ?? t("tasks.approval.allowTool", { tool: request.toolName })}</h2>
        <span className="muted">
          {request.task?.label ?? t("tasks.approval.taskStep")}
          {request.task?.role ? ` · ${request.task.role}` : ""}
        </span>
        <span className="grow" />
        <span className={`badge risk-${d.risk.level}`}>{RISK_LABEL[d.risk.level]}</span>
      </div>
      {d.kind === "command" && d.explanation && (
        <p className="approval-why">
          <span className="muted">{t("tasks.approval.claudeSays")}</span> {d.explanation}
        </p>
      )}
      <pre className="approval-command">{what}</pre>
      {d.risk.reasons.length > 0 && <p className="muted approval-reasons">{d.risk.reasons.join(" · ")}</p>}
      <div className="card-footer">
        <button type="button" className="secondary" onClick={onStopTask}>
          {t("tasks.approval.stopTask")}
        </button>
        <span className="grow" />
        <button type="button" className="ghost" onClick={() => setDetails(true)}>
          {t("tasks.approval.details")}
        </button>
        <button type="button" className="secondary" onClick={() => onAnswer({ allow: false })}>
          {t("tasks.approval.deny")}
        </button>
        <button
          type="button"
          // A risky ask needs a deliberate click: no default focus on Allow.
          className={risky ? "secondary" : undefined}
          onClick={() => onAnswer({ allow: true })}
        >
          {t("tasks.approval.allowOnce")}
        </button>
      </div>
      {details && (
        <PermissionDialog
          request={request}
          cwd={cwd}
          canAutonomous={false}
          onAnswer={(a) => {
            setDetails(false);
            onAnswer(a);
          }}
          onStopTask={() => {
            setDetails(false);
            onStopTask();
          }}
        />
      )}
    </section>
  );
}
