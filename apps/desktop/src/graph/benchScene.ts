import type { AgentItem, Item, ToolItem } from "../transcript.ts";

/** Percentiles and the share of slow frames, from the intervals between animation frames. */
export type FrameStats = {
  frames: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Frames that took longer than 1.5 × the display's own interval (its median): dropped frames. */
  slowPct: number;
  fps: number;
};

const edit = (id: string, file: string): ToolItem => ({
  kind: "tool",
  id,
  name: "Edit",
  input: { file_path: file, old_string: "a", new_string: "b" },
  status: "done",
  output: "",
});

/**
 * The synthetic session of exit criterion M4-E2: 200 graph nodes, the most the graph shows before it folds. The main
 * agent with 3 edits, 9 subagents with 10 nested subagents each (99 agents), and 3 edits under every agent. Edits are
 * key calls, so every agent has a tools card (UX-18): 1 + 1 + 99 + 99 = 200.
 */
export function benchItems(): Item[] {
  const agent = (id: string, children: AgentItem["children"]): AgentItem => ({
    kind: "agent",
    id,
    taskId: `task-${id}`,
    description: `Bench agent ${id}`,
    agentType: "general-purpose",
    status: "done",
    tokens: 12_345,
    toolUses: 3,
    children: [...[1, 2, 3].map((n) => edit(`${id}-edit-${n}`, `src/${id}/file-${n}.ts`)), ...children],
  });
  const tops = Array.from({ length: 9 }, (_, i) =>
    agent(
      `a${i}`,
      Array.from({ length: 10 }, (_, j) => agent(`a${i}-${j}`, [])),
    ),
  );
  return [
    { kind: "user", id: 1, text: "Synthetic 200-node scene (M4-E2)" },
    ...[1, 2, 3].map((n) => edit(`main-edit-${n}`, `src/main-${n}.ts`)),
    ...tops,
  ];
}

/** Frame statistics from `requestAnimationFrame` timestamps. */
export function frameStats(times: readonly number[]): FrameStats {
  const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (v: number) => Math.round(v * 10) / 10;
  const median = at(0.5);
  const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
  return {
    frames: gaps.length,
    p50Ms: round(median),
    p95Ms: round(at(0.95)),
    p99Ms: round(at(0.99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    slowPct: round((100 * gaps.filter((g) => g > median * 1.5).length) / (gaps.length || 1)),
    fps: round(span > 0 ? (1000 * gaps.length) / span : 0),
  };
}
