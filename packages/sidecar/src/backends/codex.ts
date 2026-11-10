import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent, CostKind, Effort, FleetItem, PermissionMode, TaskTag } from "@agentchainer/protocol";
import type { Cli } from "../deploy/cli.ts";
import { checkBash, checkToolCall, GUARD_PREFIX } from "../guard.ts";
import { t } from "../i18n/index.ts";
import { log } from "../rpc.ts";
import type { PermissionAnswer, SessionCallbacks, TurnResult } from "../session.ts";
import { recordRun } from "../usage/ledger.ts";
import {
  type CodexItem,
  type CodexUsage,
  changesOf,
  commandOf,
  itemCompleted,
  itemStarted,
  usageOf,
} from "./codex-events.ts";
import { estimateUsd } from "./prices.ts";
import type { ChatSession, LiveSession, StepBackend, StepOptions } from "./types.ts";

/**
 * Task steps on the user's own Codex CLI (M9-04, ADR-0012, spike S8), through `codex app-server`: JSON-RPC over stdio,
 * one process per step. The user's own login and binary; the app never signs in for them (ADR-0002).
 *
 * Every command and file change asks first (approval policy `untrusted`): the guard checks it before anything runs,
 * then the step's permission profile and the approval dialog decide, as for a Claude step. Read steps run in Codex's
 * `read-only` sandbox and never ask. Costs come as tokens: a ChatGPT login is plan usage, with no price per token, so a
 * step reports its tokens and no dollars (see the M9-04 PR; the budget cap counts Claude's spend).
 */

/** Where Codex step sessions are registered, so `permission.respond` and `session.interrupt` reach them. */
export type CodexHost = {
  cli: Cli;
  /** `codex --version`, for the session's start line. */
  version: string;
  register(session: LiveSession): void;
  unregister(sessionId: string): void;
};

export function codexBackend(host: CodexHost): StepBackend {
  return async (options, callbacks) => {
    const session = new CodexSession(host, options, {
      ...callbacks,
      onEnd: () => {
        host.unregister(session.id);
        callbacks.onEnd();
      },
    });
    await session.open();
    host.register(session);
    return session;
  };
}

/**
 * A chat on Codex (M9-09): the same session as a step's, opened as a chat. Its opening events wait for `release()`,
 * once the UI has the tab.
 */
export async function openCodexChat(
  host: CodexHost,
  options: StepOptions,
  callbacks: SessionCallbacks,
): Promise<ChatSession & { release(): void }> {
  const session = new CodexSession(
    host,
    options,
    {
      ...callbacks,
      onEnd: () => {
        host.unregister(session.id);
        callbacks.onEnd();
      },
    },
    true,
  );
  await session.open();
  host.register(session);
  return session;
}

/** Model names that are Claude's, which a Codex step can't use: it takes Codex's default instead. */
const CLAUDE_MODEL = /^(inherit|default|opus|sonnet|haiku|fable)$|^claude-/i;

type Frame = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
};
type Ask = { rpcId: number | string; toolName: string; input: Record<string, unknown>; toolUseId: string };

const NO_USAGE: CodexUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
const plus = (a: CodexUsage, b: CodexUsage): CodexUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
});
const minus = (a: CodexUsage, b: CodexUsage): CodexUsage => ({
  inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
  cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
});

class CodexSession implements ChatSession {
  readonly agent = "codex" as const;
  id = "";
  tag: TaskTag | undefined;
  parentId: string | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private next = 1;
  private readonly pending = new Map<number, { resolve: (f: Frame) => void; reject: (e: Error) => void }>();
  /** Items as they started: a file change's paths come with its start, before its approval request (S8). */
  private readonly started = new Map<string, CodexItem>();
  /** Items the guard declined, with why: their completion carries the guard's reason, which the evidence records. */
  private readonly guarded = new Map<string, string>();
  /** Approval requests waiting for the person, by the request id the UI answers. */
  private readonly asks = new Map<string, Ask>();
  private turnId: string | null = null;
  private waiter: { resolve: (r: TurnResult) => void; reject: (e: Error) => void } | null = null;
  private messages: string[] = [];
  private turnError: string | null = null;
  private total: CodexUsage = { ...NO_USAGE };
  /**
   * The thread's total before this turn's first request: a resumed thread's total includes its earlier turns, so a
   * turn's tokens are the total now less this (M9-07). Null until the turn's first usage update.
   */
  private turnBase: CodexUsage | null = null;
  /** What this session's turns used, for the fleet's cost. */
  private spent: CodexUsage = { ...NO_USAGE };
  /** The turn was stopped for passing the step's budget. */
  private overBudget = false;
  model = "";
  /** The models this login can use, from `model/list`: a chat's model picker (M9-09). */
  private models: { id: string; name: string; isDefault: boolean; efforts: string[] }[] = [];
  /** A chat's choices for its next turns: `turn/start` takes them per turn. */
  private nextModel: string | null = null;
  private nextEffort: Effort | null = null;
  /** A chat tab's session (M9-09), not a task's step. */
  readonly chat: boolean;
  /** A chat's events until its tab exists; null once released. */
  private held: AgentEvent[] | null = null;
  /** Messages sent while a turn was starting, before its id was known: steered in once it is. */
  private queued: string[] = [];
  private turns = 0;
  private status: FleetItem["status"] = "idle";
  private readonly startedAt = new Date().toISOString();
  private since = this.startedAt;
  private ended = false;
  private closing: Promise<void> | null = null;

  private readonly host: CodexHost;
  /** Mutable: a chat changes its permission profile as it goes. */
  private options: StepOptions;
  private readonly callbacks: SessionCallbacks;

  constructor(host: CodexHost, options: StepOptions, callbacks: SessionCallbacks, chat = false) {
    this.host = host;
    this.options = options;
    this.callbacks = callbacks;
    this.chat = chat;
    if (chat) this.held = [];
    this.child = spawn(host.cli.bin, [...host.cli.prefix, "app-server"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: this.child.stderr }).on("line", (line) => log(`codex: ${line}`));
    this.child.on("exit", () => this.end());
    this.child.on("error", (err) => {
      log(`codex: ${err.message}`);
      this.end();
    });
  }

  /**
   * Starts the app-server, then a thread (or resumes one): the thread's id is the session's. If that fails, the
   * app-server is stopped, so it doesn't stay on as the thread's writer.
   */
  async open(): Promise<void> {
    try {
      await this.start();
    } catch (err) {
      void this.close();
      throw err;
    }
  }

  private async start(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "agentchainer", title: "AgentChainer", version: "0" },
      capabilities: null,
    });
    this.notify("initialized");
    const model = await this.pickModel();
    const readOnly = this.options.readOnly === true;
    const thread = {
      cwd: this.options.cwd,
      sandbox: readOnly ? "read-only" : "workspace-write",
      approvalPolicy: readOnly ? "never" : "untrusted",
      ...(model ? { model } : {}),
      ...(this.options.appendSystemPrompt ? { developerInstructions: this.options.appendSystemPrompt } : {}),
    };
    const r = this.options.resume
      ? await this.request("thread/resume", { threadId: this.options.resume, ...thread, excludeTurns: true })
      : await this.request("thread/start", thread);
    const id = (r.result as { thread?: { id?: string } } | undefined)?.thread?.id;
    if (!id) throw new Error(t("tasks.codex.noThread", { error: r.error?.message ?? "no thread id" }));
    this.id = id;
    this.model = model ?? "";
    this.emit({
      type: "session.started",
      sessionId: id,
      model: model ?? "codex",
      cwd: this.options.cwd,
      claudeCodeVersion: this.host.version,
      permissionMode: this.options.permissionMode ?? "default",
    });
    // A chat's model picker lists Codex's own models (M9-09).
    if (this.chat && this.models.length) {
      this.emit({
        type: "models.changed",
        models: this.models.map((m) => ({
          value: m.id,
          displayName: m.name,
          description: m.isDefault ? t("tasks.codex.defaultModel") : "",
          ...(m.efforts.length ? { efforts: m.efforts } : {}),
        })),
      });
    }
  }

  /**
   * A chat message (M9-09): a new turn, or added to the turn that's running (`turn/steer`). Codex keeps the thread,
   * so each turn continues it. Images aren't sent to Codex yet.
   */
  send(text: string): string {
    const id = randomUUID();
    if (this.waiter) {
      if (this.turnId) this.inject(text);
      else this.queued.push(text);
      return id;
    }
    void this.turn(text).catch((err: unknown) =>
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return id;
  }

  /** Plan mode isn't Codex's: it can't be asked to only plan. The others decide what's accepted without asking. */
  async setMode(mode: PermissionMode): Promise<void> {
    if (mode === "plan") throw new Error(t("rpc.session.codexNoPlan"));
    this.options = { ...this.options, permissionMode: mode };
  }

  /** From the next turn; "" is Codex's own default. */
  async setModel(model: string): Promise<void> {
    this.nextModel = model && model !== "default" ? model : null;
  }

  async setEffort(effort: Effort | null): Promise<void> {
    this.nextEffort = effort;
  }

  /**
   * The step's model when it's one of Codex's, else what Codex itself calls its default (`model/list`). The user's own
   * config may name a model their login can't use (S8), so a step never leaves it to the config.
   */
  private async pickModel(): Promise<string | undefined> {
    const asked = this.options.model;
    const r = await this.request("model/list", { limit: 50 });
    const list =
      (r.result as { data?: { id?: string; name?: string; isDefault?: boolean; efforts?: unknown }[] } | undefined)
        ?.data ?? [];
    this.models = list
      .filter((m): m is typeof m & { id: string } => typeof m.id === "string")
      .map((m) => ({
        id: m.id,
        name: typeof m.name === "string" && m.name ? m.name : m.id,
        isDefault: m.isDefault === true,
        efforts: Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === "string") : [],
      }));
    if (asked && !CLAUDE_MODEL.test(asked)) return asked;
    return (this.models.find((m) => m.isDefault) ?? this.models[0])?.id;
  }

  turn(prompt: string): Promise<TurnResult> {
    if (this.ended) return Promise.reject(new Error(t("tasks.codex.ended")));
    this.messages = [];
    this.turnError = null;
    const done = new Promise<TurnResult>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
    this.touch("working");
    // A chat's model choice applies from this turn on; the turn's cost is priced at it.
    if (this.nextModel) this.model = this.nextModel;
    void this.request("turn/start", {
      threadId: this.id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(this.options.outputFormat ? { outputSchema: this.options.outputFormat.schema } : {}),
      ...(this.nextModel ? { model: this.nextModel } : {}),
      ...(this.nextEffort ? { effort: this.nextEffort } : {}),
    }).then((r) => {
      if (r.error) this.finishTurn("failed", r.error.message ?? "turn/start failed");
    });
    return done;
  }

  inject(text: string): boolean {
    if (!this.turnId) return false;
    void this.request("turn/steer", {
      threadId: this.id,
      expectedTurnId: this.turnId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    return true;
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnId) return false;
    await this.request("turn/interrupt", { threadId: this.id, turnId: this.turnId });
    return true;
  }

  respond(requestId: string, answer: PermissionAnswer): boolean {
    const ask = this.asks.get(requestId);
    if (!ask) return false;
    this.asks.delete(requestId);
    this.reply(ask.rpcId, answer.allow ? "accept" : "decline");
    this.callbacks.answered?.({ toolName: ask.toolName, input: ask.input }, answer);
    this.touch(this.asks.size ? "waiting" : "working");
    return true;
  }

  get fleetItem(): FleetItem {
    return {
      sessionId: this.id,
      cwd: this.options.cwd,
      status: this.status,
      waiting: this.asks.size,
      costUsd: this.costOf(plus(this.spent, this.turnUsage())) ?? 0,
      agent: "codex",
      ...(this.model ? { model: this.model } : {}),
      costKind: this.costKind,
      startedAt: this.startedAt,
      since: this.since,
      ...(this.tag ? { task: this.tag } : {}),
      ...(this.parentId ? { parentId: this.parentId } : {}),
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      this.child.once("exit", () => resolve());
      this.child.stdin.end();
      setTimeout(() => this.child.kill(), 3000).unref();
    });
    return this.closing;
  }

  // ---- plumbing ----

  private write(f: Frame) {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(f)}\n`);
  }

  private request(method: string, params: unknown): Promise<Frame> {
    const id = this.next++;
    this.write({ id, method, params } as Frame);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string) {
    this.write({ method });
  }

  private reply(id: number | string, decision: string) {
    this.write({ id, result: { decision } } as Frame);
  }

  private emit(event: AgentEvent) {
    if (this.held) this.held.push(event);
    else this.callbacks.emit(event);
  }

  /**
   * A chat's events from opening (its start, its models) wait until the UI has its tab: `session.start` answers
   * first, then this sends them.
   */
  release(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const e of held) this.callbacks.emit(e);
  }

  private touch(status: FleetItem["status"]) {
    if (this.status === status) return;
    this.status = status;
    this.since = new Date().toISOString();
    if (this.id) this.callbacks.statusChanged?.(this.fleetItem);
  }

  private onLine(line: string) {
    let f: Frame;
    try {
      f = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    if (f.id !== undefined && f.method) return this.onRequest(f);
    if (f.id !== undefined) {
      const p = this.pending.get(f.id as number);
      this.pending.delete(f.id as number);
      return p?.resolve(f);
    }
    if (f.method) this.onNotification(f.method, f.params ?? {});
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    const item = (params.item ?? null) as CodexItem | null;
    switch (method) {
      case "turn/started":
        this.turnId = String((params.turn as { id?: string } | undefined)?.id ?? "") || null;
        // A chat's messages sent while the turn was starting join it now.
        for (const text of this.queued.splice(0)) this.inject(text);
        return;
      case "item/started":
        if (item) {
          this.started.set(item.id, item);
          for (const e of itemStarted(item)) this.emit(e);
        }
        return;
      case "item/completed":
        if (!item) return;
        if (item.type === "agentMessage" && typeof item.text === "string") this.messages.push(item.text);
        for (const e of itemCompleted(item)) {
          const why = this.guarded.get(item.id);
          this.emit(why && e.type === "tool.completed" ? { ...e, isError: true, output: `${GUARD_PREFIX}${why}` } : e);
        }
        this.started.delete(item.id);
        return;
      case "item/agentMessage/delta":
        if (typeof params.delta === "string") this.emit({ type: "text.delta", text: params.delta });
        return;
      case "thread/tokenUsage/updated": {
        const usage = usageOf(params);
        if (!usage) return;
        this.total = usage.total;
        this.turnBase ??= minus(usage.total, usage.last);
        // Codex has no budget of its own: stop the turn once its estimate passes the step's cap.
        const cap = this.options.maxBudgetUsd;
        const cost = this.costOf(this.turnUsage());
        if (cap !== undefined && cost !== null && cost > cap && !this.overBudget && this.turnId) {
          this.overBudget = true;
          void this.interrupt();
        }
        return;
      }
      case "error": {
        const e = params.error as { message?: string } | undefined;
        if (params.willRetry !== true && e?.message) this.turnError = e.message;
        return;
      }
      case "turn/completed": {
        const turn = (params.turn ?? {}) as {
          status?: string;
          error?: { message?: string } | null;
          durationMs?: number;
        };
        this.finishTurn(turn.status ?? "completed", turn.error?.message ?? this.turnError, turn.durationMs);
        return;
      }
    }
  }

  private finishTurn(status: string, error: string | null, durationMs = 0) {
    this.turnId = null;
    this.turns++;
    const used = this.turnUsage();
    this.spent = plus(this.spent, used);
    if (used.inputTokens + used.outputTokens + used.reasoningOutputTokens > 0) {
      recordRun({
        agent: "codex",
        model: this.model || "codex",
        input: used.inputTokens,
        output: used.outputTokens + used.reasoningOutputTokens,
        costUsd: this.costOf(used) ?? 0,
        costKind: this.costKind,
        cwd: this.options.cwd,
        sessionId: this.id,
        ...(this.tag ? { title: [this.tag.title, this.tag.label].filter(Boolean).join(" · ") } : {}),
      });
    }
    this.turnBase = null;
    const overBudget = this.overBudget;
    this.overBudget = false;
    const ok = status === "completed";
    const text = this.messages.at(-1) ?? "";
    const subtype = ok
      ? "success"
      : overBudget
        ? "error_max_budget_usd"
        : status === "interrupted"
          ? "interrupted"
          : "error_during_execution";
    let structured: unknown;
    if (ok && this.options.outputFormat && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        // The review's parser falls back to JSON found in the text.
      }
    }
    this.emit({
      type: "turn.completed",
      subtype,
      isError: !ok,
      totalCostUsd: this.costOf(this.spent) ?? 0,
      durationMs,
      numTurns: this.turns,
      usage: {
        inputTokens: this.total.inputTokens,
        outputTokens: this.total.outputTokens + this.total.reasoningOutputTokens,
        cacheReadTokens: this.total.cachedInputTokens,
        cacheCreationTokens: 0,
      },
    });
    if (!ok && error) this.emit({ type: "error", message: error });
    this.touch("idle");
    const w = this.waiter;
    this.waiter = null;
    w?.resolve({
      subtype: subtype === "interrupted" ? "error_during_execution" : subtype,
      isError: !ok,
      text: ok ? text : "",
      ...(structured !== undefined ? { structured } : {}),
      costUsd: this.costOf(used) ?? 0,
      ...(this.model ? { model: this.model } : {}),
      costKind: this.costKind,
      tokens: { input: used.inputTokens, output: used.outputTokens + used.reasoningOutputTokens },
    });
  }

  /** This turn's tokens so far. */
  private turnUsage(): CodexUsage {
    return this.turnBase ? minus(this.total, this.turnBase) : { ...NO_USAGE };
  }

  /** `usage` at the model's API price (M9-07), or null for a model with no price. */
  private costOf(usage: CodexUsage): number | null {
    return estimateUsd(this.model, {
      input: usage.inputTokens,
      cached: usage.cachedInputTokens,
      output: usage.outputTokens + usage.reasoningOutputTokens,
    });
  }

  private get costKind(): CostKind {
    return this.costOf(NO_USAGE) === null ? "unknown" : "estimate";
  }

  /** An approval request: the guard first, then the step's profile, then the person. */
  private onRequest(f: Frame) {
    const params = f.params ?? {};
    const rpcId = f.id as number | string;
    const itemId = String(params.itemId ?? "");
    const roots = this.options.additionalDirectories ?? [];
    if (f.method === "item/commandExecution/requestApproval") {
      const command = commandOf(params);
      const why = checkBash(command, this.options.cwd, homedir(), roots);
      if (why || this.options.readOnly) {
        if (why) this.guarded.set(itemId, why);
        return this.reply(rpcId, "decline");
      }
      return this.ask(rpcId, "Bash", { command }, itemId);
    }
    if (f.method === "item/fileChange/requestApproval") {
      const changes = changesOf(this.started.get(itemId) ?? {});
      for (const c of changes) {
        const why = checkToolCall(
          c.kind === "add" ? "Write" : "Edit",
          { file_path: c.path },
          this.options.cwd,
          homedir(),
          roots,
        );
        if (why) {
          this.guarded.set(itemId, why);
          return this.reply(rpcId, "decline");
        }
      }
      if (this.options.readOnly || !changes.length) return this.reply(rpcId, "decline");
      // Standard and Autonomous run edits inside the workspace without asking, as Claude steps do.
      const inside = changes.every((c) => this.within(c.path, roots));
      if (inside && autoEdits(this.options.permissionMode)) return this.reply(rpcId, "accept");
      const first = changes[0]?.path ?? "";
      return this.ask(
        rpcId,
        changes[0]?.kind === "add" ? "Write" : "Edit",
        { file_path: first, ...(changes.length > 1 ? { files: changes.map((c) => c.path) } : {}) },
        itemId,
      );
    }
    // An MCP server of the user's own config asks for input: declined, in the shape its answer takes.
    if (f.method === "mcpServer/elicitation/request") {
      return this.write({ id: rpcId, result: { action: "decline", content: null, _meta: null } } as Frame);
    }
    // Anything else (more permissions, user input, a dynamic tool, a token refresh) is refused: a step has no one to
    // ask, and an error is a valid answer to any request.
    this.write({ id: rpcId, error: { code: -32000, message: "A task step can't answer this request." } } as Frame);
  }

  private within(file: string, roots: string[]) {
    const target = path.resolve(this.options.cwd, file);
    return [this.options.cwd, ...roots].some((r) => {
      const rel = path.relative(path.resolve(r), target);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
  }

  private ask(rpcId: number | string, toolName: string, input: Record<string, unknown>, toolUseId: string) {
    const requestId = randomUUID();
    this.asks.set(requestId, { rpcId, toolName, input, toolUseId });
    this.callbacks.askPermission({ requestId, toolName, toolUseId, input, alwaysRules: [] });
    this.touch("waiting");
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(t("tasks.codex.exited")));
    }
    this.waiter?.reject(new Error(t("tasks.codex.exitedMidTurn")));
    this.waiter = null;
    this.touch("ended");
    this.callbacks.onEnd();
  }
}

const autoEdits = (mode: PermissionMode | undefined) => mode === "acceptEdits" || mode === "auto";
