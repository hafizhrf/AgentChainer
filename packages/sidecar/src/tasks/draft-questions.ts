import { randomUUID } from "node:crypto";
import type { PermissionRequest, TaskTag } from "@agentchainer/protocol";

/** The answers a question card sends back: question text → the label picked, or the person's own words. */
function answersOf(updatedInput: Record<string, unknown> | undefined): Record<string, string> | null {
  const raw = updatedInput?.answers;
  if (!raw || typeof raw !== "object") return null;
  const answers = Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && e[1].trim() !== ""),
  );
  return Object.keys(answers).length ? answers : null;
}

/**
 * Questions a task's drafter asks the person (UX-24). A draft isn't a chat session, so its questions wait here. Each
 * goes to the task page as a `permission.request` tagged with the task's draft step, the card a step's questions
 * already use, and `permission.respond` brings the answers back through `respond`.
 */
export class DraftQuestions {
  private readonly pending = new Map<string, (answers: Record<string, string> | null) => void>();
  private readonly send: (request: PermissionRequest) => void;

  constructor(send: (request: PermissionRequest) => void) {
    this.send = send;
  }

  /** Asks, and resolves with the answers; null when the person skipped, or when `signal` stopped the draft. */
  ask(
    sessionId: string,
    task: TaskTag,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const settle = (answers: Record<string, string> | null) => {
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", stopped);
        resolve(answers);
      };
      const stopped = () => settle(null);
      signal?.addEventListener("abort", stopped, { once: true });
      this.pending.set(requestId, settle);
      this.send({
        sessionId,
        task,
        requestId,
        toolName: "AskUserQuestion",
        toolUseId: requestId,
        input,
        alwaysRules: [],
      });
    });
  }

  /** The person's answer to one of these questions; false when `requestId` isn't one of them. */
  respond(requestId: string, allow: boolean, updatedInput?: Record<string, unknown>): boolean {
    const settle = this.pending.get(requestId);
    if (!settle) return false;
    settle(allow ? answersOf(updatedInput) : null);
    return true;
  }

  /** How many questions wait for an answer. */
  get waiting(): number {
    return this.pending.size;
  }
}
