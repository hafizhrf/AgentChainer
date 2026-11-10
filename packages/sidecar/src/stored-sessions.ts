import type { AgentEvent, SessionInfo } from "@agentchainer/protocol";
// Types only: the SDK itself is loaded at runtime by sdk-loader.ts.
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { t } from "./i18n/index.ts";
import { summarize } from "./normalize.ts";
import type { AgentSdkModule } from "./sdk-loader.ts";

/**
 * Stored sessions through the SDK's session APIs only (ADR-0004): the transcript files are an internal format of the
 * CLI, so we never parse them ourselves.
 */

/** Claude Code's default for `cleanupPeriodDays`, per the settings docs (code.claude.com/docs/en/settings). */
export const DEFAULT_RETENTION_DAYS = 30;

export function toSessionInfo(s: SDKSessionInfo): SessionInfo {
  return {
    sessionId: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || t("rpc.session.untitled"),
    lastModified: s.lastModified,
    ...(s.createdAt !== undefined ? { createdAt: s.createdAt } : {}),
    ...(s.gitBranch ? { gitBranch: s.gitBranch } : {}),
    ...(s.tag ? { tag: s.tag } : {}),
  };
}

/**
 * Text the CLI stores as a user message but that the user didn't type: slash-command wrappers, command output and
 * reminders, e.g. `<command-name>/clear</command-name>`.
 */
const META_TEXT = /^\s*(?:<([a-z][a-z-]*)>[\s\S]*?<\/\1>\s*)+$/;

/**
 * A slash command the person typed, as the CLI stores it (M1-37): `<command-name>/compact</command-name>`,
 * `<command-message>…</command-message>`, `<command-args>…</command-args>`. Replayed as what was typed, `/compact` and
 * its arguments, rather than hidden or shown as tags. Null for any other text.
 */
export function typedCommand(text: string): string | null {
  if (!META_TEXT.test(text)) return null;
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return null;
  const args = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/.exec(text)?.[1] ?? "";
  const command = name.startsWith("/") ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

/** A stored user text as the person typed it: a slash command as itself, the CLI's other wrappers not at all. */
function typedText(text: string): string | null {
  return typedCommand(text) ?? (META_TEXT.test(text) ? null : text);
}

type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown } & Record<
  string,
  unknown
>;

function blocksOf(message: unknown): Block[] | string | null {
  if (!message || typeof message !== "object" || !("content" in message)) return null;
  const content = (message as { content: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : null;
}

/**
 * Turns a stored conversation into the same events a live session emits, so the UI renders both the same way.
 * Assistant text arrives as one `text.delta` per block. Thinking is skipped. Subagent transcripts aren't part of the
 * main chain, so here a subagent shows as its Agent tool call; `replayEvents` adds what it did.
 */
export function historyEvents(messages: SessionMessage[]): AgentEvent[] {
  return messages.flatMap((m) => messageEvents(m, null));
}

/**
 * The events of one stored message. `agent` is the Agent tool call whose subagent wrote it, or `null` for the main
 * chain. A subagent's own prompt is skipped: its spawn call already carries it.
 */
function messageEvents(m: SessionMessage, agent: string | null): AgentEvent[] {
  const events: AgentEvent[] = [];
  const blocks = blocksOf(m.message);
  if (blocks === null) return events;
  if (m.type === "user") {
    if (typeof blocks === "string") {
      const typed = typedText(blocks);
      if (agent === null && typed !== null) {
        events.push({ type: "user.message", messageId: m.uuid, text: typed });
      }
      return events;
    }
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => typedText(b.text as string))
      .filter((s): s is string => s !== null)
      .join("\n");
    const imageCount = blocks.filter((b) => b.type === "image").length;
    if (agent === null && (text.trim() || imageCount)) {
      events.push({ type: "user.message", messageId: m.uuid, text, ...(imageCount ? { imageCount } : {}) });
    }
    for (const b of blocks) {
      if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      events.push({
        type: "tool.completed",
        toolUseId: b.tool_use_id,
        isError: b.is_error === true,
        output: summarize(b.content),
        parentToolUseId: agent ?? m.parent_tool_use_id,
      });
    }
  } else if (m.type === "assistant" && typeof blocks !== "string") {
    // A subagent's messages say which model it ran, as they do live (UX-18).
    const said = (m.message as { model?: unknown } | null)?.model;
    const model = agent !== null && typeof said === "string" && said ? { model: said } : {};
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (agent !== null) events.push({ type: "agent.text", parentToolUseId: agent, text: b.text, ...model });
        else if (m.parent_tool_use_id === null) events.push({ type: "text.delta", text: b.text });
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        events.push({
          type: "tool.started",
          toolUseId: b.id,
          name: b.name,
          input: b.input,
          parentToolUseId: agent ?? m.parent_tool_use_id,
          ...model,
        });
      }
    }
  }
  return events;
}

/** The result the CLI stores for a tool call that a stop or interrupt cut short. */
const INTERRUPTED = /^\[Request interrupted by user/;

/** The tools that spawn a subagent, as in the UI's transcript. */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

/**
 * When the CLI stored a message, in epoch ms. The SDK returns each message's `timestamp` although its types don't
 * declare it **(verify on SDK updates)**, so it is read defensively; `null` when it is missing or unreadable.
 */
function timeOf(m: SessionMessage): number | null {
  const t = (m as { timestamp?: unknown }).timestamp;
  const ms = typeof t === "string" ? Date.parse(t) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A stored session as live events, subagents included (M4-08, design §9), with the time of each event (`null` when
 * unknown) so the UI's reducer can rebuild timing too. Each subagent transcript (`getSubagentMessages`) is placed
 * under the Agent call that spawned it: its messages carry that call's id in `parent_tool_use_id`. A transcript whose
 * spawn call isn't in the session, such as the CLI's own side agents, is left out. A parent's events come before its
 * children's, so the reducer always finds the parent.
 */
export function replayEvents(
  main: SessionMessage[],
  subagents: ReadonlyMap<string, SessionMessage[]>,
): { events: AgentEvent[]; times: (number | null)[] } {
  const events: AgentEvent[] = [];
  const times: (number | null)[] = [];
  const spawns = new Set<string>();
  /** The spawn calls' results: when each subagent handed back, and whether it failed. */
  const results = new Map<string, { at: number | null; status: "completed" | "failed" | "stopped" }>();
  const add = (m: SessionMessage, agent: string | null) => {
    const at = timeOf(m);
    for (const e of messageEvents(m, agent)) {
      if (e.type === "tool.started" && SPAWN_TOOLS.has(e.name)) spawns.add(e.toolUseId);
      if (e.type === "tool.completed") {
        const status = !e.isError ? "completed" : INTERRUPTED.test(e.output) ? "stopped" : "failed";
        results.set(e.toolUseId, { at, status });
      }
      events.push(e);
      times.push(at);
    }
  };
  for (const m of main) add(m, null);

  let pending = [...subagents].flatMap(([agentId, messages]) => {
    const spawn = messages.find((m) => m.parent_tool_use_id)?.parent_tool_use_id;
    return spawn ? [{ agentId, spawn, messages }] : [];
  });
  while (pending.length) {
    const ready = pending.filter((t) => spawns.has(t.spawn));
    if (!ready.length) break;
    pending = pending.filter((t) => !ready.includes(t));
    for (const t of ready) {
      for (const m of t.messages) add(m, t.spawn);
      const result = results.get(t.spawn);
      const last = [...events].reverse().find((e) => e.type === "agent.text" && e.parentToolUseId === t.spawn);
      events.push({
        type: "agent.completed",
        toolUseId: t.spawn,
        taskId: t.agentId,
        // No result stored: the session ended while the subagent ran.
        status: result?.status ?? "stopped",
        summary: last?.type === "agent.text" ? last.text : "",
      });
      // It ended when its call returned, or with its last message if later: a background subagent's call returns at
      // once (M4-07).
      const ends = [result?.at, ...t.messages.map(timeOf)].filter((v): v is number => typeof v === "number");
      times.push(ends.length ? Math.max(...ends) : null);
    }
  }
  return { events, times };
}

/**
 * Reads only `cleanupPeriodDays` from the user's effective Claude Code settings, through the SDK. The settings can hold
 * other sensitive values (e.g. `env`), which never leave this function (ADR-0002).
 */
export async function retention(sdk: AgentSdkModule, cwd: string): Promise<{ days: number; source: string }> {
  try {
    const resolved = await sdk.resolveSettings({ cwd });
    const days = resolved.effective.cleanupPeriodDays;
    if (typeof days === "number") {
      return { days, source: resolved.provenance.cleanupPeriodDays?.source ?? "settings" };
    }
  } catch {
    // resolveSettings is an alpha API; fall back to the documented default.
  }
  return { days: DEFAULT_RETENTION_DAYS, source: "default" };
}
