import {
  Bot,
  Brain,
  Check,
  FilePen,
  FileText,
  Globe,
  Layers,
  ListTodo,
  Loader2,
  type LucideIcon,
  Pause,
  RotateCcw,
  Search,
  Square,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { createContext, memo, useCallback, useContext, useMemo, useRef, useState } from "react";
import { diffStat, editDiffs, InlineDiff } from "./InlineDiff.tsx";
import { Markdown } from "./Markdown.tsx";
import {
  type AgentItem,
  type AgentStatus,
  groupItems,
  type Item,
  type ToolGroup,
  type ToolItem,
} from "./transcript.ts";
import { CopyButton } from "./ui/CopyButton.tsx";

/** The session's workspace, so tool rows can show paths inside it as relative ones. */
const Workspace = createContext("");

/**
 * Renders a session transcript (M1-10, UX-04). `onRewind` is offered on user messages that have a message id, while no
 * turn is running (M1-23). Rows are memoized and get stable callbacks, so a streaming reply re-renders only itself;
 * runs of tool calls collapse into one row.
 */
export function TranscriptView({
  cwd,
  items,
  onRewind,
  onOpenFile,
}: {
  cwd: string;
  items: Item[];
  onRewind?: (messageId: string) => void;
  onOpenFile?: (file: string) => void;
}) {
  // Long sessions render their latest items only; earlier ones load on demand (M1-10).
  const [shown, setShown] = useState(WINDOW);
  const hidden = Math.max(0, items.length - shown);
  const rewindRef = useRef(onRewind);
  rewindRef.current = onRewind;
  const openRef = useRef(onOpenFile);
  openRef.current = onOpenFile;
  const rewind = useCallback((messageId: string) => rewindRef.current?.(messageId), []);
  const open = useCallback((file: string) => openRef.current?.(file), []);
  const canRewind = onRewind !== undefined;
  const openFile = onOpenFile !== undefined ? open : undefined;
  const rows = useMemo(() => groupItems(items.slice(hidden)), [items, hidden]);
  return (
    <Workspace.Provider value={cwd}>
      {hidden > 0 && (
        <button type="button" className="link show-earlier" onClick={() => setShown((n) => n + WINDOW)}>
          Show {Math.min(hidden, WINDOW)} earlier of {hidden} hidden
        </button>
      )}
      {rows.map((row) =>
        row.kind === "tools" ? (
          <ToolGroupView key={row.id} group={row} onOpenFile={openFile} />
        ) : (
          <ItemView
            key={`${row.kind}-${row.id}`}
            item={row}
            onRewind={canRewind ? rewind : undefined}
            onOpenFile={openFile}
          />
        ),
      )}
    </Workspace.Provider>
  );
}

const WINDOW = 200;

type OpenFile = ((file: string) => void) | undefined;

/** When a live message arrived: the time, with the full date on hover. */
function MsgTime({ at }: { at: number }) {
  const d = new Date(at);
  return (
    <time className="msg-time" dateTime={d.toISOString()} title={d.toLocaleString()}>
      {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

const ItemView = memo(function ItemView({
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
        <div className="msg-user">
          <div className="msg user">
            {item.images && item.images.length > 0 && (
              <div className="attachments">
                {item.images.map((src, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a message's images never reorder.
                  <img key={i} src={src} alt={`Attachment ${i + 1}`} />
                ))}
              </div>
            )}
            {!item.images && item.imageCount ? (
              <div className="muted">
                [{item.imageCount} image{item.imageCount > 1 ? "s" : ""}]
              </div>
            ) : null}
            {item.text}
          </div>
          <div className="msg-meta">
            {item.at !== undefined && <MsgTime at={item.at} />}
            {onRewind && messageId && (
              <button
                type="button"
                className="ghost small rewind"
                title="Restore files the agent edited since this message"
                onClick={() => onRewind(messageId)}
              >
                <RotateCcw size={12} />
                Rewind files to here
              </button>
            )}
          </div>
        </div>
      );
    }
    case "assistant":
      return (
        <div className={`msg assistant${item.open ? " streaming" : ""}`}>
          <Markdown text={item.text} />
          {!item.open && (
            <div className="msg-meta">
              {item.at !== undefined && <MsgTime at={item.at} />}
              <CopyButton text={item.text} label="Copy message" />
            </div>
          )}
        </div>
      );
    case "thinking":
      return (
        <details className="thinking-block">
          <summary>
            <Brain size={14} aria-hidden />
            {item.open ? "Thinking…" : "Thought"}
          </summary>
          <div>{item.text}</div>
        </details>
      );
    case "notice":
      return <div className="notice">{item.text}</div>;
    case "tool":
      return <ToolView tool={item} onOpenFile={onOpenFile} />;
    case "agent":
      return <AgentView agent={item} onOpenFile={onOpenFile} />;
  }
});

/** "Read ×3 · Bash · Edit": the tools of a group, in first-use order. */
function toolCounts(tools: ToolItem[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" · ");
}

/**
 * A run of tool calls as one row (UX-04). Open while it runs, and whenever a call failed or the guard blocked one, so
 * nothing that needs attention is folded away; a finished, clean run folds itself.
 */
const ToolGroupView = memo(
  function ToolGroupView({ group, onOpenFile }: { group: ToolGroup; onOpenFile: OpenFile }) {
    const tools = group.members.filter((m): m is ToolItem => m.kind === "tool");
    const running = tools.some((t) => t.status === "running");
    const failed = tools.filter((t) => t.status === "error").length;
    const status = running ? "running" : failed ? "error" : "done";
    return (
      <details className={`tool-group ${status}`} open={running || failed > 0}>
        <summary>
          <Layers size={14} className="tool-icon" aria-hidden />
          <span className="tool-name">{running ? "Running tools" : `Ran ${tools.length} tools`}</span>
          <span className="tool-arg">{toolCounts(tools)}</span>
          {failed > 0 && <span className="badge danger">{failed} failed</span>}
          <StatusIcon status={status} />
        </summary>
        <div className="tool-group-body">
          {group.members.map((m) => (
            <ItemView key={`${m.kind}-${m.id}`} item={m} onOpenFile={onOpenFile} />
          ))}
        </div>
      </details>
    );
  },
  (a, b) =>
    a.onOpenFile === b.onOpenFile &&
    a.group.members.length === b.group.members.length &&
    a.group.members.every((m, i) => m === b.group.members[i]),
);

const GUARD = "Blocked by AgentChainer guard: ";

const ToolView = memo(function ToolView({ tool, onOpenFile }: { tool: ToolItem; onOpenFile: OpenFile }) {
  const cwd = useContext(Workspace);
  const guardAt = tool.output?.indexOf(GUARD) ?? -1;
  const blocked = guardAt >= 0;
  const reason = blocked ? tool.output?.slice(guardAt + GUARD.length).split("\n")[0] : undefined;
  const file = (tool.input as { file_path?: unknown } | null)?.file_path;
  const diffs = editDiffs(tool.name, tool.input);
  const { added, removed } = diffs ? diffStat(diffs) : { added: 0, removed: 0 };
  return (
    <details className={`tool ${tool.status}`} open={blocked}>
      <summary>
        <ToolIcon name={tool.name} />
        <span className="tool-name">{tool.name}</span>
        <code className="tool-arg">{toolSummary(tool.input, cwd)}</code>
        {diffs && (
          <span className="diffstat">
            <span className="add">+{added}</span> <span className="del">−{removed}</span>
          </span>
        )}
        {blocked && (
          <span className="badge danger" title={reason}>
            blocked by guard
          </span>
        )}
        {tool.durationMs !== undefined && <span className="tool-time">{(tool.durationMs / 1000).toFixed(1)} s</span>}
        <StatusIcon status={tool.status} />
      </summary>
      {reason && <p className="warn guard-reason">Blocked by AgentChainer's guard: {reason}</p>}
      {onOpenFile && typeof file === "string" && (
        <button type="button" className="link open-file" onClick={() => onOpenFile(file)}>
          Open in editor
        </button>
      )}
      {diffs ? <InlineDiff diffs={diffs} /> : <pre>{JSON.stringify(tool.input, null, 2)}</pre>}
      {tool.output !== undefined && <pre className="tool-output">{tool.output}</pre>}
    </details>
  );
});

const AgentView = memo(function AgentView({ agent, onOpenFile }: { agent: AgentItem; onOpenFile: OpenFile }) {
  const live = agent.status === "running" || agent.status === "paused";
  const meta = [
    agent.agentType,
    live && agent.lastTool ? `using ${agent.lastTool}` : null,
    agent.durationMs !== undefined ? `${(agent.durationMs / 1000).toFixed(1)} s` : null,
    agent.tokens !== undefined ? `${agent.tokens.toLocaleString()} tokens` : null,
  ].filter(Boolean);
  return (
    <details className={`agent ${agent.status}`} open={agent.status === "running"}>
      <summary>
        <Bot size={14} className="tool-icon" aria-hidden />
        <span className="tool-name">Subagent</span>
        <span className="tool-arg">{agent.description}</span>
        {meta.length > 0 && <span className="tool-time">{meta.join(" · ")}</span>}
        <StatusIcon status={agent.status} />
      </summary>
      <div className="agent-children">
        {agent.children.map((c) =>
          c.kind === "tool" ? (
            <ToolView key={`tool-${c.id}`} tool={c} onOpenFile={onOpenFile} />
          ) : c.kind === "agent" ? (
            <AgentView key={`agent-${c.id}`} agent={c} onOpenFile={onOpenFile} />
          ) : (
            <div key={`text-${c.id}`} className="msg agent-text">
              {c.text}
            </div>
          ),
        )}
        {live && agent.progress && <div className="agent-summary">{agent.progress}</div>}
        {agent.error && <div className="agent-error">{agent.error}</div>}
        {agent.summary && !repeatsLastText(agent) && <div className="agent-summary">{agent.summary}</div>}
      </div>
    </details>
  );
});

/** The SDK's summary is often the subagent's last message word for word; it's shown once then. */
function repeatsLastText(agent: AgentItem): boolean {
  const last = agent.children.at(-1);
  return last?.kind === "text" && last.text.trim() === agent.summary?.trim();
}

function StatusIcon({ status }: { status: AgentStatus }) {
  if (status === "running") return <Loader2 size={14} className="tool-status spin" aria-label="Running" />;
  if (status === "done") return <Check size={14} className="tool-status" aria-label="Done" />;
  if (status === "stopped") return <Square size={14} className="tool-status" aria-label="Stopped" />;
  if (status === "paused") return <Pause size={14} className="tool-status" aria-label="Paused" />;
  return <X size={14} className="tool-status" aria-label="Failed" />;
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Edit: FilePen,
  MultiEdit: FilePen,
  Write: FilePen,
  NotebookEdit: FilePen,
  Bash: SquareTerminal,
  BashOutput: SquareTerminal,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,
  Agent: Bot,
  TodoWrite: ListTodo,
};

function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS[name] ?? Wrench;
  return <Icon size={14} className="tool-icon" aria-hidden />;
}

/** The one input worth showing in a collapsed tool row; paths inside the workspace are shown relative to it. */
function toolSummary(input: unknown, cwd: string): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    let v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description;
    if (typeof v === "string" && cwd && (v.startsWith(`${cwd}/`) || v.startsWith(`${cwd}\\`)))
      v = v.slice(cwd.length + 1);
    if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  return "";
}
