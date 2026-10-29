import type { Effort, PermissionMode } from "@agentchainer/protocol";
import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { type Attachment, Composer } from "./Composer.tsx";
import type { Confirm } from "./Dialog.tsx";
import { MODE_NAMES } from "./options.ts";
import { SessionHeader } from "./SessionHeader.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { budgetWarning, type Cost, type Tab } from "./tabs.ts";
import { layoutStorage } from "./ui/layoutStorage.ts";
import { useWorkspace } from "./useWorkspace.ts";
import type { PanelTab } from "./WorkspacePanel.tsx";

// Monaco and xterm are large; load them when first used.
const DiffView = lazy(() => import("./DiffView.tsx"));
const TerminalPanel = lazy(() => import("./TerminalPanel.tsx"));
// The workspace panel carries the file-type icon set; it loads with the first session, not at app start.
const WorkspacePanel = lazy(() => import("./WorkspacePanel.tsx").then((m) => ({ default: m.WorkspacePanel })));

/** True while a dialog, menu or select list is open: Esc belongs to it then. */
const layerOpen = () =>
  document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');

/**
 * One session (UX-03): header, transcript and composer in the center, an optional terminal below them, and the
 * workspace panel on the right, where a selected file's diff replaces the tabs. Every open session stays mounted
 * (invisible when inactive), so drafts, queues, scroll positions and terminals survive switching.
 */
export function SessionView({
  tab,
  hidden,
  rightOpen,
  terminalOpen,
  onToggleRight,
  onToggleTerminal,
  onSend,
  onInterrupt,
  onModeChange,
  onModelChange,
  onEffortChange,
  onRewind,
  onResume,
  onRename,
  onFork,
  onClose,
  onOpenSetup,
  panelTab,
  showFirstChange = false,
  onOpenFile,
  confirm,
}: {
  tab: Tab;
  hidden: boolean;
  rightOpen: boolean;
  terminalOpen: boolean;
  onToggleRight: () => void;
  onToggleTerminal: () => void;
  onSend: (text: string, images: Attachment[]) => void;
  onInterrupt: () => void;
  onModeChange: (mode: PermissionMode) => void;
  onModelChange: (alias: string) => void;
  onEffortChange: (effort: Effort | null) => void;
  onRewind: (messageId: string) => void;
  onResume: () => void;
  onRename: (title: string) => void;
  onFork: () => void;
  onClose: () => void;
  /** Opens the workspace setup page (M2-08…M2-17) for this session's folder. */
  onOpenSetup: () => void;
  /** The right panel's tab when it opens (self-test screenshots). */
  panelTab?: PanelTab | undefined;
  /** Shows the first changed file's diff once the listing arrives (self-test screenshots). */
  showFirstChange?: boolean;
  /** Opens a workspace-relative or absolute path in the user's editor (M1-28). */
  onOpenFile: (path: string, line?: number) => void;
  confirm: Confirm;
}) {
  /** The file shown in the diff, relative to the workspace. */
  const [selected, setSelected] = useState<string | null>(null);
  const [seed, setSeed] = useState<{ text: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const right = usePanelRef();
  /** The right panel's width before a diff widened it. */
  const narrow = useRef<number | null>(null);
  const workspace = useWorkspace(tab.cwd, !hidden);
  const { refresh } = workspace;
  const paths = useMemo(() => workspace.files?.files.map((f) => f.path) ?? [], [workspace.files]);
  const warning = budgetWarning(tab);
  const split = useDefaultLayout({
    id: "agentchainer.session",
    panelIds: rightOpen ? ["center", "right"] : ["center"],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });
  const vsplit = useDefaultLayout({
    id: "agentchainer.terminal",
    panelIds: terminalOpen ? ["chat", "terminal"] : ["chat"],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  const firstChange = showFirstChange ? workspace.files?.files.find((f) => f.status)?.path : undefined;
  useEffect(() => {
    if (firstChange) setSelected((s) => s ?? firstChange);
  }, [firstChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the transcript changes.
  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [tab.items]);

  // A finished turn may have changed files through Bash, which the watcher can miss on Linux (new folders).
  useEffect(() => {
    if (!tab.running && !hidden) void refresh();
  }, [tab.running, hidden, refresh]);

  // A diff needs room: widen the right panel while one is shown, then give the old width back.
  useEffect(() => {
    const panel = right.current;
    if (!rightOpen || !panel) {
      narrow.current = null;
      return;
    }
    if (selected && narrow.current === null) {
      narrow.current = panel.getSize().inPixels;
      panel.resize("55%");
    } else if (!selected && narrow.current !== null) {
      panel.resize(narrow.current);
      narrow.current = null;
    }
  }, [selected, rightOpen, right]);

  // Esc stops the running turn (M1-14), unless a dialog or menu is open: there it closes that instead.
  useEffect(() => {
    if (hidden || !tab.running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !layerOpen()) onInterrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, tab.running, onInterrupt]);

  return (
    <div className="session" hidden={hidden}>
      <Group
        orientation="horizontal"
        className="session-split"
        defaultLayout={split.defaultLayout}
        onLayoutChanged={split.onLayoutChanged}
      >
        <Panel id="center" minSize={380}>
          <div className="session-center">
            <SessionHeader
              tab={tab}
              branch={workspace.files?.branch ?? null}
              terminalOpen={terminalOpen}
              rightOpen={rightOpen}
              onToggleTerminal={onToggleTerminal}
              onToggleRight={onToggleRight}
              onRename={onRename}
              onFork={onFork}
              onClose={onClose}
              onOpenSetup={onOpenSetup}
            />
            {warning && <div className="banner">{warning}</div>}
            <Group
              orientation="vertical"
              className="center-split"
              defaultLayout={vsplit.defaultLayout}
              onLayoutChanged={vsplit.onLayoutChanged}
            >
              <Panel id="chat" minSize={200}>
                <div className="chat">
                  <div className="transcript-scroll">
                    <div className="transcript">
                      <TranscriptView
                        cwd={tab.cwd}
                        items={tab.items}
                        onOpenFile={(file) => onOpenFile(file)}
                        {...(tab.running || tab.ended ? {} : { onRewind, onStarter: (text) => setSeed({ text }) })}
                      />
                      {tab.running && (
                        <div className="working">
                          <Loader2 size={14} className="spin" aria-hidden />
                          Working… <kbd>Esc</kbd> to stop
                        </div>
                      )}
                      <div ref={bottomRef} />
                    </div>
                  </div>
                  <Composer
                    tab={tab}
                    files={paths}
                    seed={seed}
                    onSend={onSend}
                    onInterrupt={onInterrupt}
                    onResume={onResume}
                    onModeChange={onModeChange}
                    onModelChange={onModelChange}
                    onEffortChange={onEffortChange}
                  />
                </div>
              </Panel>
              {terminalOpen && <Separator className="resize-handle" />}
              {terminalOpen && (
                <Panel id="terminal" defaultSize={220} minSize={100} groupResizeBehavior="preserve-pixel-size">
                  <Suspense fallback={<div className="terminal-host muted">Loading terminal…</div>}>
                    <TerminalPanel cwd={tab.cwd} />
                  </Suspense>
                </Panel>
              )}
            </Group>
            <footer className="statusbar">
              <span>{tab.model ?? "…"}</span>
              <span>{MODE_NAMES[tab.mode]}</span>
              <span className="grow" />
              <span>{costLabel(tab.cost)}</span>
            </footer>
          </div>
        </Panel>
        {rightOpen && <Separator className="resize-handle" />}
        {rightOpen && (
          <Panel
            id="right"
            panelRef={right}
            defaultSize={380}
            minSize={280}
            maxSize="75%"
            groupResizeBehavior="preserve-pixel-size"
          >
            <aside className="right-panel" aria-label="Workspace">
              <div className="right-tabs" hidden={selected !== null}>
                <Suspense fallback={<p className="muted panel-loading">Loading…</p>}>
                  <WorkspacePanel
                    key={panelTab}
                    {...(panelTab ? { initialTab: panelTab } : {})}
                    cwd={tab.cwd}
                    files={workspace.files}
                    error={workspace.error}
                    items={tab.items}
                    selected={selected}
                    confirm={confirm}
                    onSelect={setSelected}
                    onOpenFile={(path) => onOpenFile(path)}
                    onRefresh={() => void refresh()}
                    onOpenSetup={onOpenSetup}
                  />
                </Suspense>
              </div>
              {selected && (
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
              )}
            </aside>
          </Panel>
        )}
      </Group>
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
