import type { AgentEvent } from "@agentchainer/protocol";

/**
 * Transcript model for a session tab. Subagents (spike S4) are cards keyed by the `toolUseId` of the Agent tool call
 * that spawned them; their tool calls and text nest inside (ARCHITECTURE §5.2, agent tree).
 */

export type Status = "running" | "done" | "error";
/** `startedAt`/`durationMs` are only set for live calls; replayed history has no timing. */
export type ToolItem = {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  status: Status;
  output?: string;
  startedAt?: number;
  durationMs?: number;
};
export type AgentTextItem = { kind: "text"; id: number; text: string };
export type AgentItem = {
  kind: "agent";
  id: string;
  description: string;
  agentType?: string;
  status: Status;
  summary?: string;
  tokens?: number;
  durationMs?: number;
  children: (ToolItem | AgentTextItem)[];
};
export type ThinkingItem = { kind: "thinking"; id: number; text: string; open: boolean; at?: number };
/** `at` (epoch ms) is when a message arrived, for live sessions; replayed history has none (UX-04). */
export type Item =
  /** `messageId` is the SDK's uuid for the message: the anchor for rewinding files (M1-23). */
  | {
      kind: "user";
      id: number;
      text: string;
      messageId?: string;
      images?: string[];
      imageCount?: number;
      at?: number;
    }
  | { kind: "assistant"; id: number; text: string; open: boolean; at?: number }
  /** The main agent's visible thinking, collapsed by default (M1-10). */
  | ThinkingItem
  | { kind: "notice"; id: number; text: string; at?: number }
  | ToolItem
  | AgentItem;

/** Tool names the CLI uses for spawning a subagent. */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

let seq = 0;
export const nextId = () => ++seq;

/** Ends the streaming text or thinking block, so the next delta starts a new one. */
export function closeAssistant(items: Item[]): Item[] {
  const last = items.at(-1);
  return (last?.kind === "assistant" || last?.kind === "thinking") && last.open
    ? [...items.slice(0, -1), { ...last, open: false }]
    : items;
}

/** Applies one event. `now` (epoch ms) is passed for live events only, to time tool calls (M1-11). */
export function applyEvent(items: Item[], e: AgentEvent, now?: number): Item[] {
  switch (e.type) {
    case "text.delta":
    case "thinking.delta": {
      const kind = e.type === "text.delta" ? "assistant" : "thinking";
      const last = items.at(-1);
      if (last?.kind === kind && last.open) return [...items.slice(0, -1), { ...last, text: last.text + e.text }];
      return [
        ...closeAssistant(items),
        { kind, id: nextId(), text: e.text, open: true, ...(now !== undefined ? { at: now } : {}) },
      ];
    }

    case "user.message":
      return [
        ...closeAssistant(items),
        {
          kind: "user",
          id: nextId(),
          text: e.text,
          messageId: e.messageId,
          ...(e.imageCount ? { imageCount: e.imageCount } : {}),
          ...(now !== undefined ? { at: now } : {}),
        },
      ];

    case "tool.started": {
      const tool: ToolItem = {
        kind: "tool",
        id: e.toolUseId,
        name: e.name,
        input: e.input,
        status: "running",
        ...(now !== undefined ? { startedAt: now } : {}),
      };
      if (e.parentToolUseId !== null && hasAgent(items, e.parentToolUseId)) {
        return updateAgent(items, e.parentToolUseId, (a) => ({ ...a, children: [...a.children, tool] }));
      }
      if (SPAWN_TOOLS.has(e.name)) {
        const input = (e.input ?? {}) as Record<string, unknown>;
        const agent: AgentItem = {
          kind: "agent",
          id: e.toolUseId,
          description: typeof input.description === "string" ? input.description : "Subagent",
          status: "running",
          children: [],
          ...(typeof input.subagent_type === "string" ? { agentType: input.subagent_type } : {}),
        };
        return [...closeAssistant(items), agent];
      }
      return [...closeAssistant(items), tool];
    }

    case "tool.completed": {
      const status: Status = e.isError ? "error" : "done";
      const finish = (t: ToolItem): ToolItem => ({
        ...t,
        status,
        output: e.output,
        ...(now !== undefined && t.startedAt !== undefined ? { durationMs: now - t.startedAt } : {}),
      });
      if (e.parentToolUseId !== null && hasAgent(items, e.parentToolUseId)) {
        return updateAgent(items, e.parentToolUseId, (a) => ({
          ...a,
          children: a.children.map((c) => (c.kind === "tool" && c.id === e.toolUseId ? finish(c) : c)),
        }));
      }
      return items.map((it) => {
        if (it.kind === "tool" && it.id === e.toolUseId) return finish(it);
        // The Agent call's own result is the subagent's hand-back; agent.completed carries the summary.
        if (it.kind === "agent" && it.id === e.toolUseId && it.status === "running") return { ...it, status };
        return it;
      });
    }

    case "agent.started":
      if (!hasAgent(items, e.toolUseId)) {
        return [
          ...items,
          { kind: "agent", id: e.toolUseId, description: e.description, status: "running", children: [] },
        ];
      }
      return updateAgent(items, e.toolUseId, (a) => ({
        ...a,
        description: e.description || a.description,
        ...(e.agentType ? { agentType: e.agentType } : {}),
      }));

    case "agent.text":
      if (!hasAgent(items, e.parentToolUseId)) return items;
      return updateAgent(items, e.parentToolUseId, (a) => ({
        ...a,
        children: [...a.children, { kind: "text", id: nextId(), text: e.text }],
      }));

    case "agent.completed":
      return updateAgent(items, e.toolUseId, (a) => ({
        ...a,
        status: e.status === "completed" ? "done" : "error",
        summary: e.summary,
        ...(e.totalTokens !== undefined ? { tokens: e.totalTokens } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      }));

    case "turn.completed":
      return closeAssistant(items);

    case "error":
      return [
        ...closeAssistant(items),
        { kind: "notice", id: nextId(), text: e.message, ...(now !== undefined ? { at: now } : {}) },
      ];

    default:
      return items;
  }
}

/** Attaches the sidecar's message id to a user message the UI added before sending it. */
export function setMessageId(items: Item[], id: number, messageId: string): Item[] {
  return items.map((it) => (it.kind === "user" && it.id === id ? { ...it, messageId } : it));
}

function hasAgent(items: Item[], id: string): boolean {
  return items.some((it) => it.kind === "agent" && it.id === id);
}

function updateAgent(items: Item[], id: string, fn: (a: AgentItem) => AgentItem): Item[] {
  return items.map((it) => (it.kind === "agent" && it.id === id ? fn(it) : it));
}

/** Two or more tool calls in a row (with the thinking between them), shown as one collapsible row (UX-04). */
export type ToolGroup = { kind: "tools"; id: string; members: (ToolItem | ThinkingItem)[] };
export type Row = Item | ToolGroup;

/**
 * Groups runs of top-level tool calls. Closed thinking between two calls joins the run; thinking at its end stays
 * outside, next to the text it leads to. A single call stays a row of its own.
 */
export function groupItems(items: Item[]): Row[] {
  const rows: Row[] = [];
  let run: (ToolItem | ThinkingItem)[] = [];
  const flush = () => {
    const trailing: ThinkingItem[] = [];
    while (run.at(-1)?.kind === "thinking") trailing.unshift(run.pop() as ThinkingItem);
    const tools = run.filter((m) => m.kind === "tool");
    if (tools.length >= 2) rows.push({ kind: "tools", id: `tools-${tools[0]?.id}`, members: run });
    else rows.push(...run);
    rows.push(...trailing);
    run = [];
  };
  for (const it of items) {
    if (it.kind === "tool" || (it.kind === "thinking" && !it.open && run.length > 0)) run.push(it);
    else {
      flush();
      rows.push(it);
    }
  }
  flush();
  return rows;
}
