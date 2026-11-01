import type { Wait } from "../tabs.ts";
import { type AgentItem, type AgentStatus, agentDuration, type Item, type ToolItem } from "../transcript.ts";
import { MAIN_ID } from "./agentGraph.ts";

/** A span on the time axis, in epoch ms. */
export type Span = { start: number; end: number };

export type TimelineRow = {
  id: string;
  depth: number;
  label: string;
  agentType?: string;
  /** `null` for the main agent, which has no task state of its own. */
  status: AgentStatus | null;
  bar: Span;
  /** Approval waits of this agent's own tool calls. */
  waits: Span[];
  pausedMs?: number;
  /** Still running: the bar's right edge follows the clock. */
  live: boolean;
};

export type Timeline = Span & { rows: TimelineRow[] };

/**
 * The timeline of a session (M4-04, design §6): one row per agent, ordered by start and indented by depth, on one
 * axis. A bar runs from the agent's start to its end, or to `now` while it runs; approval waits are drawn over it. The
 * SDK reports only a total paused time, not when, so that is a number on the row, not a span. `null` when nothing
 * carries a time: a reopened session's stored messages have no timestamps. Pass one turn (`turns`) at a time.
 */
export function timeline(
  items: Item[],
  waits: readonly Wait[],
  { now }: { now?: number | undefined },
): Timeline | null {
  const rows: TimelineRow[] = [];
  const ownWaits = (tools: ToolItem[], end: number): Span[] => {
    const ids = new Set(tools.map((t) => t.id));
    return waits.filter((w) => ids.has(w.toolUseId)).map((w) => ({ start: w.start, end: w.end ?? end }));
  };

  const walk = (agents: AgentItem[], depth: number) => {
    for (const a of [...agents].sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))) {
      if (a.startedAt === undefined) continue;
      const live = a.status === "running" || a.status === "paused";
      const duration = agentDuration(a);
      const end =
        live && now !== undefined ? now : (a.endedAt ?? (duration !== undefined ? a.startedAt + duration : now));
      const tools = a.children.filter((c): c is ToolItem => c.kind === "tool");
      rows.push({
        id: a.id,
        depth,
        label: a.description,
        ...(a.agentType ? { agentType: a.agentType } : {}),
        status: a.status,
        bar: { start: a.startedAt, end: Math.max(a.startedAt, end ?? a.startedAt) },
        waits: ownWaits(tools, end ?? a.startedAt),
        ...(a.pausedMs ? { pausedMs: a.pausedMs } : {}),
        live: live && now !== undefined,
      });
      walk(
        a.children.filter((c): c is AgentItem => c.kind === "agent"),
        depth + 1,
      );
    }
  };
  walk(
    items.filter((i): i is AgentItem => i.kind === "agent"),
    1,
  );

  // The main agent spans the session's timed items: messages, its own tool calls and every agent.
  const starts: number[] = rows.map((r) => r.bar.start);
  const ends: number[] = rows.map((r) => r.bar.end);
  const tools: ToolItem[] = [];
  for (const i of items) {
    if (i.kind === "tool") {
      tools.push(i);
      if (i.startedAt !== undefined) {
        starts.push(i.startedAt);
        ends.push(i.startedAt + (i.durationMs ?? 0));
      }
    } else if ((i.kind === "user" || i.kind === "assistant" || i.kind === "notice") && i.at !== undefined) {
      starts.push(i.at);
      ends.push(i.at);
    }
  }
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(now ?? 0, ...ends, start + 1);
  rows.unshift({
    id: MAIN_ID,
    depth: 0,
    label: "Main agent",
    status: null,
    bar: { start, end },
    waits: ownWaits(tools, end),
    live: now !== undefined,
  });
  return { start, end, rows };
}

/**
 * The session split into turns, each from a user message up to the next one. The timeline draws one turn at a time:
 * the gaps between turns are the user's own time and would squeeze the bars of each turn to slivers.
 */
export function turns(items: Item[]): Item[][] {
  const out: Item[][] = [];
  for (const i of items) {
    const last = out[out.length - 1];
    // Notices before the first message ("Session started") belong to the first turn.
    if (!last || (i.kind === "user" && last.some((x) => x.kind === "user"))) out.push([i]);
    else last.push(i);
  }
  return out;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

/** Axis ticks every 1, 2, 5, 10 s … 1 h: at most `max` of them, offsets from the start in ms. */
export function ticks(span: number, max = 8): number[] {
  const step = STEPS.find((s) => span / s <= max) ?? Math.ceil(span / max / 3_600_000) * 3_600_000;
  const out: number[] = [];
  for (let t = 0; t <= span; t += step) out.push(t);
  return out;
}

/** `0 s`, `2.5 s`, `45 s`, `2:05`, `1:02:05` */
export function clock(ms: number): string {
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(1))} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
