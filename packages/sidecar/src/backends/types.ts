import type { TaskTag } from "@agentchainer/protocol";
import type { SessionCallbacks, SessionOptions, TurnResult } from "../session.ts";

/**
 * Task steps on other agents' CLIs (M9, ADR-0012): the seam between a task's runner and whatever agent runs a step.
 * Claude's `Session` is one implementation; Codex and the Antigravity CLI come next (M9-04, M9-05).
 */

/** The agents a task step can run on. */
export type StepAgent = "claude" | "codex" | "agy";

/** What a task's runner needs from a step's session, whatever agent runs it. */
export interface StepSession {
  /** The agent's own id for the conversation: resuming it later continues the step (fix rounds). */
  readonly id: string;
  /** Which task and step the session works for, so the fleet view and approvals can say so (M8-02). */
  tag: TaskTag | undefined;
  /** Sends a prompt and resolves when the agent's turn ends. */
  turn(prompt: string): Promise<TurnResult>;
  /** A message from the person into the turn running now; false when there's none to take it. */
  inject(text: string): boolean;
  /** Ends the session, and waits until its process has let go of the folder. */
  close(): Promise<void>;
}

/** What a runner asks of a step's session. Each backend maps it onto its own CLI. */
export type StepOptions = Pick<
  SessionOptions,
  | "cwd"
  | "additionalDirectories"
  | "model"
  | "permissionMode"
  | "maxBudgetUsd"
  | "readOnly"
  | "appendSystemPrompt"
  | "maxTurns"
  | "outputFormat"
  | "resume"
>;

/**
 * Opens a step's session. Its callbacks feed the runner's records (approvals, guard blocks) and the UI; `onEnd` runs
 * once the session is over, however it ended.
 */
export type StepBackend = (options: StepOptions, callbacks: SessionCallbacks) => StepSession;
