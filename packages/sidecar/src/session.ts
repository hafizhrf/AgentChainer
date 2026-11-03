import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type {
  AgentEvent,
  AlwaysScope,
  Effort,
  FleetItem,
  Image,
  PermissionMode,
  PermissionRequest,
  RewindResult,
  TaskTag,
} from "@agentchainer/protocol";
// Types only: the SDK itself is loaded at runtime by sdk-loader.ts (node_modules in dev, verified download when packaged).
import type {
  HookCallback,
  McpSdkServerConfigWithInstance,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { checkToolCall, READ_TOOLS, readOnlyHook } from "./guard.ts";
import { command, normalize } from "./normalize.ts";
import { alwaysUpdates, describeUpdates, retarget } from "./permissions.ts";
import { log } from "./rpc.ts";
import { type AgentSdkModule, ALLOW_BACKGROUND } from "./sdk-loader.ts";

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
  /**
   * Lets the CLI run subagents and shells in the background (M4-07): interactive sessions only, which show and stop
   * them one by one. A task's steps leave it off, so their work is done when the turn ends.
   */
  background?: boolean;
  /** A multi-folder workspace's other folders (M8-01): the SDK's `additionalDirectories`, and roots for the guard. */
  additionalDirectories?: string[];
  /**
   * A chat in a tab (UX-12): it lists the session's slash commands, reports how full the context window is after each
   * turn, may switch itself to plan mode, and is asked to ask the person rather than guess.
   */
  interactive?: boolean;
  /**
   * The app's own tools, as an in-process MCP server (M8-03: a Team chat's tools to run workers). Its calls are allowed
   * without asking: they only start or message sessions whose own tool calls are asked about as usual.
   */
  appTools?: McpSdkServerConfigWithInstance;
};

/** The name of the app's in-process MCP server, so its tools are `mcp__agentchainer__<tool>`. */
export const APP_TOOLS = "agentchainer";

/**
 * Added to an interactive session's system prompt (UX-12): like the CLI, the agent asks before acting on an ambiguous
 * request, through plan mode and its question tool, which the app shows as a question card.
 */
export const ASK_FIRST =
  "When a request is ambiguous or needs a decision from the user, don't guess: call EnterPlanMode, then ask with " +
  "AskUserQuestion (2-4 options per question), and plan from the answers.";

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

/**
 * Runs the hard denylist on every tool call, including ones `canUseTool` never sees (ARCHITECTURE §6). `roots` are a
 * multi-folder workspace's other folders (M8-01): the hook's own `cwd` is the primary folder only.
 */
const guardHookFor =
  (roots: string[]): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const reason = checkToolCall(input.tool_name, input.tool_input, input.cwd, undefined, roots);
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
  /** The fleet status changed (M8-02): working, waiting, idle or ended. */
  statusChanged?: (item: FleetItem) => void;
  /**
   * Every turn that a message started has ended, whoever sent it (M8-03): a Team's worker reports from here, so a turn
   * the person starts in the worker's tab reports too. Called after the turn's events.
   */
  turnEnded?: (result: TurnResult) => void;
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
  /** Turns the CLI started on its own when background work ended (M4-07), not yet answered by a `result`. */
  private autoTurns = 0;
  /** The session's live background tasks, from `background_tasks_changed`. */
  private background = new Set<string>();
  /** `turn()` callers, in order, waiting for their turn's `result`. */
  private readonly waiters: { resolve: (r: TurnResult) => void; reject: (e: Error) => void }[] = [];
  /** The session's running cost, to give each turn its own. */
  private totalCostUsd = 0;
  /** The CLI process, so that closing can wait for it to exit (and let go of the session's folder). */
  private proc: ChildProcess | null = null;
  private closing: Promise<void> | null = null;
  private readonly interactive: boolean;
  private readonly cwd: string;
  private readonly startedAt = new Date().toISOString();
  private status: FleetItem["status"] = "idle";
  private statusSince = this.startedAt;
  private ended = false;
  /** A task step's tag, set by the task's runner, so the fleet view says whose step it is (M8-02). */
  tag: TaskTag | undefined;
  /** A Team chat's worker: the supervisor's session id, for the fleet view (M8-03). */
  parentId: string | undefined;
  /** The command list goes out once, at the start; later changes arrive as `commands_changed`. */
  private commandsSent = false;

  constructor(sdk: AgentSdkModule, options: SessionOptions, callbacks: SessionCallbacks) {
    this.callbacks = callbacks;
    this.interactive = options.interactive === true;
    this.cwd = options.cwd;
    this.id = options.resume ?? randomUUID();
    const append = options.appendSystemPrompt ?? (this.interactive ? ASK_FIRST : undefined);
    this.q = sdk.query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        ...(options.resume ? { resume: options.resume } : { sessionId: this.id }),
        // Like the CLI: the user's and the project's settings, CLAUDE.md, skills and hooks (ARCHITECTURE §5.1).
        // A read-only task step is isolated instead, like the generators.
        settingSources: options.readOnly ? [] : ["user", "project", "local"],
        ...(options.readOnly ? { tools: READ_TOOLS } : {}),
        ...(append ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append } } : {}),
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
        ...(options.additionalDirectories?.length ? { additionalDirectories: options.additionalDirectories } : {}),
        ...(options.appTools ? { mcpServers: { [APP_TOOLS]: options.appTools } } : {}),
        env: {
          ...process.env,
          // The to-do tool is off by default on newer models; the todo panel (UX-12) shows its list. On CLI 2.1.314 this
          // gives TodoWrite (probed live); `allowedTools` would too, but would skip canUseTool for it.
          CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
          ...(options.background ? { [ALLOW_BACKGROUND]: "1" } : {}),
        },
        // The app shows a Stop per background task, so an interrupt stops the turn only (sdk.d.ts).
        ...(options.background ? { perTaskStopAffordance: true } : {}),
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
        hooks: {
          PreToolUse: [
            {
              hooks: [
                options.readOnly
                  ? readOnlyHook(options.cwd, "This step")
                  : guardHookFor(options.additionalDirectories ?? []),
              ],
            },
          ],
        },
        canUseTool: (toolName, input, ctx) =>
          new Promise<PermissionResult>((resolve) => {
            // A chat may switch itself to plan mode (UX-12): that only narrows what it can do, so nobody is asked.
            // Leaving plan mode still goes through ExitPlanMode's review.
            if (this.interactive && toolName === "EnterPlanMode") {
              resolve({
                behavior: "allow",
                updatedInput: input,
                updatedPermissions: [{ type: "setMode", mode: "plan", destination: "session" }],
              });
              return;
            }
            if (options.appTools && toolName.startsWith(`mcp__${APP_TOOLS}__`)) {
              resolve({ behavior: "allow", updatedInput: input });
              return;
            }
            const always = ctx.suppressAlwaysAllowRule ? [] : alwaysUpdates(ctx.suggestions);
            this.pendingPermissions.set(ctx.requestId, { resolve, toolName, input, always });
            this.touch();
            ctx.signal.addEventListener("abort", () => {
              this.pendingPermissions.delete(ctx.requestId);
              this.touch();
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
    // The list is there before the first message, so `/` works in a new chat; init would only come with the first turn.
    if (this.interactive) {
      void this.sendCommands();
      void this.sendModels();
    }
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
    this.touch();
    return uuid;
  }

  /**
   * Adds the person's message to the turn that's running (UX-13): the CLI takes it into that turn, with no result of
   * its own (probed on CLI 2.1.314), so it doesn't count as a turn. Shown as a user message in the session's events.
   * False when no turn runs; a message that lands just after a turn ends starts one the CLI runs on its own, which
   * the session already counts as a background turn.
   */
  inject(text: string): boolean {
    if (!this.busy) return false;
    const uuid = randomUUID();
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid });
    this.callbacks.emit({ type: "user.message", messageId: uuid, text });
    return true;
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
    if (!this.busy) return false;
    await this.q.interrupt();
    return true;
  }

  /**
   * Stops one subagent (M4-05) or background task (M4-07). Nothing is sent when the session is idle and the task isn't
   * a live background task, as for interrupt.
   */
  async stopAgent(taskId: string): Promise<boolean> {
    if (!this.busy && !this.background.has(taskId)) return false;
    await this.q.stopTask(taskId);
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
    this.touch();
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

  /** The session's slash commands with their descriptions, for the composer's `/` menu. */
  private async sendCommands(): Promise<void> {
    try {
      const commands = await this.q.supportedCommands();
      this.commandsSent = true;
      this.callbacks.emit({ type: "commands.changed", commands: commands.map(command) });
    } catch (err) {
      log(`supportedCommands failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The models the CLI offers, named as its `/model` names them, for the composer's picker. */
  private async sendModels(): Promise<void> {
    try {
      const models = await this.q.supportedModels();
      this.callbacks.emit({
        type: "models.changed",
        models: models.map((m) => ({
          value: m.value,
          displayName: m.displayName,
          description: m.description,
          ...(m.supportedEffortLevels?.length ? { efforts: [...m.supportedEffortLevels] } : {}),
        })),
      });
    } catch (err) {
      log(`supportedModels failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** How full the context window is; a failure only leaves the meter as it was. */
  private async sendContextUsage(): Promise<void> {
    try {
      const u = await this.q.getContextUsage({ detail: "summary" });
      this.callbacks.emit({
        type: "context.usage",
        percentage: u.percentage,
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        categories: u.categories
          .filter((c) => c.kind !== "deferred" && c.tokens > 0)
          .map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
      });
    } catch (err) {
      log(`getContextUsage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** What the fleet view shows of this session (M8-02). */
  get fleetItem(): FleetItem {
    return {
      sessionId: this.id,
      cwd: this.cwd,
      status: this.status,
      waiting: this.pendingPermissions.size,
      costUsd: this.totalCostUsd,
      startedAt: this.startedAt,
      since: this.statusSince,
      ...(this.tag ? { task: this.tag } : {}),
      ...(this.parentId ? { parentId: this.parentId } : {}),
    };
  }

  /** Works out the fleet status again, and reports a change. Waiting for the person comes before working. */
  private touch(): void {
    const next: FleetItem["status"] = this.ended
      ? "ended"
      : this.pendingPermissions.size > 0
        ? "waiting"
        : this.busy || this.background.size > 0
          ? "working"
          : "idle";
    if (next === this.status) return;
    this.status = next;
    this.statusSince = new Date().toISOString();
    this.callbacks.statusChanged?.(this.fleetItem);
  }

  /** No turn runs, so a message sent now starts one (M8-03: when a Team delivers its workers' reports). */
  get idle(): boolean {
    return !this.busy && !this.ended;
  }

  /** What the session has spent since it started, an estimate. */
  get costUsd(): number {
    return this.totalCostUsd;
  }

  /** A turn runs: one the user started, or one the CLI started after background work. */
  private get busy(): boolean {
    return this.openTurns + this.autoTurns > 0;
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) {
        let ended: TurnResult | undefined;
        if (RECORD_PATH) appendFileSync(RECORD_PATH, `${JSON.stringify(message)}\n`);
        // Every turn starts with init (spike S2). One that no user message opened is the CLI going on after background
        // work (M4-07). The CLI runs turns one at a time, so the next result is that turn's.
        if (message.type === "system" && message.subtype === "init" && !this.busy) {
          this.autoTurns++;
          this.callbacks.emit({ type: "turn.started", reason: "background" });
        }
        // Asked again at the first init if asking at the start failed.
        if (message.type === "system" && message.subtype === "init" && this.interactive && !this.commandsSent) {
          void this.sendCommands();
        }
        if (message.type === "system" && message.subtype === "background_tasks_changed") {
          this.background = new Set(message.tasks.map((t) => t.task_id));
        }
        if (message.type === "result" && this.autoTurns > 0) {
          this.autoTurns--;
          this.totalCostUsd = message.total_cost_usd;
        } else if (message.type === "result") {
          this.openTurns = Math.max(0, this.openTurns - 1);
          const costUsd = Math.max(0, message.total_cost_usd - this.totalCostUsd);
          this.totalCostUsd = message.total_cost_usd;
          const ok = message.subtype === "success";
          ended = {
            subtype: message.subtype,
            isError: message.is_error,
            text: ok ? message.result : "",
            ...(ok && message.structured_output !== undefined ? { structured: message.structured_output } : {}),
            costUsd,
          };
          this.waiters.shift()?.resolve(ended);
        }
        for (const event of normalize(message)) this.callbacks.emit(event);
        if (message.type === "result" || message.type === "system") this.touch();
        if (message.type === "result" && this.interactive) void this.sendContextUsage();
        if (ended) this.callbacks.turnEnded?.(ended);
      }
    } catch (err) {
      this.callbacks.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      this.ended = true;
      this.touch();
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
