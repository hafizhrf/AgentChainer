import type { AgentEvent } from "@agentchainer/protocol";

/**
 * Transcript model for a session tab. Subagents (spike S4) are cards keyed by the `toolUseId` of the Agent tool call
 * that spawned them; their tool calls, text and own subagents nest inside. That nesting is the agent tree (M4-01,
 * docs/design/observability.md §3): the chat cards and the graph read the same items.
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
/** `stopped` is a stop or kill; `paused` comes from the SDK's task state. */
export type AgentStatus = Status | "stopped" | "paused";
/**
 * One subagent run. `tokens`, `toolUses` and `durationMs` are running totals while it works (`agent.progress`) and
 * final at the end. `startedAt` is set for live sessions only; `endedAt` (epoch ms) is the SDK's end time.
 */
export type AgentItem = {
  kind: "agent";
  id: string;
  taskId?: string;
  runId?: string;
  description: string;
  agentType?: string;
  prompt?: string;
  depth?: number;
  background?: boolean;
  status: AgentStatus;
  summary?: string;
  /** The SDK's one-line progress note, when it sends one. */
  progress?: string;
  lastTool?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  pausedMs?: number;
  error?: string;
  children: AgentChild[];
};
export type AgentChild = ToolItem | AgentTextItem | AgentItem;
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
      let child: ToolItem | AgentItem = tool;
      if (SPAWN_TOOLS.has(e.name)) {
        const input = (e.input ?? {}) as Record<string, unknown>;
        child = {
          kind: "agent",
          id: e.toolUseId,
          description: typeof input.description === "string" ? input.description : "Subagent",
          status: "running",
          children: [],
          ...(typeof input.subagent_type === "string" ? { agentType: input.subagent_type } : {}),
          ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
          ...(now !== undefined ? { startedAt: now } : {}),
        };
      }
      if (e.parentToolUseId !== null && findAgent(items, byId(e.parentToolUseId))) {
        return mapAgent(items, byId(e.parentToolUseId), (a) => ({ ...a, children: [...a.children, child] }));
      }
      return [...closeAssistant(items), child];
    }

    case "tool.completed": {
      const status: Status = e.isError ? "error" : "done";
      const finish = (t: ToolItem): ToolItem => ({
        ...t,
        status,
        output: e.output,
        ...(now !== undefined && t.startedAt !== undefined ? { durationMs: now - t.startedAt } : {}),
      });
      const finishIn = <T extends Item | AgentChild>(list: T[]): T[] =>
        list.map((it) => {
          if (it.kind === "tool" && it.id === e.toolUseId) return finish(it) as T;
          // The Agent call's own result is the subagent's hand-back; agent.completed carries the summary.
          if (it.kind === "agent" && it.id === e.toolUseId && it.status === "running") return { ...it, status } as T;
          return it;
        });
      if (e.parentToolUseId !== null && findAgent(items, byId(e.parentToolUseId))) {
        return mapAgent(items, byId(e.parentToolUseId), (a) => ({ ...a, children: finishIn(a.children) }));
      }
      return finishIn(items);
    }

    case "agent.started": {
      const fields = {
        taskId: e.taskId,
        ...(e.runId ? { runId: e.runId } : {}),
        ...(e.agentType ? { agentType: e.agentType } : {}),
        ...(e.prompt ? { prompt: e.prompt } : {}),
        ...(e.depth !== undefined ? { depth: e.depth } : {}),
        ...(e.background !== undefined ? { background: e.background } : {}),
      };
      if (findAgent(items, byId(e.toolUseId))) {
        return mapAgent(items, byId(e.toolUseId), (a) => ({
          ...a,
          ...fields,
          description: e.description || a.description,
        }));
      }
      // No spawn call seen: the agent goes under its parent task when that's known, else at the top level.
      const agent: AgentItem = {
        kind: "agent",
        id: e.toolUseId,
        description: e.description,
        status: "running",
        children: [],
        ...fields,
        ...(now !== undefined ? { startedAt: now } : {}),
      };
      const parent = e.parentTaskId ? findAgent(items, (a) => a.taskId === e.parentTaskId) : undefined;
      if (parent) return mapAgent(items, byId(parent.id), (a) => ({ ...a, children: [...a.children, agent] }));
      return [...items, agent];
    }

    case "agent.progress":
      // A late progress frame never overwrites an agent's final totals.
      return mapAgent(
        items,
        (a) => a.id === e.toolUseId && (a.status === "running" || a.status === "paused"),
        (a) => ({
          ...a,
          tokens: e.totalTokens,
          toolUses: e.toolUses,
          durationMs: e.durationMs,
          ...(e.lastTool ? { lastTool: e.lastTool } : {}),
          ...(e.summary ? { progress: e.summary } : {}),
        }),
      );

    case "agent.updated": {
      const status = e.status ? TASK_STATUS[e.status] : undefined;
      return mapAgent(
        items,
        (a) => a.taskId === e.taskId,
        (a) => ({
          ...a,
          ...(status ? { status } : {}),
          ...(e.endTime !== undefined ? { endedAt: e.endTime } : {}),
          ...(e.pausedMs !== undefined ? { pausedMs: e.pausedMs } : {}),
          ...(e.error ? { error: e.error } : {}),
          ...(e.background !== undefined ? { background: e.background } : {}),
        }),
      );
    }

    case "agent.text":
      if (!findAgent(items, byId(e.parentToolUseId))) return items;
      return mapAgent(items, byId(e.parentToolUseId), (a) => ({
        ...a,
        children: [...a.children, { kind: "text", id: nextId(), text: e.text }],
      }));

    case "agent.completed":
      return mapAgent(items, byId(e.toolUseId), (a) => ({
        ...a,
        status: e.status === "completed" ? "done" : e.status === "stopped" ? "stopped" : "error",
        summary: e.summary,
        ...(e.totalTokens !== undefined ? { tokens: e.totalTokens } : {}),
        ...(e.toolUses !== undefined ? { toolUses: e.toolUses } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        ...(a.endedAt === undefined && now !== undefined ? { endedAt: now } : {}),
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

/** The SDK's task states (`task_updated`) as card states; pending changes nothing. */
const TASK_STATUS: Record<string, AgentStatus | undefined> = {
  running: "running",
  paused: "paused",
  completed: "done",
  failed: "error",
  killed: "stopped",
};

const byId = (id: string) => (a: AgentItem) => a.id === id;

/** The first agent, at any depth, that matches. */
export function findAgent(
  list: readonly (Item | AgentChild)[],
  match: (a: AgentItem) => boolean,
): AgentItem | undefined {
  for (const it of list) {
    if (it.kind !== "agent") continue;
    if (match(it)) return it;
    const found = findAgent(it.children, match);
    if (found) return found;
  }
  return undefined;
}

/** Applies `fn` to every agent that matches, at any depth. A list without a match keeps its identity (memo). */
function mapAgent<T extends Item | AgentChild>(
  list: T[],
  match: (a: AgentItem) => boolean,
  fn: (a: AgentItem) => AgentItem,
): T[] {
  let changed = false;
  const out = list.map((it) => {
    if (it.kind !== "agent") return it;
    if (match(it)) {
      changed = true;
      return fn(it) as T;
    }
    const children = mapAgent(it.children, match, fn);
    if (children === it.children) return it;
    changed = true;
    return { ...it, children } as T;
  });
  return changed ? out : list;
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
