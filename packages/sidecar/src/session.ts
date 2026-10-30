import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  AlwaysScope,
  Effort,
  Image,
  PermissionMode,
  PermissionRequest,
  RewindResult,
} from "@agentchainer/protocol";
// Types only: the SDK itself is loaded at runtime by sdk-loader.ts (node_modules in dev, verified download when packaged).
import type {
  HookCallback,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { checkToolCall, READ_TOOLS, readOnlyHook } from "./guard.ts";
import { normalize } from "./normalize.ts";
import { alwaysUpdates, describeUpdates, retarget } from "./permissions.ts";
import { log } from "./rpc.ts";
import type { AgentSdkModule } from "./sdk-loader.ts";

/**
 * Dev-only: when set, every raw SDK message is appended to this local JSONL file. Raw recordings contain local
 * paths and account details; turn them into committable fixtures with scripts/make-fixture.ts.
 */
const RECORD_PATH = process.env.AGENTCHAINER_RECORD_SDK;

export type SessionOptions = {
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: Effort;
  maxBudgetUsd?: number;
  showThinking?: boolean;
  claudePath: string;
  /** Session id from `listSessions` to continue. */
  resume?: string;
  /**
   * A task's read step (M3-06): Read, Grep and Glob inside the workspace, isolated from the user's and the project's
   * settings (no hooks, plugins or MCP servers), like the generators.
   */
  readOnly?: boolean;
  /** Added to the default system prompt: a task step's role (agents/ac-*.md). */
  appendSystemPrompt?: string;
  maxTurns?: number;
  /** Structured output for the session's answers, e.g. the reviewer's findings. */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
};

/** How a turn ended, for code that drives a session itself (a task's steps). */
export type TurnResult = {
  subtype: string;
  isError: boolean;
  /** The final answer's text; empty when the turn stopped on an error. */
  text: string;
  structured?: unknown;
  /** What this turn cost, an estimate. */
  costUsd: number;
};

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

/** The user's answer to a permission request (M1-17), see `permission.respond`. */
export type PermissionAnswer = {
  allow: boolean;
  always?: boolean;
  updatedInput?: Record<string, unknown>;
  message?: string;
  mode?: PermissionMode;
  scope?: AlwaysScope;
};

type Pending = {
  resolve: (result: PermissionResult) => void;
  toolName: string;
  input: Record<string, unknown>;
  always: PermissionUpdate[];
};

type SessionCallbacks = {
  emit: (event: AgentEvent) => void;
  askPermission: (request: Omit<PermissionRequest, "sessionId">) => void;
  /** The query ended: closed, or the CLI process exited. */
  onEnd: () => void;
  /** The user answered a permission request: a task's run records it for its evidence (M3-09). */
  answered?: (request: { toolName: string; input: Record<string, unknown> }, answer: PermissionAnswer) => void;
};

/**
 * One agent session: a streaming-input `query()` (ARCHITECTURE §5.1) so we can push
 * follow-up messages and interrupt, with tool approvals brokered through `canUseTool`.
 */
export class Session {
  /** The SDK session id. We choose it for new sessions so it is known before the first turn. */
  readonly id: string;
  private readonly input = new InputQueue<SDKUserMessage>();
  private readonly pendingPermissions = new Map<string, Pending>();
  private readonly callbacks: SessionCallbacks;
  private readonly q: Query;
  /** User messages sent but not yet answered by a `result`. */
  private openTurns = 0;
  /** `turn()` callers, in order, waiting for their turn's `result`. */
  private readonly waiters: { resolve: (r: TurnResult) => void; reject: (e: Error) => void }[] = [];
  /** The session's running cost, to give each turn its own. */
  private totalCostUsd = 0;
  /** The CLI process, so that closing can wait for it to exit (and let go of the session's folder). */
  private proc: ChildProcess | null = null;
  private closing: Promise<void> | null = null;

  constructor(sdk: AgentSdkModule, options: SessionOptions, callbacks: SessionCallbacks) {
    this.callbacks = callbacks;
    this.id = options.resume ?? randomUUID();
    this.q = sdk.query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        ...(options.resume ? { resume: options.resume } : { sessionId: this.id }),
        // Like the CLI: the user's and the project's settings, CLAUDE.md, skills and hooks (ARCHITECTURE §5.1).
        // A read-only task step is isolated instead, like the generators.
        settingSources: options.readOnly ? [] : ["user", "project", "local"],
        ...(options.readOnly ? { tools: READ_TOOLS } : {}),
        ...(options.appendSystemPrompt
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: options.appendSystemPrompt,
              },
            }
          : {}),
        ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
        ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.maxBudgetUsd ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
        // Without a display mode the CLI streams thinking with empty text; `showThinkingSummaries` alone didn't change
        // that on haiku, adaptive + summarized did (probed live on CLI 2.1.293).
        ...(options.showThinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
        // Backs up files before Edit/Write so they can be rewound (M1-23).
        enableFileCheckpointing: true,
        ...(options.model ? { model: options.model } : {}),
        pathToClaudeCodeExecutable: options.claudePath,
        // Spawned here, as the SDK would, only to keep the process: see close().
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          const child = spawn(command, args, {
            ...(cwd ? { cwd } : {}),
            env,
            signal,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          createInterface({ input: child.stderr }).on("line", (line) => log(`claude: ${line}`));
          this.proc = child;
          return child;
        },
        includePartialMessages: true,
        forwardSubagentText: true,
        permissionMode: options.permissionMode ?? "default",
        hooks: { PreToolUse: [{ hooks: [options.readOnly ? readOnlyHook(options.cwd, "This step") : guardHook] }] },
        canUseTool: (toolName, input, ctx) =>
          new Promise<PermissionResult>((resolve) => {
            const always = ctx.suppressAlwaysAllowRule ? [] : alwaysUpdates(ctx.suggestions);
            this.pendingPermissions.set(ctx.requestId, { resolve, toolName, input, always });
            ctx.signal.addEventListener("abort", () => {
              this.pendingPermissions.delete(ctx.requestId);
              resolve({ behavior: "deny", message: "Request was cancelled." });
            });
            this.callbacks.askPermission({
              requestId: ctx.requestId,
              toolName,
              toolUseId: ctx.toolUseID,
              input,
              alwaysRules: describeUpdates(always),
              ...(ctx.agentID ? { agentId: ctx.agentID } : {}),
              ...(ctx.title ? { title: ctx.title } : {}),
              ...(ctx.description ? { description: ctx.description } : {}),
              ...(ctx.decisionReason ? { decisionReason: ctx.decisionReason } : {}),
              ...(ctx.blockedPath ? { blockedPath: ctx.blockedPath } : {}),
              ...(ctx.defaultToNo ? { defaultToNo: true } : {}),
            });
          }),
      },
    });
    void this.pump();
  }

  /** Returns the message's uuid, which `rewind()` takes. Images go before the text, as the API recommends. */
  send(text: string, images: Image[] = []): string {
    const uuid = randomUUID();
    this.openTurns++;
    const content = images.length
      ? [
          ...images.map((i) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: i.mediaType, data: i.data },
          })),
          { type: "text" as const, text },
        ]
      : text;
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid });
    return uuid;
  }

  /** Sends a message and resolves with how its turn ended: what a task's orchestrator drives steps with. */
  turn(text: string): Promise<TurnResult> {
    const result = new Promise<TurnResult>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.send(text);
    return result;
  }

  /** Restores checkpointed files to their state before the user message `messageId`. */
  async rewind(messageId: string, dryRun: boolean): Promise<RewindResult> {
    const r = await this.q.rewindFiles(messageId, { dryRun });
    return {
      canRewind: r.canRewind,
      ...(r.error ? { error: r.error } : {}),
      filesChanged: r.filesChanged ?? [],
      insertions: r.insertions ?? 0,
      deletions: r.deletions ?? 0,
    };
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

  /** Takes effect from the next turn; an empty string restores the default model. */
  async setModel(model: string): Promise<void> {
    await this.q.setModel(model || undefined);
  }

  async setEffort(effort: Effort | null): Promise<void> {
    await this.q.applyFlagSettings({ effortLevel: effort });
  }

  respond(requestId: string, answer: PermissionAnswer): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    pending.resolve(permissionResult(pending, answer));
    this.callbacks.answered?.({ toolName: pending.toolName, input: pending.input }, answer);
    return true;
  }

  /**
   * Ends the session. Resolves once its CLI has exited, after the SDK's grace period at most: until then it (and the
   * MCP servers it started) still runs in the session's folder, which Windows won't let anyone remove, e.g. an XL
   * sub-task's worktree.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const proc = this.proc;
    const exited =
      proc && proc.exitCode === null && proc.signalCode === null
        ? new Promise<void>((resolve) => proc.once("exit", () => resolve()))
        : Promise.resolve();
    this.input.close();
    this.q.close();
    this.closing = exited;
    return exited;
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) {
        if (RECORD_PATH) appendFileSync(RECORD_PATH, `${JSON.stringify(message)}\n`);
        if (message.type === "result") {
          this.openTurns = Math.max(0, this.openTurns - 1);
          const costUsd = Math.max(0, message.total_cost_usd - this.totalCostUsd);
          this.totalCostUsd = message.total_cost_usd;
          const ok = message.subtype === "success";
          this.waiters.shift()?.resolve({
            subtype: message.subtype,
            isError: message.is_error,
            text: ok ? message.result : "",
            ...(ok && message.structured_output !== undefined ? { structured: message.structured_output } : {}),
            costUsd,
          });
        }
        for (const event of normalize(message)) this.callbacks.emit(event);
      }
    } catch (err) {
      this.callbacks.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const w of this.waiters.splice(0)) w.reject(new Error("The session ended before its turn finished."));
      this.callbacks.onEnd();
    }
  }
}

/** Turns the user's answer into the SDK's permission result. */
export function permissionResult(
  pending: Pick<Pending, "toolName" | "always">,
  answer: PermissionAnswer,
): PermissionResult {
  if (!answer.allow) {
    return { behavior: "deny", message: answer.message?.trim() || "The user denied this action." };
  }
  const updatedPermissions: PermissionUpdate[] = [
    ...(answer.always ? retarget(pending.always, answer.scope ?? "workspace") : []),
    // Approving a plan (M1-16) leaves plan mode for the mode the user picked to execute it in.
    ...(pending.toolName === "ExitPlanMode" && answer.mode
      ? [{ type: "setMode" as const, mode: answer.mode, destination: "session" as const }]
      : []),
  ];
  return {
    behavior: "allow",
    ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
    ...(updatedPermissions.length ? { updatedPermissions } : {}),
  };
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
