import {
  Bot,
  Brain,
  Check,
  FilePen,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  type LucideIcon,
  RotateCcw,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { createContext, useContext, useState } from "react";
import { Markdown } from "./Markdown.tsx";
import { editPairs, lineDiff } from "./textdiff.ts";
import type { AgentItem, Item, ToolItem } from "./transcript.ts";

/**
 * Renders a session transcript. `onRewind` is offered on user messages that have a message id, while no turn is
 * running (M1-23).
 */
/** The session's workspace, so tool rows can show paths inside it as relative ones. */
const Workspace = createContext("");

export function TranscriptView({
  cwd,
  items,
  onRewind,
  onOpenFile,
  onStarter,
}: {
  cwd: string;
  items: Item[];
  onRewind?: (messageId: string) => void;
  onOpenFile?: (file: string) => void;
  /** Offered before the first message: puts a starter prompt in the composer. */
  onStarter?: (text: string) => void;
}) {
  // Long sessions render their latest items only; earlier ones load on demand (M1-10).
  const [shown, setShown] = useState(WINDOW);
  const hidden = Math.max(0, items.length - shown);
  return (
    <Workspace.Provider value={cwd}>
      {hidden > 0 && (
        <button type="button" className="link show-earlier" onClick={() => setShown((n) => n + WINDOW)}>
          Show {Math.min(hidden, WINDOW)} earlier of {hidden} hidden
        </button>
      )}
      {items.slice(hidden).map((it) => (
        <ItemView key={`${it.kind}-${it.id}`} item={it} onRewind={onRewind} onOpenFile={onOpenFile} />
      ))}
      {onStarter && !items.some((i) => i.kind === "user") && <Starters onPick={onStarter} />}
    </Workspace.Provider>
  );
}

const STARTERS = [
  "Explain how this codebase is organized",
  "Find a bug and propose a fix",
  "Add tests for the most important module",
  "Review the uncommitted changes",
];

function Starters({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="starters">
      <Bot size={28} className="starters-icon" aria-hidden />
      <h2>What should Claude work on?</h2>
      <p className="muted">Describe a task below, or start from one of these.</p>
      <div className="starter-chips">
        {STARTERS.map((text) => (
          <button key={text} type="button" className="secondary small" onClick={() => onPick(text)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

const WINDOW = 200;

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
      );
    }
    case "assistant":
      return (
        <div className="msg assistant">
          <Markdown text={item.text} />
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
}

const GUARD = "Blocked by AgentChainer guard: ";

function ToolView({ tool, onOpenFile }: { tool: ToolItem; onOpenFile: OpenFile }) {
  const cwd = useContext(Workspace);
  const guardAt = tool.output?.indexOf(GUARD) ?? -1;
  const blocked = guardAt >= 0;
  const reason = blocked ? tool.output?.slice(guardAt + GUARD.length).split("\n")[0] : undefined;
  const file = (tool.input as { file_path?: unknown } | null)?.file_path;
  const pairs = editPairs(tool.name, tool.input);
  const diffs = pairs?.map((p) => lineDiff(p.before, p.after));
  const added = diffs?.flat().filter((l) => l.op === "+").length ?? 0;
  const removed = diffs?.flat().filter((l) => l.op === "-").length ?? 0;
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
        {blocked && <span className="badge danger">blocked by guard</span>}
        {tool.durationMs !== undefined && <span className="tool-time">{(tool.durationMs / 1000).toFixed(1)} s</span>}
        <StatusIcon status={tool.status} />
      </summary>
      {reason && <p className="warn guard-reason">Blocked by AgentChainer's guard: {reason}</p>}
      {onOpenFile && typeof file === "string" && (
        <button type="button" className="link open-file" onClick={() => onOpenFile(file)}>
          Open in editor
        </button>
      )}
      {diffs ? (
        diffs.map((lines, i) => (
          // Edits of one call have no ids; their order is fixed.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <pre key={i} className="inline-diff">
            {lines.map((l, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff.
              <span key={j} className={l.op === "+" ? "add" : l.op === "-" ? "del" : ""}>
                {l.op} {l.text}
                {"\n"}
              </span>
            ))}
          </pre>
        ))
      ) : (
        <pre>{JSON.stringify(tool.input, null, 2)}</pre>
      )}
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
  if (status === "running") return <Loader2 size={14} className="tool-status spin" aria-label="Running" />;
  if (status === "done") return <Check size={14} className="tool-status" aria-label="Done" />;
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
