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
 * main chain, so a subagent shows as its Agent tool call.
 */
export function historyEvents(messages: SessionMessage[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const m of messages) {
    const blocks = blocksOf(m.message);
    if (blocks === null) continue;
    if (m.type === "user") {
      if (typeof blocks === "string") {
        if (!META_TEXT.test(blocks)) events.push({ type: "user.message", messageId: m.uuid, text: blocks });
        continue;
      }
      const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string" && !META_TEXT.test(b.text))
        .map((b) => b.text as string)
        .join("\n");
      if (text.trim()) events.push({ type: "user.message", messageId: m.uuid, text });
      for (const b of blocks) {
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        events.push({
          type: "tool.completed",
          toolUseId: b.tool_use_id,
          isError: b.is_error === true,
          output: summarize(b.content),
          parentToolUseId: m.parent_tool_use_id,
        });
      }
    } else if (m.type === "assistant" && typeof blocks !== "string") {
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim() && m.parent_tool_use_id === null) {
          events.push({ type: "text.delta", text: b.text });
        } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          events.push({
            type: "tool.started",
            toolUseId: b.id,
            name: b.name,
            input: b.input,
            parentToolUseId: m.parent_tool_use_id,
          });
        }
      }
    }
  }
  return events;
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
