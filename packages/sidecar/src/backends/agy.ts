import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent, CostKind, FleetItem, TaskTag } from "@agentchainer/protocol";
import type { Cli } from "../deploy/cli.ts";
import { checkToolCall, GUARD_PREFIX, SECRET_DIRS } from "../guard.ts";
import { t } from "../i18n/index.ts";
import { log } from "../rpc.ts";
import type { SessionCallbacks, TurnResult } from "../session.ts";
import { type AgyEvent, type AgyUsage, eventsOf, parseLine, usageOfResult, writesOf } from "./agy-events.ts";
import { estimateUsd } from "./prices.ts";
import type { LiveSession, StepBackend, StepOptions } from "./types.ts";

/**
 * Task steps on the user's own Antigravity CLI (M9-05, ADR-0012 §3, spike S8): one headless `agy -p` per turn, the
 * conversation resumed by its id. The user's own binary and login; the app never signs in for them (ADR-0002).
 *
 * agy asks nothing, and its per-run command rules don't hold (S8), so an agy step **runs no commands**: `--sandbox`
 * and `toolPermission: request-review` refuse every one, and the project's gates are run by the app. Write steps edit
 * files (`--mode accept-edits`); read steps also deny every write. Its file rules do hold, so the guard's credential
 * folders are denied to it as well. Every path it wrote is checked against the guard and the workspace when the turn
 * is over: a breach fails the step and is recorded. Settings go in per run (`--settings`), never into the user's own
 * file. Usage comes as tokens (plan usage, like Codex: no dollars).
 */

export type AgyHost = {
  cli: Cli;
  /** `agy --version`, for the session's start line. */
  version: string;
  register(session: LiveSession): void;
  unregister(sessionId: string): void;
};

export function agyBackend(host: AgyHost): StepBackend {
  return (options, callbacks) => {
    const session: AgySession = new AgySession(host, options, {
      ...callbacks,
      onEnd: () => {
        host.unregister(session.id);
        callbacks.onEnd();
      },
    });
    host.register(session);
    return session;
  };
}

/** Model names that are the app's Claude aliases: agy takes its own default instead. Its `claude-…` models pass. */
const CLAUDE_ALIAS = /^(inherit|default|opus|sonnet|haiku|fable)$/i;

/** The settings one run gets: commands refused, the credential folders denied, and for a read step every write. */
export function runSettings(readOnly: boolean, home = homedir()): string {
  const secrets = SECRET_DIRS.map((d) => path.join(home, d).replaceAll("\\", "/"));
  const deny = [
    ...secrets.flatMap((p) => [`read_file(${p})`, `write_file(${p})`]),
    ...(readOnly ? ["write_file(*)"] : []),
  ];
  return JSON.stringify({ toolPermission: "request-review", permissions: { deny } });
}

/** The command line of one turn. */
export function turnArgs(options: StepOptions, prompt: string, conversation: string | null): string[] {
  const model = options.model && !CLAUDE_ALIAS.test(options.model) ? options.model : null;
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--sandbox",
    "--settings",
    runSettings(options.readOnly === true),
    ...(options.readOnly ? [] : ["--mode", "accept-edits"]),
    ...(model ? ["--model", model] : []),
    ...(conversation ? ["--conversation", conversation] : []),
    ...(options.outputFormat ? ["--json-schema", JSON.stringify(options.outputFormat.schema)] : []),
    ...(options.additionalDirectories ?? []).flatMap((d) => ["--add-dir", d]),
  ];
}

/** Said once, with the first prompt: agy has no system prompt flag, and a step's role and its rules go first. */
const NO_COMMANDS =
  "You can read and edit files but not run commands: commands are refused. Don't try to run tests, builds or git; " +
  "AgentChainer runs the project's checks after you and tells you what failed.";

class AgySession implements LiveSession {
  id: string;
  tag: TaskTag | undefined;
  parentId: string | undefined;
  private readonly host: AgyHost;
  private readonly options: StepOptions;
  private readonly callbacks: SessionCallbacks;
  private conversation: string | null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private turns = 0;
  private total: AgyUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0 };
  /** The model agy reported at its last turn's start. */
  model = "";
  private status: FleetItem["status"] = "idle";
  private readonly startedAt = new Date().toISOString();
  private since = this.startedAt;
  private ended = false;

  constructor(host: AgyHost, options: StepOptions, callbacks: SessionCallbacks) {
    this.host = host;
    this.options = options;
    this.callbacks = callbacks;
    this.conversation = options.resume ?? null;
    // agy names a conversation once its first turn starts: until then the session goes by an id of its own.
    this.id = options.resume ?? `agy-${randomUUID()}`;
  }

  turn(prompt: string): Promise<TurnResult> {
    if (this.ended) return Promise.reject(new Error(t("tasks.agy.ended")));
    const first = this.conversation === null;
    const text = first
      ? [this.options.appendSystemPrompt, NO_COMMANDS, prompt].filter(Boolean).join("\n\n---\n\n")
      : prompt;
    const child = spawn(
      this.host.cli.bin,
      [...this.host.cli.prefix, ...turnArgs(this.options, text, this.conversation)],
      {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    child.stdin.end();
    // A first turn reports its status once agy has named the conversation: the fleet would keep a row for the
    // temporary id otherwise.
    if (!first) this.touch("working");
    const seen: AgyEvent[] = [];
    createInterface({ input: child.stderr }).on("line", (line) => log(`agy: ${line}`));
    createInterface({ input: child.stdout }).on("line", (line) => {
      const e = parseLine(line);
      if (!e) return;
      seen.push(e);
      if (e.kind === "init" && e.conversationId) {
        this.named(e.conversationId);
        if (first) this.touch("working");
      }
      const init = e as { model?: unknown };
      if (e.kind === "init" && typeof init.model === "string") this.model = init.model;
      if (e.kind === "init" && first) {
        this.emit({
          type: "session.started",
          sessionId: this.id,
          model: typeof init.model === "string" ? init.model : "agy",
          cwd: this.options.cwd,
          claudeCodeVersion: this.host.version,
          permissionMode: this.options.readOnly ? "read-only" : "accept-edits",
        });
      }
      for (const event of eventsOf(e)) {
        // A file the guard rules out is reported when its step ends; see `finish`.
        if (event.type === "tool.completed" && this.breaches(seen).has(event.toolUseId)) continue;
        this.emit(event);
      }
    });
    return new Promise((resolve, reject) => {
      child.on("error", (err) => {
        this.child = null;
        this.touch("idle");
        reject(err);
      });
      child.on("close", (code) => {
        this.child = null;
        resolve(this.finish(seen, code));
      });
    });
  }

  /** The conversation's id, once agy has said it: the session goes by it from then on, so fix rounds resume it. */
  private named(conversation: string) {
    if (this.conversation === conversation) return;
    this.conversation = conversation;
    if (this.id !== conversation) {
      this.host.unregister(this.id);
      this.id = conversation;
      this.host.register(this);
    }
  }

  /** Paths written this turn that the guard rules out, or that leave the workspace, by tool step, with why. */
  private breaches(seen: readonly AgyEvent[]): Map<string, string> {
    const roots = this.options.additionalDirectories ?? [];
    const out = new Map<string, string>();
    for (const w of writesOf(seen)) {
      const why =
        checkToolCall("Write", { file_path: w.path }, this.options.cwd, homedir(), roots) ??
        (this.within(w.path, roots) ? null : t("tasks.agy.outsideWorkspace", { path: w.path }));
      if (why) out.set(w.toolUseId, why);
    }
    return out;
  }

  private within(file: string, roots: string[]) {
    const target = path.resolve(this.options.cwd, file);
    return [this.options.cwd, ...roots].some((r) => {
      const rel = path.relative(path.resolve(r), target);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
  }

  private finish(seen: readonly AgyEvent[], code: number | null): TurnResult {
    this.turns++;
    const result = seen.find((e) => e.kind === "result") as
      | (AgyEvent & { status?: string; response?: string })
      | undefined;
    const usage = usageOfResult(result);
    const before = this.costOf(this.total);
    this.total = {
      inputTokens: this.total.inputTokens + usage.inputTokens,
      outputTokens: this.total.outputTokens + usage.outputTokens,
      thinkingTokens: this.total.thinkingTokens + usage.thinkingTokens,
      cacheReadTokens: this.total.cacheReadTokens + usage.cacheReadTokens,
    };
    // A write the guard rules out fails the step, and its reason goes into the evidence as a guard block.
    const breaches = this.breaches(seen);
    for (const [toolUseId, why] of breaches) {
      this.emit({
        type: "tool.completed",
        toolUseId,
        isError: true,
        output: `${GUARD_PREFIX}${why}`,
        parentToolUseId: null,
      });
    }
    const ok = code === 0 && result?.status === "SUCCESS" && breaches.size === 0;
    const text = typeof result?.response === "string" ? result.response : "";
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
      subtype: ok ? "success" : "error_during_execution",
      isError: !ok,
      totalCostUsd: this.costOf(this.total) ?? 0,
      durationMs: Math.round(Number(result?.duration_seconds ?? 0) * 1000),
      numTurns: this.turns,
      usage: {
        inputTokens: this.total.inputTokens,
        outputTokens: this.total.outputTokens + this.total.thinkingTokens,
        cacheReadTokens: this.total.cacheReadTokens,
        cacheCreationTokens: 0,
      },
    });
    if (!ok && !breaches.size) this.emit({ type: "error", message: t("tasks.agy.turnFailed", { code: String(code) }) });
    this.touch("idle");
    return {
      subtype: ok ? "success" : "error_during_execution",
      isError: !ok,
      text: ok ? text : "",
      ...(structured !== undefined ? { structured } : {}),
      costUsd: Math.max(0, (this.costOf(this.total) ?? 0) - (before ?? 0)),
      ...(this.model ? { model: this.model } : {}),
      costKind: this.costKind,
      tokens: { input: usage.inputTokens, output: usage.outputTokens + usage.thinkingTokens },
    };
  }

  /**
   * `usage` at the model's API price (M9-07), or null for a model with no price. agy's input count includes its cache
   * reads, as Gemini's API counts them (verify).
   */
  private costOf(usage: AgyUsage): number | null {
    return estimateUsd(this.model, {
      input: usage.inputTokens,
      cached: usage.cacheReadTokens,
      output: usage.outputTokens + usage.thinkingTokens,
    });
  }

  private get costKind(): CostKind {
    return estimateUsd(this.model, { input: 0, cached: 0, output: 0 }) === null ? "unknown" : "estimate";
  }

  /** A headless run takes no messages mid-turn. */
  inject(): boolean {
    return false;
  }

  async interrupt(): Promise<boolean> {
    if (!this.child) return false;
    this.child.kill();
    return true;
  }

  /** agy asks nothing: a step on it never waits for an approval. */
  respond(): boolean {
    return false;
  }

  get fleetItem(): FleetItem {
    return {
      sessionId: this.id,
      cwd: this.options.cwd,
      status: this.status,
      waiting: 0,
      costUsd: this.costOf(this.total) ?? 0,
      agent: "agy",
      ...(this.model ? { model: this.model } : {}),
      costKind: this.costKind,
      startedAt: this.startedAt,
      since: this.since,
      ...(this.tag ? { task: this.tag } : {}),
      ...(this.parentId ? { parentId: this.parentId } : {}),
    };
  }

  close(): Promise<void> {
    const child = this.child;
    const done = new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("close", () => resolve());
      child.kill();
    });
    return done.then(() => this.end());
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    this.touch("ended");
    this.callbacks.onEnd();
  }

  private emit(event: AgentEvent) {
    this.callbacks.emit(event);
  }

  private touch(status: FleetItem["status"]) {
    if (this.status === status) return;
    this.status = status;
    this.since = new Date().toISOString();
    this.callbacks.statusChanged?.(this.fleetItem);
  }
}
