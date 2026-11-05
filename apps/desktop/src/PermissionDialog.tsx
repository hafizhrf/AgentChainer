import type { AlwaysScope, Methods, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
import { describeRequest, displayPath, type RiskLevel } from "@agentchainer/protocol";
import { useState } from "react";
import { Modal } from "./Dialog.tsx";
import { editDiffs, InlineDiff } from "./InlineDiff.tsx";
import { t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
import { Markdown } from "./Markdown.tsx";
import { MODE_HELP, modeOptions } from "./options.ts";
import { QuestionCard } from "./QuestionCard.tsx";
import { asMode } from "./tabs.ts";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";

export type PermissionAnswer = Omit<Methods["permission.respond"]["params"], "sessionId" | "requestId">;

/** Modes an approved plan can run in; plan mode itself is not one of them. */
const EXECUTE_MODES: PermissionMode[] = ["default", "acceptEdits", "auto"];

/**
 * A pending tool approval (M1-17, UX-05): what it does in plain words (the command and Claude's own explanation, or
 * the file and its diff), a risk level from fixed rules (`approval.ts`), and the raw input, which the user can edit.
 * Allow once, always allow (the CLI's suggested rule, saved for the session, for this user, or for the team), or deny
 * with a message to the agent. ExitPlanMode gets the plan review instead (M1-16).
 */
export function PermissionDialog({
  request,
  cwd,
  canAutonomous,
  onAnswer,
  onStopTask,
}: {
  request: PermissionRequest;
  /** The session's workspace: paths inside it read as relative and count as safer. */
  cwd: string;
  /** The Autonomous profile needs a budget cap on the session. */
  canAutonomous: boolean;
  onAnswer: (answer: PermissionAnswer) => void;
  /** A task step's approval: the dialog covers the page's Stop, so it offers its own. */
  onStopTask?: () => void;
}) {
  // A task step's questions have no thread yet: they show in the dialog (UX-12).
  if (request.toolName === "AskUserQuestion") {
    return (
      <Modal
        open
        onOpenChange={() => undefined}
        dismissible={false}
        size="lg"
        title={t("session.permission.claudeAsks")}
      >
        <QuestionCard request={request} onAnswer={onAnswer} />
      </Modal>
    );
  }
  return request.toolName === "ExitPlanMode" ? (
    <PlanReview request={request} canAutonomous={canAutonomous} onAnswer={onAnswer} />
  ) : (
    <Approval request={request} cwd={cwd} onAnswer={onAnswer} {...(onStopTask ? { onStopTask } : {})} />
  );
}

const SCOPES: AlwaysScope[] = ["session", "workspace", "team"];
const asScope = (v: string): AlwaysScope => SCOPES.find((s) => s === v) ?? "workspace";

/** Where an "Always allow" rule is saved, in words. */
function scopeLabel(scope: AlwaysScope): string {
  switch (scope) {
    case "session":
      return t("session.permission.scopeSession");
    case "workspace":
      return t("session.permission.scopeWorkspace");
    case "team":
      return t("session.permission.scopeTeam");
  }
}

/** What saving there means. */
function scopeHint(scope: AlwaysScope): string {
  switch (scope) {
    case "session":
      return t("session.permission.scopeSessionHint");
    case "workspace":
      return t("session.permission.scopeWorkspaceHint");
    case "team":
      return t("session.permission.scopeTeamHint");
  }
}

function riskLabel(level: RiskLevel): string {
  switch (level) {
    case "low":
      return t("session.permission.riskLow");
    case "medium":
      return t("session.permission.riskMedium");
    case "high":
      return t("session.permission.riskHigh");
  }
}

/** Who asks for an approval: a task step, a subagent or the main agent. */
function requester(request: PermissionRequest): string {
  if (request.task) {
    const { label: step, role } = request.task;
    return role ? t("session.permission.byTaskStepRole", { step, role }) : t("session.permission.byTaskStep", { step });
  }
  if (request.agentId) return t("session.permission.bySubagent", { agent: request.agentId });
  return t("session.permission.byMain");
}

function Approval({
  request,
  cwd,
  onAnswer,
  onStopTask,
}: {
  request: PermissionRequest;
  cwd: string;
  onAnswer: (a: PermissionAnswer) => void;
  onStopTask?: () => void;
}) {
  const original = JSON.stringify(request.input, null, 2);
  const [input, setInput] = useState(original);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState<AlwaysScope>("workspace");
  const [error, setError] = useState<string | null>(null);
  const described = describeRequest(request.toolName, request.input, cwd, request.defaultToNo === true);
  const diffs = editDiffs(request.toolName, request.input);
  const risky = described.risk.level === "high";
  // The CLI's own description often repeats what's shown above (the command's explanation, the file): skip it then.
  const shown = [
    described.kind === "command" ? described.explanation : null,
    described.kind === "edit" ? described.path : null,
    described.kind === "read" || described.kind === "web" ? described.target : null,
  ];
  const extraDescription =
    request.description && !shown.includes(displayPath(request.description, cwd)) ? request.description : null;

  function allow(always: boolean) {
    const saved = always ? { always, scope } : {};
    if (input === original) return onAnswer({ allow: true, ...saved });
    try {
      const parsed: unknown = JSON.parse(input);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(t("session.permission.inputNotObject"));
      onAnswer({ allow: true, updatedInput: parsed as Record<string, unknown>, ...saved });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      open
      onOpenChange={() => undefined}
      dismissible={false}
      size={diffs ? "lg" : "md"}
      title={request.title ?? t("session.permission.allowTitle", { tool: request.toolName })}
      description={`${requester(request)} · ${request.toolName}`}
      actions={
        <>
          {onStopTask && (
            <button type="button" className="secondary approval-stop" onClick={onStopTask}>
              {t("session.permission.stopTask")}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            // biome-ignore lint/a11y/noAutofocus: on risky asks a stray key must not approve.
            autoFocus={risky}
            onClick={() => onAnswer({ allow: false, ...(message.trim() ? { message } : {}) })}
          >
            {t("session.permission.deny")}
          </button>
          {request.alwaysRules.length > 0 && (
            <button type="button" className="secondary" onClick={() => allow(true)}>
              {t("session.permission.alwaysAllow")}
            </button>
          )}
          <button type="button" onClick={() => allow(false)}>
            {t("session.permission.allowOnce")}
          </button>
        </>
      }
    >
      <div className={`approval-risk risk-${described.risk.level}`}>
        <span className={`badge risk-${described.risk.level}`}>{riskLabel(described.risk.level)}</span>
        <span>{described.risk.reasons.join(" · ")}</span>
      </div>
      {described.kind === "command" && (
        <>
          {described.explanation && (
            <p>
              <span className="muted">{t("session.permission.claudeSays")}</span> {described.explanation}
            </p>
          )}
          <pre className="approval-command">{described.command}</pre>
        </>
      )}
      {described.kind === "edit" && (
        <>
          <p>
            <code>{described.path}</code>
          </p>
          {diffs && <InlineDiff diffs={diffs} />}
        </>
      )}
      {(described.kind === "read" || described.kind === "web") && described.target && (
        <p>
          <code>{described.target}</code>
        </p>
      )}
      {described.kind === "mcp" && (
        <p>
          <Rich
            k="session.permission.mcpTool"
            params={{ tool: described.tool, server: described.server }}
            tags={{ code: (s) => <code>{s}</code>, strong: (s) => <strong>{s}</strong> }}
          />
        </p>
      )}
      {extraDescription && <p>{extraDescription}</p>}
      {request.decisionReason && (
        <p className="muted">{t("session.permission.whyItAsks", { reason: request.decisionReason })}</p>
      )}
      {request.blockedPath && (
        <p className="muted">
          <Rich
            k="session.permission.path"
            params={{ path: request.blockedPath }}
            tags={{ code: (s) => <code>{s}</code> }}
          />
        </p>
      )}
      <details className="approval-details" open={described.kind === "other" || editing}>
        <summary>{t("session.permission.details")}</summary>
        {editing ? (
          <textarea
            className="input-editor"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            rows={Math.min(16, input.split("\n").length + 1)}
            spellCheck={false}
            aria-label={t("session.permission.inputLabel")}
          />
        ) : (
          <pre className="tool-input">{input}</pre>
        )}
        <button type="button" className="link" onClick={() => setEditing((v) => !v)}>
          {editing ? t("session.permission.stopEditing") : t("session.permission.editInput")}
        </button>
      </details>
      {error && <p className="warn">{error}</p>}
      <Field label={t("session.permission.denyMessage")} help={t("session.permission.denyMessageHelp")}>
        <input value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      {request.alwaysRules.length > 0 && (
        <Field
          label={t("session.permission.alwaysSaves")}
          help={
            <>
              {scopeHint(scope)}{" "}
              {request.alwaysRules.map((r) => (
                <code key={r} className="rule">
                  {r}
                </code>
              ))}
            </>
          }
        >
          <Select
            label={t("session.permission.scopeLabel")}
            value={scope}
            options={SCOPES.map((value) => ({ value, label: scopeLabel(value) }))}
            onChange={(v) => setScope(asScope(v))}
          />
        </Field>
      )}
    </Modal>
  );
}

function PlanReview({
  request,
  canAutonomous,
  onAnswer,
}: {
  request: PermissionRequest;
  canAutonomous: boolean;
  onAnswer: (a: PermissionAnswer) => void;
}) {
  const plan = typeof request.input.plan === "string" ? request.input.plan : null;
  const [mode, setMode] = useState<PermissionMode>("default");
  const [feedback, setFeedback] = useState("");

  return (
    <Modal
      open
      onOpenChange={() => undefined}
      dismissible={false}
      size="lg"
      title={t("session.plan.title")}
      actions={
        <>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              // Sent to Claude: stays English (X-13).
              onAnswer({ allow: false, message: "The user rejected this plan. Stop and wait for new instructions." })
            }
          >
            {t("session.plan.reject")}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!feedback.trim()}
            onClick={() =>
              onAnswer({
                allow: false,
                // Sent to Claude: stays English (X-13).
                message: `Revise the plan before doing anything. The user asks: ${feedback.trim()}`,
              })
            }
          >
            {t("session.plan.revise")}
          </button>
          <button type="button" onClick={() => onAnswer({ allow: true, mode })}>
            {t("session.plan.approve")}
          </button>
        </>
      }
    >
      {plan ? (
        <div className="plan-text">
          <Markdown text={plan} />
        </div>
      ) : (
        <p className="muted">{t("session.plan.inTranscript")}</p>
      )}
      <Field label={t("session.plan.runAs")} help={MODE_HELP[mode]}>
        <Select
          label={t("session.plan.runAsLabel")}
          value={mode}
          options={modeOptions(EXECUTE_MODES, canAutonomous)}
          onChange={(m) => setMode(asMode(m))}
        />
      </Field>
      <Field label={t("session.plan.changes")} help={t("session.plan.changesHelp")}>
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} />
      </Field>
    </Modal>
  );
}
