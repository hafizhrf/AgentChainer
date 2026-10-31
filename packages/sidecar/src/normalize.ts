import type { AgentEvent } from "@agentchainer/protocol";
import type { ModelUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Maps one raw SDK message to zero or more normalized events (ARCHITECTURE §5.2).
 * Pure, so recorded streams can be replayed in tests (test/fixtures/*.jsonl).
 */
export function normalize(m: SDKMessage): AgentEvent[] {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        return [
          {
            type: "session.started",
            sessionId: m.session_id,
            model: m.model,
            cwd: m.cwd,
            claudeCodeVersion: m.claude_code_version,
            permissionMode: m.permissionMode,
            slashCommands: m.slash_commands,
          },
        ];
      }
      // Subagents (spike S4): the Agent tool call's id ties task messages, subagent messages and tool calls together.
      if (m.subtype === "task_started" && m.tool_use_id) {
        return [
          {
            type: "agent.started",
            toolUseId: m.tool_use_id,
            taskId: m.task_id,
            description: m.description,
            ...(m.subagent_type ? { agentType: m.subagent_type } : {}),
            ...(m.spawn_depth !== undefined ? { depth: m.spawn_depth } : {}),
            ...(m.is_backgrounded !== undefined ? { background: m.is_backgrounded } : {}),
            ...(m.parent_task_id ? { parentTaskId: m.parent_task_id } : {}),
            ...(m.run_id ? { runId: m.run_id } : {}),
            ...(m.prompt ? { prompt: m.prompt } : {}),
          },
        ];
      }
      if (m.subtype === "task_progress" && m.tool_use_id) {
        return [
          {
            type: "agent.progress",
            toolUseId: m.tool_use_id,
            taskId: m.task_id,
            ...(m.run_id ? { runId: m.run_id } : {}),
            totalTokens: m.usage.total_tokens,
            toolUses: m.usage.tool_uses,
            durationMs: m.usage.duration_ms,
            ...(m.last_tool_name ? { lastTool: m.last_tool_name } : {}),
            ...(m.summary ? { summary: m.summary } : {}),
          },
        ];
      }
      // task_updated names the task only; the UI ignores task ids it has no agent for (shells, monitors).
      if (m.subtype === "task_updated") {
        const p = m.patch;
        return [
          {
            type: "agent.updated",
            taskId: m.task_id,
            ...(m.run_id ? { runId: m.run_id } : {}),
            ...(p.status ? { status: p.status } : {}),
            ...(p.end_time !== undefined ? { endTime: p.end_time } : {}),
            ...(p.total_paused_ms !== undefined ? { pausedMs: p.total_paused_ms } : {}),
            ...(p.error ? { error: p.error } : {}),
            ...(p.is_backgrounded !== undefined ? { background: p.is_backgrounded } : {}),
          },
        ];
      }
      if (m.subtype === "task_notification" && m.tool_use_id) {
        return [
          {
            type: "agent.completed",
            toolUseId: m.tool_use_id,
            taskId: m.task_id,
            ...(m.run_id ? { runId: m.run_id } : {}),
            status: m.status,
            ...(m.reason ? { reason: m.reason } : {}),
            summary: m.summary,
            ...(m.usage
              ? { totalTokens: m.usage.total_tokens, toolUses: m.usage.tool_uses, durationMs: m.usage.duration_ms }
              : {}),
          },
        ];
      }
      return [];

    case "stream_event":
      // Only the main agent streams deltas; subagent text arrives as whole messages (forwardSubagentText).
      if (m.parent_tool_use_id === null && m.event.type === "content_block_delta") {
        if (m.event.delta.type === "text_delta") return [{ type: "text.delta", text: m.event.delta.text }];
        if (m.event.delta.type === "thinking_delta" && m.event.delta.thinking) {
          return [{ type: "thinking.delta", text: m.event.delta.thinking }];
        }
      }
      return [];

    case "assistant": {
      const events: AgentEvent[] = [];
      const agentId = agentIdOf(m);
      for (const block of m.message.content) {
        if (block.type === "tool_use") {
          events.push({
            type: "tool.started",
            toolUseId: block.id,
            name: block.name,
            input: block.input,
            parentToolUseId: m.parent_tool_use_id,
            ...(agentId ? { agentId } : {}),
          });
        } else if (block.type === "text" && m.parent_tool_use_id !== null && block.text.trim()) {
          events.push({
            type: "agent.text",
            parentToolUseId: m.parent_tool_use_id,
            ...(agentId ? { agentId } : {}),
            text: block.text,
          });
        }
      }
      return events;
    }

    case "user": {
      const content = m.message.content;
      if (typeof content === "string") return [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (block.type === "tool_result") {
          events.push({
            type: "tool.completed",
            toolUseId: block.tool_use_id,
            isError: block.is_error === true,
            output: summarize(block.content),
            parentToolUseId: m.parent_tool_use_id,
          });
        }
      }
      return events;
    }

    case "result":
      return [
        {
          type: "turn.completed",
          subtype: m.subtype,
          isError: m.is_error,
          totalCostUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
          numTurns: m.num_turns,
          ...(m.modelUsage ? { usage: sumUsage(Object.values(m.modelUsage)) } : {}),
        },
      ];

    default:
      return [];
  }
}

/** Session token totals over every model used, subagents included. */
export function sumUsage(models: ModelUsage[]) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  for (const u of models) {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadInputTokens;
    usage.cacheCreationTokens += u.cacheCreationInputTokens;
  }
  return usage;
}

/** TS SDK v0.3.292+ tags subagent messages with `agent_id`; older shapes don't have it. */
function agentIdOf(m: object): string | undefined {
  return "agent_id" in m && typeof m.agent_id === "string" ? m.agent_id : undefined;
}

/** Flattens tool_result content to text and caps it, so large outputs don't flood the IPC channel. */
export function summarize(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
            .join("\n")
        : "";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (${text.length - 4000} more chars)` : text;
}
