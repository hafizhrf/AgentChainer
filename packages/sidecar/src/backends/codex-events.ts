import type { AgentEvent } from "@agentchainer/protocol";

/**
 * Codex's app-server items as the app's events (M9-04, spike S8), so a Codex step shows in the thread, the evidence
 * and the graph like a Claude one. Commands become `Bash` and file changes `Write` or `Edit`: the tool names the
 * approval rules, the guard and the evidence already know. Pure, so it's tested on recorded frames.
 */

export type CodexItem = { type: string; id: string } & Record<string, unknown>;
type Change = { path: string; kind: { type: string } };

/**
 * The command Codex runs, without the shell it wraps it in: on Windows `"…powershell.exe" -Command '…'`, with the
 * command itself in `commandActions` (S8). The guard and the approval dialog check this one.
 */
export function commandOf(item: Record<string, unknown>): string {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const inner = actions
    .map((a) => (a && typeof a === "object" ? (a as { command?: unknown }).command : undefined))
    .filter((c): c is string => typeof c === "string" && c.length > 0);
  if (inner.length) return inner.join(" && ");
  const whole = typeof item.command === "string" ? item.command : "";
  const wrapped =
    /^"?[^"]*(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?"?\s+(?:-Command|-c|\/c)\s+(['"])([\s\S]*)\1\s*$/i.exec(whole);
  return wrapped?.[2] ?? whole;
}

/** The files a file-change item touches, with what happens to each: the started item has them before the approval. */
export function changesOf(item: Record<string, unknown>): { path: string; kind: string }[] {
  const changes = Array.isArray(item.changes) ? (item.changes as Change[]) : [];
  return changes
    .filter((c) => c && typeof c.path === "string")
    .map((c) => ({ path: c.path, kind: typeof c.kind?.type === "string" ? c.kind.type : "update" }));
}

/** A change's tool, as Claude would have named it: a new file is a `Write`, anything else an `Edit`. */
const toolFor = (kind: string) => (kind === "add" ? "Write" : "Edit");
/** One tool call per changed file, so each has its own row, approval target and evidence line. */
const changeId = (item: CodexItem, i: number, all: number) => (all > 1 ? `${item.id}:${i}` : item.id);

export function itemStarted(item: CodexItem): AgentEvent[] {
  if (item.type === "commandExecution") {
    return [
      {
        type: "tool.started",
        toolUseId: item.id,
        name: "Bash",
        input: { command: commandOf(item) },
        parentToolUseId: null,
      },
    ];
  }
  if (item.type === "fileChange") {
    const changes = changesOf(item);
    return changes.map((c, i) => ({
      type: "tool.started",
      toolUseId: changeId(item, i, changes.length),
      name: toolFor(c.kind),
      input: { file_path: c.path },
      parentToolUseId: null,
    }));
  }
  if (item.type === "webSearch") {
    const query = typeof item.query === "string" ? item.query : "";
    return [{ type: "tool.started", toolUseId: item.id, name: "WebSearch", input: { query }, parentToolUseId: null }];
  }
  return [];
}

/** How an item ended: declined and failed ones are errors, with a word on why when Codex gives none. */
export function itemCompleted(item: CodexItem): AgentEvent[] {
  const status = typeof item.status === "string" ? item.status : "completed";
  if (item.type === "commandExecution") {
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    const isError = status !== "completed" || (exitCode !== null && exitCode !== 0);
    return [
      {
        type: "tool.completed",
        toolUseId: item.id,
        isError,
        output: output || (status === "declined" ? "Declined." : exitCode !== null ? `exit ${exitCode}` : ""),
        parentToolUseId: null,
      },
    ];
  }
  if (item.type === "fileChange") {
    const changes = changesOf(item);
    return changes.map((c, i) => ({
      type: "tool.completed",
      toolUseId: changeId(item, i, changes.length),
      isError: status !== "completed",
      output: status === "completed" ? `${c.kind}: ${c.path}` : status === "declined" ? "Declined." : status,
      parentToolUseId: null,
    }));
  }
  if (item.type === "webSearch") {
    return [
      {
        type: "tool.completed",
        toolUseId: item.id,
        isError: status !== "completed",
        output: "",
        parentToolUseId: null,
      },
    ];
  }
  return [];
}

/** The final answer of a turn: its last `agentMessage`. */
export function finalText(items: readonly Record<string, unknown>[]): string {
  const messages = items.filter((i) => i.type === "agentMessage" && typeof i.text === "string");
  return String(messages.at(-1)?.text ?? "");
}

/** Codex's token counts (`thread/tokenUsage/updated`), as the app's usage. */
export type CodexUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export function usageOf(params: Record<string, unknown>): { total: CodexUsage; last: CodexUsage } | null {
  const u = (params.tokenUsage ?? null) as { total?: CodexUsage; last?: CodexUsage } | null;
  if (!u?.total || !u.last) return null;
  const pick = (x: CodexUsage) => ({
    inputTokens: Number(x.inputTokens) || 0,
    cachedInputTokens: Number(x.cachedInputTokens) || 0,
    outputTokens: Number(x.outputTokens) || 0,
    reasoningOutputTokens: Number(x.reasoningOutputTokens) || 0,
  });
  return { total: pick(u.total), last: pick(u.last) };
}
