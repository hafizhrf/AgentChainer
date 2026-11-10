import type { FleetItem, TaskTag } from "@agentchainer/protocol";
import type { PermissionAnswer, SessionCallbacks, SessionOptions, TurnResult } from "../session.ts";

/**
 * Task steps on other agents' CLIs (M9, ADR-0012): the seam between a task's runner and whatever agent runs a step.
 * Claude's `Session` is one implementation; Codex and the Antigravity CLI come next (M9-04, M9-05).
 */

/** The agents a task step can run on. */
export type { StepAgent } from "@agentchainer/protocol";

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
 * once the session is over, however it ended. Opening may wait for the agent's CLI: a Codex thread's id, which fix
 * rounds resume by, only exists once its app-server answers (M9-04).
 */
export type StepBackend = (options: StepOptions, callbacks: SessionCallbacks) => StepSession | Promise<StepSession>;

/**
 * A session the sidecar keeps live, whatever agent runs it: what `permission.respond`, `session.interrupt`, the fleet
 * view and closing need (M9-04). Chats add more (sending, modes, rewind), which only Claude's `Session` has.
 */
export interface LiveSession extends StepSession {
  /** A Team chat's worker: the supervisor's session id (M8-03). */
  parentId?: string | undefined;
  readonly fleetItem: FleetItem;
  /** The person's answer to one of its approval requests; false when the request is gone. */
  respond(requestId: string, answer: PermissionAnswer): boolean;
  /** Stops the turn running now; false when there's none. */
  interrupt(): Promise<boolean>;
}

/**
 * A chat tab's session, whatever agent runs it (M9-09): the person sends messages and switches the model, the
 * permission profile and the effort as they go. Claude's `Session` has more (rewind, subagents, Team), which only it
 * offers.
 */
export interface ChatSession extends LiveSession {
  readonly agent: import("@agentchainer/protocol").StepAgent;
  /** Sends a message, or adds it to the turn that's running; returns its id. */
  send(text: string, images?: { mediaType: string; data: string }[]): string;
  setMode(mode: import("@agentchainer/protocol").PermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: import("@agentchainer/protocol").Effort | null): Promise<void>;
}
