import type { AgentEvent } from "@agentchainer/protocol";

/**
 * Transcript model for the spike UI. Subagents (spike S4) are cards keyed by the `toolUseId` of the Agent tool call
 * that spawned them; their tool calls and text nest inside (ARCHITECTURE §5.2, agent tree).
 */

export type Status = "running" | "done" | "error";
export type ToolItem = { kind: "tool"; id: string; name: string; input: unknown; status: Status; output?: string };
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
export type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; open: boolean }
  | { kind: "notice"; id: number; text: string }
  | ToolItem
  | AgentItem;

/** Tool names the CLI uses for spawning a subagent. */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

let seq = 0;
export const nextId = () => ++seq;

export function closeAssistant(items: Item[]): Item[] {
  const last = items.at(-1);
  return last?.kind === "assistant" && last.open ? [...items.slice(0, -1), { ...last, open: false }] : items;
}

export function applyEvent(items: Item[], e: AgentEvent): Item[] {
  switch (e.type) {
    case "text.delta": {
      const last = items.at(-1);
      if (last?.kind === "assistant" && last.open) return [...items.slice(0, -1), { ...last, text: last.text + e.text }];
      return [...items, { kind: "assistant", id: nextId(), text: e.text, open: true }];
    }

    case "tool.started": {
      const tool: ToolItem = { kind: "tool", id: e.toolUseId, name: e.name, input: e.input, status: "running" };
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
      if (e.parentToolUseId !== null && hasAgent(items, e.parentToolUseId)) {
        return updateAgent(items, e.parentToolUseId, (a) => ({
          ...a,
          children: a.children.map((c) => (c.kind === "tool" && c.id === e.toolUseId ? { ...c, status, output: e.output } : c)),
        }));
      }
      return items.map((it) => {
        if (it.kind === "tool" && it.id === e.toolUseId) return { ...it, status, output: e.output };
        // The Agent call's own result is the subagent's hand-back; agent.completed carries the summary.
        if (it.kind === "agent" && it.id === e.toolUseId && it.status === "running") return { ...it, status };
        return it;
      });
    }

    case "agent.started":
      if (!hasAgent(items, e.toolUseId)) {
        return [...items, { kind: "agent", id: e.toolUseId, description: e.description, status: "running", children: [] }];
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
      return [...closeAssistant(items), { kind: "notice", id: nextId(), text: e.message }];

    default:
      return items;
  }
}

function hasAgent(items: Item[], id: string): boolean {
  return items.some((it) => it.kind === "agent" && it.id === id);
}

function updateAgent(items: Item[], id: string, fn: (a: AgentItem) => AgentItem): Item[] {
  return items.map((it) => (it.kind === "agent" && it.id === id ? fn(it) : it));
}
