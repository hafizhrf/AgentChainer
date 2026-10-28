import { appendFileSync } from "node:fs";
import type { AgentEvent, PermissionMode, PermissionRequest } from "@agentchainer/protocol";
// Types only: the SDK itself is loaded at runtime by sdk-loader.ts (node_modules in dev, verified download when packaged).
import type { HookCallback, PermissionResult, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { checkToolCall } from "./guard.ts";
import { normalize } from "./normalize.ts";
import type { AgentSdkModule } from "./sdk-loader.ts";

/**
 * Dev-only: when set, every raw SDK message is appended to this local JSONL file. Raw recordings contain local
 * paths and account details; turn them into committable fixtures with scripts/make-fixture.ts.
 */
const RECORD_PATH = process.env.AGENTCHAINER_RECORD_SDK;

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

  constructor(sdk: AgentSdkModule, options: SessionOptions, callbacks: SessionCallbacks) {
    this.callbacks = callbacks;
    this.q = sdk.query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        pathToClaudeCodeExecutable: options.claudePath,
        includePartialMessages: true,
        forwardSubagentText: true,
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
      for await (const message of this.q) {
        if (RECORD_PATH) appendFileSync(RECORD_PATH, `${JSON.stringify(message)}\n`);
        if (message.type === "result") this.openTurns = Math.max(0, this.openTurns - 1);
        for (const event of normalize(message)) this.callbacks.emit(event);
      }
    } catch (err) {
      this.callbacks.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
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
