import { PERMISSION_MODES, type PermissionMode } from "@agentchainer/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { MODE_LABELS } from "./SettingsPanel.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { asMode, type Cost, type Tab } from "./tabs.ts";

/**
 * Transcript and composer of one session tab. Every open tab stays mounted (hidden when inactive), so drafts and
 * scroll positions survive tab switches.
 */
export function SessionView({
  tab,
  hidden,
  onSend,
  onInterrupt,
  onModeChange,
  onRewind,
  onResume,
}: {
  tab: Tab;
  hidden: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onModeChange: (mode: PermissionMode) => void;
  onRewind: (messageId: string) => void;
  onResume: () => void;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the transcript changes.
  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [tab.items]);

  function send() {
    const text = draft.trim();
    if (!text || tab.running || tab.ended) return;
    setDraft("");
    onSend(text);
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="session" hidden={hidden}>
      <main className="transcript">
        <TranscriptView items={tab.items} {...(tab.running || tab.ended ? {} : { onRewind })} />
        {tab.running && <div className="muted thinking">Working…</div>}
        <div ref={bottomRef} />
      </main>

      <footer className="composer">
        <textarea
          value={draft}
          placeholder="Ask Claude to do something in this workspace… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onComposerKey}
          rows={3}
        />
        <div className="composer-actions">
          <select value={tab.mode} onChange={(e) => onModeChange(asMode(e.target.value))} aria-label="Permission mode">
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <span className="muted grow">
            {tab.model ?? "…"} · {costLabel(tab.cost)}
          </span>
          {tab.ended ? (
            <button type="button" onClick={onResume} title="Continue this conversation in a new live session">
              Resume session
            </button>
          ) : tab.running ? (
            <button type="button" className="secondary" onClick={onInterrupt}>
              Stop
            </button>
          ) : (
            <button type="button" disabled={!draft.trim()} onClick={send}>
              Send
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

const usd = (v: number) => `≈$${v.toFixed(4)}`;

function costLabel(cost: Cost): string {
  const last = cost.lastUsd === null ? "" : `last turn ${usd(cost.lastUsd)} (${(cost.lastMs / 1000).toFixed(1)} s) · `;
  return `${last}session ${cost.totalUsd === null ? "–" : usd(cost.totalUsd)} (estimate)`;
}
