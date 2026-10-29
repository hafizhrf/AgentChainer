import type { Effort, PermissionMode } from "@agentchainer/protocol";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { type Attachment, Composer } from "./Composer.tsx";
import type { Confirm } from "./Dialog.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { budgetWarning, type Cost, type Tab } from "./tabs.ts";
import { useWorkspace } from "./useWorkspace.ts";
import { WorkspacePanel } from "./WorkspacePanel.tsx";

// Monaco and xterm are large; load them when first used.
const DiffView = lazy(() => import("./DiffView.tsx"));
const TerminalPanel = lazy(() => import("./TerminalPanel.tsx"));

/**
 * One session tab: workspace sidebar (changes, files, permission rules), transcript and composer, an optional
 * terminal, and a diff pane for the selected file. Every open tab stays mounted (hidden when inactive), so drafts,
 * queues, scroll positions and terminals survive tab switches.
 */
export function SessionView({
  tab,
  hidden,
  onSend,
  onInterrupt,
  onModeChange,
  onModelChange,
  onEffortChange,
  onRewind,
  onResume,
  onOpenFile,
  confirm,
}: {
  tab: Tab;
  hidden: boolean;
  onSend: (text: string, images: Attachment[]) => void;
  onInterrupt: () => void;
  onModeChange: (mode: PermissionMode) => void;
  onModelChange: (alias: string) => void;
  onEffortChange: (effort: Effort | null) => void;
  onRewind: (messageId: string) => void;
  onResume: () => void;
  /** Opens a workspace-relative or absolute path in the user's editor (M1-28). */
  onOpenFile: (path: string, line?: number) => void;
  confirm: Confirm;
}) {
  const [showFiles, setShowFiles] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);
  /** The file shown in the diff pane, relative to the workspace. */
  const [selected, setSelected] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace(tab.cwd, !hidden);
  const { refresh } = workspace;
  const paths = useMemo(() => workspace.files?.files.map((f) => f.path) ?? [], [workspace.files]);
  const warning = budgetWarning(tab);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the transcript changes.
  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [tab.items]);

  // A finished turn may have changed files through Bash, which the watcher can miss on Linux (new folders).
  useEffect(() => {
    if (!tab.running && !hidden) void refresh();
  }, [tab.running, hidden, refresh]);

  // Esc stops the running turn (M1-14), unless a dialog is open: there it closes or cancels the dialog instead.
  useEffect(() => {
    if (hidden || !tab.running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".overlay")) onInterrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, tab.running, onInterrupt]);

  return (
    <div className="session" hidden={hidden}>
      {showFiles && (
        <aside className="sidebar">
          <WorkspacePanel
            cwd={tab.cwd}
            files={workspace.files}
            error={workspace.error}
            items={tab.items}
            selected={selected}
            model={tab.modelAlias}
            confirm={confirm}
            onSelect={setSelected}
            onRefresh={() => void refresh()}
          />
        </aside>
      )}

      <div className="chat">
        <main className="transcript">
          <TranscriptView
            items={tab.items}
            onOpenFile={(file) => onOpenFile(file)}
            {...(tab.running || tab.ended ? {} : { onRewind })}
          />
          {tab.running && <div className="muted thinking">Working… (Esc to stop)</div>}
          <div ref={bottomRef} />
        </main>

        {showTerminal && (
          <Suspense fallback={<div className="terminal muted">Loading terminal…</div>}>
            <TerminalPanel cwd={tab.cwd} />
          </Suspense>
        )}

        {warning && <div className="banner">{warning}</div>}
        <div className="statusbar muted">
          {tab.model ?? "…"} · {costLabel(tab.cost)}
        </div>
        <Composer
          tab={tab}
          files={paths}
          onSend={onSend}
          onInterrupt={onInterrupt}
          onResume={onResume}
          onModeChange={onModeChange}
          onModelChange={onModelChange}
          onEffortChange={onEffortChange}
          actions={
            <>
              <button
                type="button"
                className="secondary toggle"
                aria-pressed={showFiles}
                onClick={() => setShowFiles((v) => !v)}
              >
                Files
              </button>
              <button
                type="button"
                className="secondary toggle"
                aria-pressed={showTerminal}
                onClick={() => setShowTerminal((v) => !v)}
              >
                Terminal
              </button>
            </>
          }
        />
      </div>

      {selected && (
        <section className="diff-pane">
          <Suspense fallback={<p className="muted">Loading diff viewer…</p>}>
            <DiffView
              cwd={tab.cwd}
              path={selected}
              version={workspace.files}
              confirm={confirm}
              onClose={() => setSelected(null)}
              onOpenInEditor={(line) => onOpenFile(selected, line)}
            />
          </Suspense>
        </section>
      )}
    </div>
  );
}

const usd = (v: number) => `≈$${v.toFixed(4)}`;
const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Per-turn and per-session cost, tokens and duration (M1-31), labeled as estimates. */
function costLabel(cost: Cost): string {
  const parts: string[] = [];
  if (cost.lastUsd !== null) parts.push(`last turn ${usd(cost.lastUsd)}, ${(cost.lastMs / 1000).toFixed(1)} s`);
  if (cost.lastTokens)
    parts.push(`${kTokens(cost.lastTokens.input)} in / ${kTokens(cost.lastTokens.output)} out tokens`);
  parts.push(`session ${cost.totalUsd === null ? "–" : usd(cost.totalUsd)}`);
  return `${parts.join(" · ")} (estimate)`;
}
