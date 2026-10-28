import type { AgentItem, Item, ToolItem } from "./transcript.ts";

/**
 * Renders a session transcript. `onRewind` is offered on user messages that have a message id, while no turn is
 * running (M1-23).
 */
export function TranscriptView({
  items,
  onRewind,
  onOpenFile,
}: {
  items: Item[];
  onRewind?: (messageId: string) => void;
  onOpenFile?: (file: string) => void;
}) {
  return (
    <>
      {items.map((it) => (
        <ItemView key={`${it.kind}-${it.id}`} item={it} onRewind={onRewind} onOpenFile={onOpenFile} />
      ))}
    </>
  );
}

type OpenFile = ((file: string) => void) | undefined;

function ItemView({
  item,
  onRewind,
  onOpenFile,
}: {
  item: Item;
  onRewind?: ((messageId: string) => void) | undefined;
  onOpenFile: OpenFile;
}) {
  switch (item.kind) {
    case "user": {
      const { messageId } = item;
      return (
        <div className="msg user">
          {item.text}
          {onRewind && messageId && (
            <button
              type="button"
              className="link rewind"
              title="Restore files the agent edited since this message"
              onClick={() => onRewind(messageId)}
            >
              Rewind files to here
            </button>
          )}
        </div>
      );
    }
    case "assistant":
      return <div className="msg assistant">{item.text}</div>;
    case "notice":
      return <div className="notice">{item.text}</div>;
    case "tool":
      return <ToolView tool={item} onOpenFile={onOpenFile} />;
    case "agent":
      return <AgentView agent={item} onOpenFile={onOpenFile} />;
  }
}

function ToolView({ tool, onOpenFile }: { tool: ToolItem; onOpenFile: OpenFile }) {
  const blocked = tool.output?.includes("Blocked by AgentChainer guard") ?? false;
  const file = (tool.input as { file_path?: unknown } | null)?.file_path;
  return (
    <details className={`tool ${tool.status}`} open={blocked}>
      <summary>
        <StatusIcon status={tool.status} />
        {tool.name} <code>{toolSummary(tool.input)}</code>
        {blocked && <span className="badge">blocked by guard</span>}
      </summary>
      {onOpenFile && typeof file === "string" && (
        <button type="button" className="link open-file" onClick={() => onOpenFile(file)}>
          Open in editor
        </button>
      )}
      <pre>{JSON.stringify(tool.input, null, 2)}</pre>
      {tool.output !== undefined && <pre className="tool-output">{tool.output}</pre>}
    </details>
  );
}

function AgentView({ agent, onOpenFile }: { agent: AgentItem; onOpenFile: OpenFile }) {
  const meta = [
    agent.agentType,
    agent.durationMs !== undefined ? `${(agent.durationMs / 1000).toFixed(1)} s` : null,
    agent.tokens !== undefined ? `${agent.tokens.toLocaleString()} tokens` : null,
  ].filter(Boolean);
  return (
    <details className={`agent ${agent.status}`} open={agent.status === "running"}>
      <summary>
        <StatusIcon status={agent.status} />
        <strong>Subagent</strong> {agent.description}
        {meta.length > 0 && <span className="muted">{meta.join(" · ")}</span>}
      </summary>
      <div className="agent-children">
        {agent.children.map((c) =>
          c.kind === "tool" ? (
            <ToolView key={`tool-${c.id}`} tool={c} onOpenFile={onOpenFile} />
          ) : (
            <div key={`text-${c.id}`} className="msg agent-text">
              {c.text}
            </div>
          ),
        )}
        {agent.summary && <div className="agent-summary">{agent.summary}</div>}
      </div>
    </details>
  );
}

function StatusIcon({ status }: { status: "running" | "done" | "error" }) {
  return <span className="tool-status">{status === "running" ? "⋯" : status === "done" ? "✓" : "✕"}</span>;
}

function toolSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const v = o.command ?? o.file_path ?? o.pattern ?? o.url ?? o.description;
    if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  return "";
}
