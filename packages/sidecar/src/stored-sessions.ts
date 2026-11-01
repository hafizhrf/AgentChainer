import type { AgentEvent, SessionInfo } from "@agentchainer/protocol";
// Types only: the SDK itself is loaded at runtime by sdk-loader.ts.
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
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
    title: s.customTitle || s.summary || s.firstPrompt || "Untitled session",
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
const META_TEXT = /^\s*<([a-z][a-z-]*)>[\s\S]*<\/\1>\s*$/;

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
      if (agent === null && !META_TEXT.test(blocks)) {
        events.push({ type: "user.message", messageId: m.uuid, text: blocks });
      }
      return events;
    }
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string" && !META_TEXT.test(b.text))
      .map((b) => b.text as string)
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
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        if (agent !== null) events.push({ type: "agent.text", parentToolUseId: agent, text: b.text });
        else if (m.parent_tool_use_id === null) events.push({ type: "text.delta", text: b.text });
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        events.push({
          type: "tool.started",
          toolUseId: b.id,
          name: b.name,
          input: b.input,
          parentToolUseId: agent ?? m.parent_tool_use_id,
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
      times.push(result?.at ?? timeOf(t.messages[t.messages.length - 1] as SessionMessage));
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
