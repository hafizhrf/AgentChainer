import { Bot, Square, X } from "lucide-react";
import { useState } from "react";
import { AgentChildren } from "../TranscriptView.tsx";
import { agentUsd, type Cost } from "../tabs.ts";
import { type AgentItem, type AgentStatus, agentDuration } from "../transcript.ts";
import { IconButton } from "../ui/IconButton.tsx";

const STATUS_LABEL: Record<AgentStatus, string> = {
  running: "Running",
  paused: "Paused",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

/**
 * One subagent in the right panel (M4-03): what it was asked, what it did so far, its tokens and ≈USD, and Stop this
 * agent (M4-05). Live only: a reopened session's subagent transcripts come with replay (M4-08).
 */
export function AgentDrawer({
  cwd,
  agent,
  cost,
  canStop,
  waiting,
  onStop,
  onClose,
  onOpenFile,
}: {
  cwd: string;
  agent: AgentItem;
  cost: Cost;
  /** A turn is running, so the SDK can stop a task. */
  canStop: boolean;
  /** One of its tool calls waits for an approval. */
  waiting: boolean;
  onStop: (taskId: string) => Promise<void>;
  onClose: () => void;
  onOpenFile: (file: string) => void;
}) {
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = agent.status === "running" || agent.status === "paused";
  const usd = agentUsd(cost, agent.tokens);
  const taskId = agent.taskId;

  async function stop() {
    if (!taskId) return;
    setStopping(taskId);
    setError(null);
    try {
      await onStop(taskId);
    } catch (err) {
      setError(String(err));
      setStopping(null);
    }
  }

  const duration = agentDuration(agent);
  // A stopped agent's summary is only its description; it isn't a result.
  const result = agent.summary && agent.summary !== agent.description ? agent.summary : null;
  const facts: [string, string | undefined][] = [
    ["Status", waiting && live ? "Waiting for your approval" : STATUS_LABEL[agent.status]],
    ["Type", agent.agentType],
    ["Using", live ? agent.lastTool : undefined],
    ["Time", duration !== undefined ? `${(duration / 1000).toFixed(1)} s` : undefined],
    ["Tokens", agent.tokens?.toLocaleString()],
    ["Tool calls", agent.toolUses?.toString()],
    ["Cost", usd !== null ? `≈$${usd.toFixed(4)}` : undefined],
  ];

  return (
    <section className="agent-drawer" aria-label={`Subagent: ${agent.description}`}>
      <header className="agent-drawer-head">
        <Bot size={16} aria-hidden />
        <h2 title={agent.description}>{agent.description}</h2>
        <IconButton label="Close" shortcut="Esc" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </header>
      <div className="agent-drawer-body">
        <dl className="agent-facts">
          {facts.map(([k, v]) =>
            v === undefined ? null : (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ),
          )}
        </dl>
        {usd !== null && (
          <p className="field-help">
            Cost is an estimate: this agent's tokens at the session's cost per token so far. The agents' figures don't
            add up to the session total, which also covers the main agent.
          </p>
        )}
        {live && taskId && canStop && (
          <div className="agent-drawer-actions">
            <button type="button" className="danger small" disabled={stopping === taskId} onClick={() => void stop()}>
              <Square size={13} />
              {stopping === taskId ? "Stopping…" : "Stop this agent"}
            </button>
            <span className="muted">The rest of the turn goes on.</span>
          </div>
        )}
        {error && <p className="agent-error">{error}</p>}
        {agent.error && <p className="agent-error">{agent.error}</p>}
        {agent.prompt && (
          <>
            <h3>Prompt</h3>
            <pre className="agent-prompt">{agent.prompt}</pre>
          </>
        )}
        <h3>Activity</h3>
        {agent.children.length ? (
          <div className="agent-children">
            <AgentChildren cwd={cwd} agent={agent} onOpenFile={onOpenFile} />
          </div>
        ) : (
          <p className="muted">Nothing yet.</p>
        )}
        {result && (
          <>
            <h3>Result</h3>
            <div className="agent-summary">{result}</div>
          </>
        )}
      </div>
    </section>
  );
}
