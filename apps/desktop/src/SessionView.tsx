import { type Effort, imageType, type PermissionMode, type PermissionRequest } from "@agentchainer/protocol";
import { ArrowDown, ClipboardList, Globe, Loader2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { type Attachment, Composer } from "./Composer.tsx";
import type { AppCommand } from "./commands.ts";
import { latestTodos } from "./commands.ts";
import type { Confirm } from "./Dialog.tsx";
import { type DiffComment, feedbackMessage } from "./diffComments.ts";
import { FolderSwitcher } from "./FolderSwitcher.tsx";
import { joinPath } from "./files.ts";
import { AgentDrawer } from "./graph/AgentDrawer.tsx";
import { BackgroundTasks } from "./graph/BackgroundTasks.tsx";
import { SessionTimeline } from "./graph/SessionTimeline.tsx";
import { approxUsd, count, seconds, thousands } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { Rich } from "./i18n/Rich.tsx";
import { MODE_NAMES } from "./options.ts";
import type { PermissionAnswer } from "./PermissionDialog.tsx";
import type { PanelTab } from "./panelTabs.ts";
import { previewUrls } from "./preview.ts";
import { QuestionCard } from "./QuestionCard.tsx";
import { SessionHeader, type SessionMode } from "./SessionHeader.tsx";
import { TodoPanel } from "./TodoPanel.tsx";
import { TranscriptView } from "./TranscriptView.tsx";
import { budgetWarning, type Cost, isFresh, type Tab } from "./tabs.ts";
import { findAgent } from "./transcript.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { layoutStorage } from "./ui/layoutStorage.ts";
import { useWorkspace } from "./useWorkspace.ts";

// Monaco and xterm are large; load them when first used.
const DiffView = lazy(() => import("./DiffView.tsx"));
const ImageView = lazy(() => import("./ImageView.tsx"));
const TerminalPanel = lazy(() => import("./TerminalPanel.tsx"));
// React Flow and dagre load with the first graph.
const SessionGraph = lazy(() => import("./graph/SessionGraph.tsx"));
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
  onTask,
  onTeam,
  onCommand,
  onAnswer,
  onInterrupt,
  onStopAgent,
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
  hiddenTabs,
  onHiddenTabsChange,
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
  /** Makes a task of the composer's text (UX-13), when the Tasks preview is on. */
  onTask?: (text: string) => void;
  /** Starts the chat over as a Team chat, or back as a plain one (M8-03); only before anything is sent. */
  onTeam: (on: boolean) => void;
  /** An app slash command typed in the composer (UX-12). */
  onCommand: (name: AppCommand, arg: string) => void;
  /** Answers a request shown in the thread: Claude's questions (UX-12). */
  onAnswer: (request: PermissionRequest, answer: PermissionAnswer) => void;
  onInterrupt: () => void;
  /** Stops one subagent by its task id (M4-05). */
  onStopAgent: (taskId: string) => Promise<void>;
  onModeChange: (mode: PermissionMode) => void;
  onModelChange: (alias: string) => void;
  onEffortChange: (effort: Effort | null) => void;
  onRewind: (messageId: string) => void;
  onResume: () => void;
  onRename: (title: string) => void;
  onFork: () => void;
  onClose: () => void;
  /** Opens Workspace settings (M2-08…M2-17) for this session's folder, or one of its workspace's other folders. */
  onOpenSetup: (dir?: string) => void;
  /** The right panel's tab when it opens (self-test screenshots). */
  panelTab?: PanelTab | undefined;
  /** Right-panel tabs the user hid (`panelTabs.ts`). */
  hiddenTabs: readonly PanelTab[];
  onHiddenTabsChange: (hidden: PanelTab[]) => void;
  /** Shows the first changed file's diff once the listing arrives (self-test screenshots). */
  showFirstChange?: boolean;
  /** Opens a workspace-relative or absolute path in the user's editor (M1-28). */
  onOpenFile: (path: string, line?: number) => void;
  confirm: Confirm;
}) {
  /** The file shown in the diff, relative to the workspace. */
  const [selected, setSelected] = useState<string | null>(null);
  /** The app being built, in the right panel (UX-22): the address shown, and how often Open preview was asked. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewOpened, setPreviewOpened] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const detected = useMemo(() => previewUrls(tab.items), [tab.items]);
  // Only the newest address is offered; the pane lists the others.
  const latest = detected[0];
  const offer = latest && latest !== previewUrl && !dismissed.includes(latest) ? latest : undefined;
  function openPreview(url: string) {
    setPreviewUrl(url);
    setPreviewOpened((n) => n + 1);
    setSelected(null);
    if (!rightOpen) onToggleRight();
  }
  const [seed, setSeed] = useState<{ text: string; append?: boolean } | null>(null);
  // Comments on the diff's lines (CP-05), on any file, until they go into the message.
  const [comments, setComments] = useState<DiffComment[]>([]);
  const sendComments = () => {
    if (!comments.length) return;
    const text = feedbackMessage(comments, {
      header: t("panel.diff.feedbackHeader"),
      where: (c) => {
        const where = c.dir && c.dir !== tab.cwd ? joinPath(c.dir, c.path) : c.path;
        const count = c.end - c.start + 1;
        return c.side === "old"
          ? t("panel.diff.feedbackOld", { path: where, start: c.start, end: c.end, count })
          : t("panel.diff.feedbackNew", { path: where, start: c.start, end: c.end, count });
      },
    });
    setSeed({ text, append: true });
    setComments([]);
  };
  const [view, setView] = useState<SessionMode>("chat");
  /** The subagent shown in the right panel's drawer (M4-03). */
  const [agentId, setAgentId] = useState<string | null>(null);
  const agent = agentId ? findAgent(tab.items, (a) => a.id === agentId) : undefined;
  const waiting = useMemo(() => new Set(tab.permissions.map((p) => p.toolUseId)), [tab.permissions]);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Follow new output only while the reader is at the bottom; reading earlier output isn't interrupted (UX-04).
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const right = usePanelRef();
  /** The right panel's width before a diff widened it. */
  const narrow = useRef<number | null>(null);
  /** The folder the right panel shows: a multi-folder workspace's session can switch to its other folders (M8-01). */
  const [panelDir, setPanelDir] = useState(tab.cwd);
  const dirs = useMemo(() => [tab.cwd, ...(tab.folders ?? [])], [tab.cwd, tab.folders]);
  const workspace = useWorkspace(panelDir, !hidden);
  const { refresh } = workspace;
  const paths = useMemo(() => workspace.files?.files.map((f) => f.path) ?? [], [workspace.files]);
  const warning = budgetWarning(tab);
  const questions = tab.permissions.filter((p) => p.toolName === "AskUserQuestion");
  const todos = useMemo(() => latestTodos(tab.items), [tab.items]);
  const planSwitch = tab.planSwitch && tab.mode === "plan" ? tab.planSwitch : null;
  // Until the first message, the composer sits mid-screen with starters below; the children of `.chat` keep their
  // positions either way, so the composer never remounts and keeps its draft.
  // The composer and what goes with it belong to the Chat view; the graph and the timeline get the whole column.
  const fresh = isFresh(tab) && view === "chat";
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
  useEffect(() => {
    if (following.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [tab.items]);
  const jumpToLatest = () => {
    following.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ block: "end" });
  };

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

  // Esc stops the running turn (M1-14), unless a dialog or menu is open: there it closes that instead. An open agent
  // drawer closes first, so closing it never stops the whole turn.
  const selectAgent = (id: string | null) => {
    setAgentId(id);
    if (id && !rightOpen) onToggleRight();
  };
  const drawerOpen = agentId !== null;
  useEffect(() => {
    if (hidden || (!tab.running && !drawerOpen)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || layerOpen()) return;
      if (drawerOpen) setAgentId(null);
      else onInterrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, tab.running, drawerOpen, onInterrupt]);

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
              view={view}
              onViewChange={setView}
              branch={workspace.files?.branch ?? null}
              terminalOpen={terminalOpen}
              rightOpen={rightOpen}
              onToggleTerminal={onToggleTerminal}
              onToggleRight={onToggleRight}
              onRename={onRename}
              onFork={onFork}
              onClose={onClose}
              onOpenSetup={() => onOpenSetup()}
            />
            {warning && <div className="banner">{warning}</div>}
            <Group
              orientation="vertical"
              className="center-split"
              defaultLayout={vsplit.defaultLayout}
              onLayoutChanged={vsplit.onLayoutChanged}
            >
              <Panel id="chat" minSize={200}>
                <div className={`chat${fresh ? " fresh" : ""}`}>
                  {view === "graph" && (
                    <Suspense fallback={<div className="session-graph muted">{t("session.view.loadingGraph")}</div>}>
                      <SessionGraph
                        items={tab.items}
                        running={tab.running}
                        waiting={waiting}
                        selected={agent ? agent.id : null}
                        onSelect={selectAgent}
                        model={tab.model}
                        cwd={tab.cwd}
                      />
                    </Suspense>
                  )}
                  {view === "timeline" && (
                    <SessionTimeline
                      items={tab.items}
                      waits={tab.waits}
                      running={tab.running}
                      selected={agent ? agent.id : null}
                      onSelect={selectAgent}
                    />
                  )}
                  <div
                    className="transcript-scroll"
                    hidden={view !== "chat"}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                      following.current = near;
                      setAtBottom(near);
                    }}
                  >
                    <div className="transcript">
                      <TranscriptView
                        cwd={tab.cwd}
                        items={tab.items}
                        onOpenFile={(file) => onOpenFile(file)}
                        {...(tab.running || tab.ended || tab.agent ? {} : { onRewind })}
                      />
                      {tab.running && (
                        <div className="working">
                          <Loader2 size={14} className="spin" aria-hidden />
                          <Rich k="session.view.working" tags={{ kbd: (s) => <kbd>{s}</kbd> }} />
                        </div>
                      )}
                      <div ref={bottomRef} />
                    </div>
                    {!atBottom && (
                      <button type="button" className="secondary small jump-latest" onClick={jumpToLatest}>
                        <ArrowDown size={13} />
                        {t("session.view.jumpToLatest")}
                      </button>
                    )}
                  </div>
                  <div className="chat-dock" hidden={view !== "chat"}>
                    {fresh ? (
                      <div className="fresh-heading">
                        <h2>{t("session.view.freshHeading")}</h2>
                        <p className="muted">{t("session.view.freshHint")}</p>
                      </div>
                    ) : null}
                    {planSwitch && (
                      <div className="plan-switch" role="status">
                        <ClipboardList size={14} aria-hidden />
                        <span className="grow">{t("session.view.planSwitched", { mode: MODE_NAMES.plan })}</span>
                        <button
                          type="button"
                          className="secondary small"
                          onClick={() => onModeChange(planSwitch.previous)}
                        >
                          {t("session.view.backToMode", { mode: MODE_NAMES[planSwitch.previous] })}
                        </button>
                      </div>
                    )}
                    {questions.map((q) => (
                      <QuestionCard key={q.requestId} request={q} onAnswer={(a) => onAnswer(q, a)} />
                    ))}
                    {todos && todos.length > 0 && <TodoPanel todos={todos} />}
                  </div>
                  {tab.background.length > 0 && (
                    <BackgroundTasks
                      tasks={tab.background}
                      onStop={onStopAgent}
                      onOpen={(taskId) => {
                        const a = findAgent(tab.items, (x) => x.taskId === taskId);
                        if (a) selectAgent(a.id);
                      }}
                    />
                  )}
                  <div className="chat-dock" hidden={view !== "chat"}>
                    {/* A server the chat started (UX-22): its page can show in the right panel. */}
                    {offer && (
                      <div className="preview-offer" role="status">
                        <Globe size={13} aria-hidden />
                        <span className="grow">{t("session.preview.offer", { url: offer })}</span>
                        <button type="button" className="secondary small" onClick={() => openPreview(offer)}>
                          {t("session.preview.open")}
                        </button>
                        <IconButton
                          label={t("session.preview.dismiss")}
                          className="tiny"
                          onClick={() => setDismissed((d) => [...d, offer])}
                        >
                          <X size={12} />
                        </IconButton>
                      </div>
                    )}
                    <Composer
                      tab={tab}
                      active={!hidden && view === "chat"}
                      files={paths}
                      seed={seed}
                      onSend={(text, images) => {
                        jumpToLatest();
                        onSend(text, images);
                      }}
                      onCommand={onCommand}
                      {...(onTask ? { onTask } : {})}
                      onTeam={onTeam}
                      onInterrupt={onInterrupt}
                      onResume={onResume}
                      onModeChange={onModeChange}
                      onModelChange={onModelChange}
                      onEffortChange={onEffortChange}
                    />
                    {fresh ? <StarterChips onPick={(text) => setSeed({ text })} /> : null}
                    {fresh ? <div className="fresh-spacer" /> : null}
                  </div>
                </div>
              </Panel>
              {terminalOpen && <Separator className="resize-handle" aria-label={t("session.view.resizeTerminal")} />}
              {terminalOpen && (
                <Panel id="terminal" defaultSize={220} minSize={100} groupResizeBehavior="preserve-pixel-size">
                  <Suspense fallback={<div className="terminal-host muted">{t("session.view.loadingTerminal")}</div>}>
                    <TerminalPanel cwd={tab.cwd} />
                  </Suspense>
                </Panel>
              )}
            </Group>
            <footer className="statusbar">
              <span>{tab.model ?? "…"}</span>
              <span className="mode-label" data-mode={tab.mode}>
                {MODE_NAMES[tab.mode]}
              </span>
              <span className="grow" />
              {tab.context && (
                <span
                  className={tab.context.percentage >= 80 ? "context-meter warn" : "context-meter"}
                  title={t(
                    tab.context.percentage >= 80 ? "session.view.contextTitleFull" : "session.view.contextTitle",
                    { used: count(tab.context.totalTokens), max: count(tab.context.maxTokens) },
                  )}
                >
                  {t("session.view.context", { percent: Math.round(tab.context.percentage) })}
                </span>
              )}
              <span>{costLabel(tab.cost)}</span>
            </footer>
          </div>
        </Panel>
        {rightOpen && <Separator className="resize-handle" aria-label={t("session.view.resizeRight")} />}
        {rightOpen && (
          <Panel
            id="right"
            panelRef={right}
            defaultSize={380}
            minSize={280}
            maxSize="75%"
            groupResizeBehavior="preserve-pixel-size"
          >
            <aside className="right-panel" aria-label={t("session.view.workspace")}>
              <div className="right-tabs" hidden={selected !== null || agent !== undefined}>
                <FolderSwitcher
                  folders={dirs}
                  current={panelDir}
                  onChange={(dir) => {
                    setSelected(null);
                    setPanelDir(dir);
                  }}
                />
                <Suspense fallback={<p className="muted panel-loading">{t("session.view.loading")}</p>}>
                  <WorkspacePanel
                    key={panelTab}
                    {...(panelTab ? { initialTab: panelTab } : {})}
                    cwd={panelDir}
                    files={workspace.files}
                    error={workspace.error}
                    items={tab.items}
                    selected={selected}
                    confirm={confirm}
                    onSelect={setSelected}
                    onOpenFile={(path) => onOpenFile(joinPath(panelDir, path))}
                    onRefresh={() => void refresh()}
                    onOpenSetup={() => onOpenSetup(panelDir)}
                    hiddenTabs={hiddenTabs}
                    onHiddenTabsChange={onHiddenTabsChange}
                    onHidePanel={onToggleRight}
                    preview={{
                      url: previewUrl,
                      detected,
                      opened: previewOpened,
                      onUrlChange: setPreviewUrl,
                    }}
                    comments={comments.length}
                    onSendComments={sendComments}
                  />
                </Suspense>
              </div>
              {agent && !selected && (
                <AgentDrawer
                  cwd={tab.cwd}
                  agent={agent}
                  cost={tab.cost}
                  canStop={tab.running || tab.background.some((b) => b.taskId === agent.taskId)}
                  waiting={agent.children.some((c) => c.kind === "tool" && waiting.has(c.id))}
                  onStop={onStopAgent}
                  onClose={() => setAgentId(null)}
                  onOpenFile={(file) => onOpenFile(file)}
                />
              )}
              {selected && (
                <Suspense fallback={<p className="muted">{t("session.view.loadingDiff")}</p>}>
                  {/* An image shows as a picture, not as text (UX-21). */}
                  {imageType(selected) ? (
                    <ImageView
                      cwd={panelDir}
                      path={selected}
                      version={workspace.files}
                      status={workspace.files?.files.find((f) => f.path === selected)?.status}
                      onClose={() => setSelected(null)}
                      onOpenInEditor={() => onOpenFile(joinPath(panelDir, selected))}
                    />
                  ) : (
                    <DiffView
                      cwd={panelDir}
                      path={selected}
                      version={workspace.files}
                      confirm={confirm}
                      onClose={() => setSelected(null)}
                      onOpenInEditor={(line) => onOpenFile(joinPath(panelDir, selected), line)}
                      comments={comments.filter((c) => (c.dir ?? tab.cwd) === panelDir)}
                      onComment={(c) =>
                        setComments((all) => [
                          ...all,
                          { ...c, id: crypto.randomUUID(), ...(panelDir !== tab.cwd ? { dir: panelDir } : {}) },
                        ])
                      }
                      onRemoveComment={(id) => setComments((all) => all.filter((c) => c.id !== id))}
                      onSendComments={sendComments}
                    />
                  )}
                </Suspense>
              )}
            </aside>
          </Panel>
        )}
      </Group>
    </div>
  );
}

/** Starter prompts under a new session's composer (UX-06); picking one fills the composer. */
function StarterChips({ onPick }: { onPick: (text: string) => void }) {
  // The person's own words once picked, so in the UI's language.
  const starters = [
    t("session.starters.explain"),
    t("session.starters.findBug"),
    t("session.starters.addTests"),
    t("session.starters.review"),
  ];
  return (
    <div className="starter-chips">
      {starters.map((text) => (
        <button key={text} type="button" className="secondary small" onClick={() => onPick(text)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const usd = (v: number) => approxUsd(v, 4);
const kTokens = (n: number) => (n >= 1000 ? thousands((n / 1000).toFixed(1)) : String(n));

/** Per-turn and per-session cost, tokens and duration (M1-31), labeled as estimates. */
function costLabel(cost: Cost): string {
  const parts: string[] = [];
  if (cost.lastUsd !== null)
    parts.push(t("session.cost.lastTurn", { cost: usd(cost.lastUsd), time: seconds((cost.lastMs / 1000).toFixed(1)) }));
  if (cost.lastTokens)
    parts.push(
      t("session.cost.tokens", { input: kTokens(cost.lastTokens.input), output: kTokens(cost.lastTokens.output) }),
    );
  parts.push(t("session.cost.session", { cost: cost.totalUsd === null ? "–" : usd(cost.totalUsd) }));
  return t("session.cost.estimate", { parts: parts.join(" · ") });
}
