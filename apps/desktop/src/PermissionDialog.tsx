import type { Methods, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
import { useState } from "react";
import { Modal } from "./Dialog.tsx";
import { Markdown } from "./Markdown.tsx";
import { MODE_HELP, modeOptions } from "./options.ts";
import { asMode } from "./tabs.ts";
import { Field } from "./ui/Field.tsx";
import { Select } from "./ui/Select.tsx";

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
    <Modal
      open
      onOpenChange={() => undefined}
      dismissible={false}
      title={request.title ?? `Allow ${request.toolName}?`}
      description={
        <>
          {request.agentId ? `Requested by subagent ${request.agentId}` : "Requested by the main agent"} ·{" "}
          {request.toolName}
        </>
      }
      actions={
        <>
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
        </>
      }
    >
      {request.description && <p>{request.description}</p>}
      {request.decisionReason && <p className="muted">Why it asks: {request.decisionReason}</p>}
      {request.blockedPath && (
        <p className="muted">
          Path: <code>{request.blockedPath}</code>
        </p>
      )}
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
      <div>
        <button type="button" className="link" onClick={() => setEditing((v) => !v)}>
          {editing ? "Stop editing" : "Edit input before allowing"}
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      <Field label="Message to Claude if you deny" help="Optional, e.g. “use pnpm instead”.">
        <input value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
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
