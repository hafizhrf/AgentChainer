import {
  query,
  type HookCallback,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
import { checkToolCall } from "./guard.ts";

export type SessionOptions = { cwd: string; model?: string; permissionMode?: PermissionMode; claudePath: string };

/** Runs the hard denylist on every tool call, including ones `canUseTool` never sees (ARCHITECTURE §6). */
const guardHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const reason = checkToolCall(input.tool_name, input.tool_input, input.cwd);
  if (!reason) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Blocked by AgentChainer guard: ${reason}`,
    },
  };
};

type SessionCallbacks = {
  emit: (event: AgentEvent) => void;
  askPermission: (request: PermissionRequest) => void;
};

/**
 * One agent session: a streaming-input `query()` (ARCHITECTURE §5.1) so we can push
 * follow-up messages and interrupt, with tool approvals brokered through `canUseTool`.
 */
export class Session {
  private readonly input = new InputQueue<SDKUserMessage>();
  private readonly pendingPermissions = new Map<string, (result: PermissionResult) => void>();
  private readonly callbacks: SessionCallbacks;
  private readonly q: Query;
  /** User messages sent but not yet answered by a `result`. */
  private openTurns = 0;

  constructor(options: SessionOptions, callbacks: SessionCallbacks) {
    this.callbacks = callbacks;
    this.q = query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        pathToClaudeCodeExecutable: options.claudePath,
        includePartialMessages: true,
        permissionMode: options.permissionMode ?? "default",
        hooks: { PreToolUse: [{ hooks: [guardHook] }] },
        canUseTool: (toolName, input, ctx) =>
          new Promise<PermissionResult>((resolve) => {
            this.pendingPermissions.set(ctx.requestId, resolve);
            ctx.signal.addEventListener("abort", () => {
              this.pendingPermissions.delete(ctx.requestId);
              resolve({ behavior: "deny", message: "Request was cancelled." });
            });
            this.callbacks.askPermission({
              requestId: ctx.requestId,
              toolName,
              toolUseId: ctx.toolUseID,
              input,
              ...(ctx.agentID ? { agentId: ctx.agentID } : {}),
              ...(ctx.title ? { title: ctx.title } : {}),
              ...(ctx.description ? { description: ctx.description } : {}),
            });
          }),
      },
    });
    void this.pump();
  }

  send(text: string): void {
    this.openTurns++;
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  /**
   * Interrupts the running turn. Does nothing when idle: spike S3 showed an interrupt sent
   * between turns aborts the *next* turn, e.g. a Stop click racing the end of a reply.
   */
  async interrupt(): Promise<boolean> {
    if (this.openTurns === 0) return false;
    await this.q.interrupt();
    return true;
  }

  /** Takes effect for the next tool call (streaming-input mode only). */
  async setMode(mode: PermissionMode): Promise<void> {
    await this.q.setPermissionMode(mode);
  }

  respond(requestId: string, allow: boolean, message?: string): boolean {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return false;
    this.pendingPermissions.delete(requestId);
    resolve(allow ? { behavior: "allow" } : { behavior: "deny", message: message || "The user denied this action." });
    return true;
  }

  close(): void {
    this.input.close();
    this.q.close();
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) this.handle(message);
    } catch (err) {
      this.callbacks.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private handle(m: SDKMessage): void {
    const { emit } = this.callbacks;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          emit({
            type: "session.started",
            sessionId: m.session_id,
            model: m.model,
            cwd: m.cwd,
            claudeCodeVersion: m.claude_code_version,
            permissionMode: m.permissionMode,
          });
        }
        break;
      case "stream_event":
        // Only the main agent streams deltas; subagent text would need forwardSubagentText (S4).
        if (
          m.parent_tool_use_id === null &&
          m.event.type === "content_block_delta" &&
          m.event.delta.type === "text_delta"
        ) {
          emit({ type: "text.delta", text: m.event.delta.text });
        }
        break;
      case "assistant":
        for (const block of m.message.content) {
          if (block.type === "tool_use") {
            emit({
              type: "tool.started",
              toolUseId: block.id,
              name: block.name,
              input: block.input,
              parentToolUseId: m.parent_tool_use_id,
            });
          }
        }
        break;
      case "user": {
        const content = m.message.content;
        if (typeof content === "string") break;
        for (const block of content) {
          if (block.type === "tool_result") {
            emit({
              type: "tool.completed",
              toolUseId: block.tool_use_id,
              isError: block.is_error === true,
              output: summarize(block.content),
            });
          }
        }
        break;
      }
      case "result":
        this.openTurns = Math.max(0, this.openTurns - 1);
        emit({
          type: "turn.completed",
          subtype: m.subtype,
          isError: m.is_error,
          costUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
          numTurns: m.num_turns,
        });
        break;
    }
  }
}

/** Flattens tool_result content to text and caps it, so large outputs don't flood the IPC channel. */
function summarize(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n")
        : "";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length - 4000} more chars)` : text;
}

/** Minimal async queue used as the SDK's streaming prompt input. */
class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}
