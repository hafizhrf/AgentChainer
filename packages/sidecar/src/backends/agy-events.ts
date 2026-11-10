import type { AgentEvent } from "@agentchainer/protocol";

/**
 * The Antigravity CLI's headless stream as the app's events (M9-05, spike S8). One JSON object per line, keyed by its
 * event: `{"event":"step_update","step_update":{…}}`. Tool steps arrive twice, `ACTIVE` then `DONE` or `ERROR`, keyed
 * by their step index. agy's tools are named as Claude's would be, so the evidence and the graph read them the same.
 * Pure, so it's tested on recorded shapes.
 */

export type AgyEvent = { kind: string; conversationId?: string } & Record<string, unknown>;

/** A line of the stream, unwrapped; null for anything that isn't one. */
export function parseLine(line: string): AgyEvent | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const kind = String(raw.event ?? "");
    if (!kind) return null;
    const body = (raw[kind] ?? {}) as Record<string, unknown>;
    const conversationId = String(body.conversation_id ?? raw.conversation_id ?? "") || undefined;
    return { ...body, kind, ...(conversationId ? { conversationId } : {}) };
  } catch {
    return null;
  }
}

type ToolInfo = { name?: string; parameters?: Record<string, unknown>; error?: { message?: string } | null };

/** agy's file-writing tools: their paths are checked against the guard once the turn is over. */
const WRITERS = /^(write_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$/;

/** The path a tool works on: agy's parameters name it `Path`, `TargetFile`, `AbsolutePath`… */
function pathOf(params: Record<string, unknown>): string {
  for (const [k, v] of Object.entries(params)) if (typeof v === "string" && /path|file/i.test(k)) return v;
  return "";
}

/** A tool step as Claude's tool of the same kind, with the input the approval rules and the evidence read. */
export function asTool(info: ToolInfo): { name: string; input: Record<string, unknown>; writes: string | null } {
  const name = info.name ?? "";
  const params = info.parameters ?? {};
  if (name === "run_command")
    return { name: "Bash", input: { command: String(params.CommandLine ?? "") }, writes: null };
  if (WRITERS.test(name)) {
    const file = pathOf(params);
    if (name === "notebook_edit") return { name: "NotebookEdit", input: { notebook_path: file }, writes: file };
    return { name: /^write/.test(name) ? "Write" : "Edit", input: { file_path: file }, writes: file };
  }
  if (name === "view_file") return { name: "Read", input: { file_path: pathOf(params) }, writes: null };
  if (name === "grep_search")
    return { name: "Grep", input: { pattern: String(params.Query ?? params.Pattern ?? "") }, writes: null };
  if (name === "list_dir" || name === "find_by_name")
    return { name: "Glob", input: { path: pathOf(params) }, writes: null };
  if (name === "search_web")
    return { name: "WebSearch", input: { query: String(params.query ?? params.Query ?? "") }, writes: null };
  return { name, input: params, writes: null };
}

/** The app's events for one agy event: tool starts and ends, streamed text. */
export function eventsOf(e: AgyEvent): AgentEvent[] {
  if (e.kind !== "step_update") return [];
  if (e.step_type === "agent_response" && typeof e.text_delta === "string" && e.text_delta) {
    return [{ type: "text.delta", text: e.text_delta }];
  }
  if (e.step_type !== "tool") return [];
  const id = `agy-${String(e.step_index ?? "")}`;
  const info = (e.tool_info ?? { name: e.tool_name }) as ToolInfo;
  const tool = asTool(info);
  if (e.state === "ACTIVE") {
    return [{ type: "tool.started", toolUseId: id, name: tool.name, input: tool.input, parentToolUseId: null }];
  }
  const failed = e.state === "ERROR" || Boolean(info.error);
  return [
    {
      type: "tool.completed",
      toolUseId: id,
      isError: failed,
      output: failed ? (info.error?.message ?? "Failed.") : "",
      parentToolUseId: null,
    },
  ];
}

/** The files a finished turn wrote, by tool step: what the guard checks afterwards. */
export function writesOf(events: readonly AgyEvent[]): { toolUseId: string; path: string }[] {
  return events.flatMap((e) => {
    if (e.kind !== "step_update" || e.step_type !== "tool" || e.state !== "DONE") return [];
    const tool = asTool((e.tool_info ?? { name: e.tool_name }) as ToolInfo);
    return tool.writes ? [{ toolUseId: `agy-${String(e.step_index ?? "")}`, path: tool.writes }] : [];
  });
}

/** agy's token counts for the turn, from its `result`. */
export type AgyUsage = { inputTokens: number; outputTokens: number; thinkingTokens: number; cacheReadTokens: number };

export function usageOfResult(result: AgyEvent | undefined): AgyUsage {
  const u = (result?.usage ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    thinkingTokens: n("thinking_tokens"),
    cacheReadTokens: n("cache_read_tokens"),
  };
}
