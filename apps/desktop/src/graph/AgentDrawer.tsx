import { redactSecrets } from "@agentchainer/protocol";
import { Bot, Square, X } from "lucide-react";
import { useState } from "react";
import { approxUsd, count, seconds } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { AgentChildren } from "../TranscriptView.tsx";
import { agentUsd, type Cost } from "../tabs.ts";
import { type AgentItem, agentDuration } from "../transcript.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { statusLabel } from "./StatusIcon.tsx";

/**
 * One subagent in the right panel (M4-03): what it was asked, what it did so far, its tokens and ≈USD, and Stop this
 * agent (M4-05). A reopened session's subagents come from their stored transcripts (M4-08), without tokens or cost.
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
    [t("graph.agentDrawer.status"), waiting && live ? t("graph.agentDrawer.waiting") : statusLabel(agent.status)],
    [t("graph.agentDrawer.type"), agent.agentType],
    [t("graph.agentDrawer.using"), live ? agent.lastTool : undefined],
    [t("graph.agentDrawer.time"), duration !== undefined ? seconds((duration / 1000).toFixed(1)) : undefined],
    [t("graph.agentDrawer.tokens"), agent.tokens !== undefined ? count(agent.tokens) : undefined],
    [t("graph.agentDrawer.toolCalls"), agent.toolUses?.toString()],
    [t("graph.agentDrawer.cost"), usd !== null ? approxUsd(usd, 4) : undefined],
  ];

  return (
    <section className="agent-drawer" aria-label={t("graph.agentDrawer.label", { description: agent.description })}>
      <header className="agent-drawer-head">
        <Bot size={16} aria-hidden />
        <h2 title={agent.description}>{agent.description}</h2>
        <IconButton label={t("shell.dialog.close")} shortcut="Esc" onClick={onClose}>
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
        {usd !== null && <p className="field-help">{t("graph.agentDrawer.costHelp")}</p>}
        {live && taskId && canStop && (
          <div className="agent-drawer-actions">
            <button type="button" className="danger small" disabled={stopping === taskId} onClick={() => void stop()}>
              <Square size={13} />
              {stopping === taskId ? t("graph.agentDrawer.stopping") : t("graph.agentDrawer.stop")}
            </button>
            <span className="muted">{t("graph.agentDrawer.stopHint")}</span>
          </div>
        )}
        {error && <p className="agent-error">{error}</p>}
        {agent.error && <p className="agent-error">{agent.error}</p>}
        {agent.prompt && (
          <>
            <h3>{t("graph.agentDrawer.prompt")}</h3>
            <pre className="agent-prompt">{redactSecrets(agent.prompt)}</pre>
          </>
        )}
        <h3>{t("graph.agentDrawer.activity")}</h3>
        {agent.children.length ? (
          <div className="agent-children">
            <AgentChildren cwd={cwd} agent={agent} onOpenFile={onOpenFile} />
          </div>
        ) : (
          <p className="muted">{t("graph.agentDrawer.nothingYet")}</p>
        )}
        {result && (
          <>
            <h3>{t("graph.agentDrawer.result")}</h3>
            <div className="agent-summary">{result}</div>
          </>
        )}
      </div>
    </section>
  );
}
