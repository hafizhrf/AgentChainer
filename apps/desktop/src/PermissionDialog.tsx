import type { AlwaysScope, Methods, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
import { describeRequest, displayPath, type RiskLevel } from "@agentchainer/protocol";
import { useState } from "react";
import { Modal } from "./Dialog.tsx";
import { editDiffs, InlineDiff } from "./InlineDiff.tsx";
import { Markdown } from "./Markdown.tsx";
import { MODE_HELP, modeOptions } from "./options.ts";
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
  return request.toolName === "ExitPlanMode" ? (
    <PlanReview request={request} canAutonomous={canAutonomous} onAnswer={onAnswer} />
  ) : (
    <Approval request={request} cwd={cwd} onAnswer={onAnswer} {...(onStopTask ? { onStopTask } : {})} />
  );
}

const SCOPES: { value: AlwaysScope; label: string; hint: string }[] = [
  { value: "session", label: "Only this session", hint: "Forgotten when the session ends." },
  {
    value: "workspace",
    label: "This workspace, just me",
    hint: "Saved in .claude/settings.local.json, which stays out of git.",
  },
  {
    value: "team",
    label: "This workspace, shared with the team",
    hint: "Saved in .claude/settings.json, which is committed: your teammates get this rule too.",
  },
];
const asScope = (v: string): AlwaysScope => SCOPES.find((s) => s.value === v)?.value ?? "workspace";

const RISK_LABEL: Record<RiskLevel, string> = { low: "Low risk", medium: "Review first", high: "High risk" };

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
        throw new Error("The input must be a JSON object.");
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
      title={request.title ?? `Allow ${request.toolName}?`}
      description={
        <>
          {request.task
            ? `Requested by the task step ${request.task.label}${request.task.role ? ` (${request.task.role})` : ""}`
            : request.agentId
              ? `Requested by subagent ${request.agentId}`
              : "Requested by the main agent"}{" "}
          · {request.toolName}
        </>
      }
      actions={
        <>
          {onStopTask && (
            <button type="button" className="secondary approval-stop" onClick={onStopTask}>
              Stop task
            </button>
          )}
          <button
            type="button"
            className="secondary"
            // biome-ignore lint/a11y/noAutofocus: on risky asks a stray key must not approve.
            autoFocus={risky}
            onClick={() => onAnswer({ allow: false, ...(message.trim() ? { message } : {}) })}
          >
            Deny
          </button>
          {request.alwaysRules.length > 0 && (
            <button type="button" className="secondary" onClick={() => allow(true)}>
              Always allow
            </button>
          )}
          <button type="button" onClick={() => allow(false)}>
            Allow once
          </button>
        </>
      }
    >
      <div className={`approval-risk risk-${described.risk.level}`}>
        <span className={`badge risk-${described.risk.level}`}>{RISK_LABEL[described.risk.level]}</span>
        <span>{described.risk.reasons.join(" · ")}</span>
      </div>
      {described.kind === "command" && (
        <>
          {described.explanation && (
            <p>
              <span className="muted">Claude says:</span> {described.explanation}
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
          Tool <code>{described.tool}</code> from the <strong>{described.server}</strong> MCP server.
        </p>
      )}
      {extraDescription && <p>{extraDescription}</p>}
      {request.decisionReason && <p className="muted">Why it asks: {request.decisionReason}</p>}
      {request.blockedPath && (
        <p className="muted">
          Path: <code>{request.blockedPath}</code>
        </p>
      )}
      <details className="approval-details" open={described.kind === "other" || editing}>
        <summary>Details</summary>
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
            aria-label="Tool input (JSON)"
          />
        ) : (
          <pre className="tool-input">{input}</pre>
        )}
        <button type="button" className="link" onClick={() => setEditing((v) => !v)}>
          {editing ? "Stop editing" : "Edit input before allowing"}
        </button>
      </details>
      {error && <p className="warn">{error}</p>}
      <Field label="Message to Claude if you deny" help="Optional, e.g. “use pnpm instead”.">
        <input value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      {request.alwaysRules.length > 0 && (
        <Field
          label="“Always allow” saves"
          help={
            <>
              {SCOPES.find((s) => s.value === scope)?.hint}{" "}
              {request.alwaysRules.map((r) => (
                <code key={r} className="rule">
                  {r}
                </code>
              ))}
            </>
          }
        >
          <Select
            label="Where Always allow saves the rule"
            value={scope}
            options={SCOPES.map(({ value, label }) => ({ value, label }))}
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
      title="Review the plan"
      actions={
        <>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              onAnswer({ allow: false, message: "The user rejected this plan. Stop and wait for new instructions." })
            }
          >
            Reject
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!feedback.trim()}
            onClick={() =>
              onAnswer({
                allow: false,
                message: `Revise the plan before doing anything. The user asks: ${feedback.trim()}`,
              })
            }
          >
            Revise
          </button>
          <button type="button" onClick={() => onAnswer({ allow: true, mode })}>
            Approve &amp; run
          </button>
        </>
      }
    >
      {plan ? (
        <div className="plan-text">
          <Markdown text={plan} />
        </div>
      ) : (
        <p className="muted">The plan is in the transcript.</p>
      )}
      <Field label="Then run it as" help={MODE_HELP[mode]}>
        <Select
          label="Run the plan as"
          value={mode}
          options={modeOptions(EXECUTE_MODES, canAutonomous)}
          onChange={(m) => setMode(asMode(m))}
        />
      </Field>
      <Field label="Changes you want" help="For Revise: Claude updates the plan and asks again.">
        <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} />
      </Field>
    </Modal>
  );
}
