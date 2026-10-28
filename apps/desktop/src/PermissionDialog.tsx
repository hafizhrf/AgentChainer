import type { Methods, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
import { useState } from "react";
import { MODE_LABELS } from "./SettingsPanel.tsx";

export type PermissionAnswer = Omit<Methods["permission.respond"]["params"], "sessionId" | "requestId">;

/** Modes an approved plan can run in; plan mode itself is not one of them. */
const EXECUTE_MODES: PermissionMode[] = ["default", "acceptEdits", "auto"];

/**
 * A pending tool approval (M1-17): the tool, who asks (main agent or subagent) and its input, which the user can
 * edit. Allow once, always allow (saves the CLI's suggested rule to `.claude/settings.local.json`), or deny with a
 * message to the agent. ExitPlanMode gets the plan review instead (M1-16).
 */
export function PermissionDialog({
  request,
  canAutonomous,
  onAnswer,
}: {
  request: PermissionRequest;
  /** The Autonomous profile needs a budget cap on the session. */
  canAutonomous: boolean;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  return request.toolName === "ExitPlanMode" ? (
    <PlanReview request={request} canAutonomous={canAutonomous} onAnswer={onAnswer} />
  ) : (
    <Approval request={request} onAnswer={onAnswer} />
  );
}

function Approval({ request, onAnswer }: { request: PermissionRequest; onAnswer: (a: PermissionAnswer) => void }) {
  const original = JSON.stringify(request.input, null, 2);
  const [input, setInput] = useState(original);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  function allow(always: boolean) {
    if (input === original) return onAnswer({ allow: true, ...(always ? { always } : {}) });
    try {
      const parsed: unknown = JSON.parse(input);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("The input must be a JSON object.");
      onAnswer({ allow: true, updatedInput: parsed as Record<string, unknown>, ...(always ? { always } : {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="perm-title">
        <h2 id="perm-title">{request.title ?? `Allow ${request.toolName}?`}</h2>
        {request.description && <p>{request.description}</p>}
        {request.decisionReason && <p className="muted">Why it asks: {request.decisionReason}</p>}
        {request.blockedPath && (
          <p className="muted">
            Path: <code>{request.blockedPath}</code>
          </p>
        )}
        <p className="muted">
          {request.agentId ? `Requested by subagent ${request.agentId}` : "Requested by the main agent"} ·{" "}
          {request.toolName}
        </p>
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
          <pre>{input}</pre>
        )}
        <button type="button" className="link" onClick={() => setEditing((v) => !v)}>
          {editing ? "Stop editing" : "Edit input before allowing"}
        </button>
        {error && <p className="warn">{error}</p>}
        <label>
          Message to Claude if you deny <span className="muted">(optional)</span>
          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. use pnpm instead" />
        </label>
        {request.alwaysRules.length > 0 && (
          <p className="muted">
            "Always allow" saves to <code>.claude/settings.local.json</code>:{" "}
            {request.alwaysRules.map((r) => (
              <code key={r} className="rule">
                {r}
              </code>
            ))}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary"
            // biome-ignore lint/a11y/noAutofocus: the CLI marks some asks "default to no" so a stray key can't approve.
            autoFocus={request.defaultToNo === true}
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
        </div>
      </div>
    </div>
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
    <div className="overlay">
      <div className="dialog plan" role="dialog" aria-modal="true" aria-labelledby="plan-title">
        <h2 id="plan-title">Review the plan</h2>
        {plan ? <pre className="plan-text">{plan}</pre> : <p className="muted">The plan is in the transcript above.</p>}
        <label>
          Then run it as
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            {EXECUTE_MODES.map((m) => (
              <option key={m} value={m} disabled={m === "auto" && !canAutonomous}>
                {MODE_LABELS[m]}
                {m === "auto" && !canAutonomous ? " (set a budget cap first)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Changes you want <span className="muted">(for Revise)</span>
          <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={3} />
        </label>
        <div className="dialog-actions">
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
            Approve &amp; execute
          </button>
        </div>
      </div>
    </div>
  );
}
