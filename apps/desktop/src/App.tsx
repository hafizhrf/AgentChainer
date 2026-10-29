import {
  type AgentEvent,
  EFFORTS,
  type Effort,
  type EnvCheck,
  type Methods,
  type PermissionMode,
  type PermissionRequest,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type SessionInfo,
} from "@agentchainer/protocol";
import * as Tooltip from "@radix-ui/react-tooltip";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { applyTheme } from "./appearance.ts";
import type { Attachment } from "./Composer.tsx";
import { useConfirm } from "./Dialog.tsx";
import { joinPath } from "./files.ts";
import { HomeView, pickFolder } from "./HomeView.tsx";
import { type PermissionAnswer, PermissionDialog } from "./PermissionDialog.tsx";
import { SessionView } from "./SessionView.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { quitApp, readSelftestConfig, runSelftest } from "./selftest.ts";
import { loadSettings, type Settings, saveSettings, withRecent } from "./settings.ts";
import type { SetupView } from "./setup/SetupPage.tsx";
import { connect, isRpcError, onExit, onReady, request, requestWithTimeout, subscribe } from "./sidecar.ts";
import { asMode, folderName, newTab, type Tab, tabEvent, updateTab } from "./tabs.ts";
import { asTheme } from "./theme.ts";
import { applyEvent, closeAssistant, type Item, nextId, setMessageId } from "./transcript.ts";
import { IconButton } from "./ui/IconButton.tsx";
import { layoutStorage, usePersistentFlag } from "./ui/layoutStorage.ts";
import { useMenuCommands } from "./useMenuCommands.ts";
import type { PanelTab } from "./WorkspacePanel.tsx";

// The setup page shares the file-type icon set with the workspace panel; both load on first use.
const SetupPage = lazy(() => import("./setup/SetupPage.tsx").then((m) => ({ default: m.SetupPage })));

/** Guards against React StrictMode running the mount effect twice in dev. */
let selftestStarted = false;

const PING_EVERY_MS = 20_000;
const PING_TIMEOUT_MS = 5_000;
const NEW_TITLE = "New session";

// App shell (M1-01…M1-07, UX-03): sidebar, then Home or the active session. One live session per tab (M1-06/M1-08),
// stored sessions (M1-21…M1-24), and the native menu's commands (UX-07).

type Hello = Methods["system.hello"]["result"];
type TurnCompleted = Extract<AgentEvent, { type: "turn.completed" }>;

const notice = (text: string): Item => ({ kind: "notice", id: nextId(), text });

export function App() {
  const [hello, setHello] = useState<Hello | null>(null);
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [tabs, setTabs] = useState<Tab[]>([]);
  /** The active tab's session id; null shows the new-session screen. */
  const [active, setActive] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = usePersistentFlag("agentchainer.sidebar", true);
  const [rightOpen, setRightOpen] = usePersistentFlag("agentchainer.right", true);
  /** Sessions whose terminal is open. */
  const [terminals, setTerminals] = useState<Set<string>>(new Set());
  /** The workspace setup page, open over the session it came from (or Home when `back` is null). */
  const [setup, setSetup] = useState<{
    cwd: string;
    model: string;
    back: string | null;
    view?: SetupView;
  } | null>(null);
  /** Self-test screenshots only: the right panel's tab. */
  const [panelTab, setPanelTab] = useState<PanelTab | undefined>(undefined);
  const shell = useDefaultLayout({
    id: "agentchainer.shell",
    panelIds: sidebarOpen ? ["sidebar", "main"] : ["main"],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  });
  /** Mirrors `tabs` for async code that outlives a render (the self-test). */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** Self-test only: resolves when a session's turn completes. */
  const turnWaiters = useRef(new Map<string, (e: TurnCompleted) => void>());
  /** True while the sidecar answers; the health ping only runs then, so a starting sidecar isn't restarted. */
  const alive = useRef(false);

  const patchTab = (sessionId: string, fn: (tab: Tab) => Tab) => setTabs((ts) => updateTab(ts, sessionId, fn));
  const addNotice = (sessionId: string, text: string) =>
    patchTab(sessionId, (t) => ({ ...t, items: [...closeAssistant(t.items), notice(text)] }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once on mount; the handlers only call state setters, which are stable.
  useEffect(() => {
    void invoke<{ version: string }>("app_info")
      .then((info) => setAppVersion(info.version))
      .catch(() => undefined);
    connect()
      .then(() => Promise.all([loadSettings(), handshake()]))
      .then(async ([loaded, checked]) => {
        applySettings(loaded);
        const cfg = await readSelftestConfig();
        if (!cfg || !checked.ready || selftestStarted) return;
        selftestStarted = true;
        setCwd(cfg.cwd);
        const report = await runSelftest(cfg, {
          start: (dir, modelAlias) => startSession(dir, modelAlias, "default"),
          send: sendText,
          nextTurn: (sessionId) => new Promise((resolve) => turnWaiters.current.set(sessionId, resolve)),
          close: async (sessionId) => {
            await request("session.close", { sessionId });
          },
          resume: (sessionId, dir, modelAlias) => resume(sessionId, dir, "Self-test", modelAlias),
          tab: (sessionId) => tabsRef.current.find((t) => t.sessionId === sessionId),
        }).catch((err: unknown) => ({ error: String(err) }));
        await request("debug.log", { message: JSON.stringify({ selftest: report }) });
        if (!cfg.stay) return quitApp();
        if (cfg.theme) applyTheme(cfg.theme);
        if (cfg.open === "home") setActive(null);
        if (cfg.open === "settings") setSettingsOpen(true);
        const first = tabsRef.current[0];
        if (cfg.open === "terminal" && first) toggleTerminal(first.sessionId);
        if (cfg.open === "files" || cfg.open === "git") setPanelTab(cfg.open);
        if ((cfg.open === "setup" || cfg.open === "plan") && first)
          setSetup({
            cwd: first.cwd,
            model: first.modelAlias,
            back: first.sessionId,
            view: cfg.open === "plan" ? "plan" : "overview",
          });
      })
      .catch((err: unknown) => setRuntimeNotice(String(err)));

    // Supervisor events (M1-01): sessions die with the process. Their tabs stay, marked ended, and can be resumed.
    const offExit = onExit((exit) => {
      alive.current = false;
      setTabs((ts) =>
        ts.map((t) =>
          t.ended
            ? t
            : {
                ...t,
                ended: true,
                running: false,
                permissions: [],
                items: [...closeAssistant(t.items), notice("The agent runtime stopped.")],
              },
        ),
      );
      setRuntimeNotice(
        `The agent runtime stopped (${exit.status})${exit.restarting ? " and is restarting…" : "."} Running sessions ended; resume them from their tabs.`,
      );
    });
    const offReady = onReady(() => {
      void handshake()
        .then(() =>
          setRuntimeNotice((n) => (n ? "The agent runtime restarted. Resume your sessions from their tabs." : null)),
        )
        .catch(() => undefined);
    });
    const offEvents = subscribe((n) => {
      if (n.method === "permission.request") {
        patchTab(n.params.sessionId, (t) => ({ ...t, permissions: [...t.permissions, n.params] }));
        return;
      }
      const { sessionId, event } = n.params;
      if (event.type === "turn.completed") recordCost(sessionId, event);
      if (event.type === "turn.completed") {
        turnWaiters.current.get(sessionId)?.(event);
        turnWaiters.current.delete(sessionId);
      }
      patchTab(sessionId, (t) => tabEvent(t, event, Date.now()));
    });
    const ping = setInterval(() => {
      if (!alive.current) return;
      requestWithTimeout("system.ping", {}, PING_TIMEOUT_MS).catch(() => {
        alive.current = false;
        void invoke("sidecar_restart");
      });
    }, PING_EVERY_MS);
    return () => {
      offExit();
      offReady();
      offEvents();
      clearInterval(ping);
    };
  }, []);

  async function handshake(): Promise<EnvCheck> {
    const h = await request("system.hello", { protocolVersion: PROTOCOL_VERSION });
    if (h.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Protocol mismatch: app v${PROTOCOL_VERSION}, agent runtime v${h.protocolVersion}. Reinstall AgentChainer.`,
      );
    }
    setHello(h);
    alive.current = true;
    return recheck();
  }

  async function recheck(): Promise<EnvCheck> {
    setChecking(true);
    try {
      const checked = await request("env.check", {});
      setEnv(checked);
      return checked;
    } finally {
      setChecking(false);
    }
  }

  function applySettings(next: Settings) {
    setSettings(next);
    setModel(next.defaultModel ?? "");
    setMode(asMode(next.defaultMode));
    applyTheme(asTheme(next.theme));
  }

  async function onSaveSettings(next: Settings) {
    const saved = await saveSettings(next);
    const claudePathChanged = saved.claudePath !== settings?.claudePath;
    applySettings(saved);
    // The CLI path reaches the sidecar as an env var at spawn, so a change needs a restart (ready → re-check).
    if (claudePathChanged) {
      alive.current = false;
      await invoke("sidecar_restart");
    }
  }

  /** Local cost history (M1-33); the turn's own cost is known unless the session was resumed in this tab. */
  function recordCost(sessionId: string, e: TurnCompleted) {
    const tab = tabsRef.current.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    const prevTokens = tab.cost.totalTokens;
    const tokens = e.usage
      ? {
          input: e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheCreationTokens,
          output: e.usage.outputTokens,
        }
      : null;
    const turn = {
      sessionId,
      cwd: tab.cwd,
      at: Date.now(),
      totalCostUsd: e.totalCostUsd,
      deltaUsd: tab.cost.totalUsd === null ? null : Math.max(0, e.totalCostUsd - tab.cost.totalUsd),
      durationMs: Math.round(e.durationMs),
      inputTokens: tokens && prevTokens ? tokens.input - prevTokens.input : null,
      outputTokens: tokens && prevTokens ? tokens.output - prevTokens.output : null,
      model: tab.model ?? null,
      subtype: e.subtype,
    };
    void invoke("cost_record", { turn }).catch((err: unknown) => console.warn(`cost history: ${err}`));
  }

  /** "Export diagnostics" (M1-35): the core redacts and writes; the UI adds its handshake and readiness check. */
  async function exportDiagnostics(): Promise<string | null> {
    const path = await save({
      defaultPath: "agentchainer-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return null;
    await invoke("diagnostics_export", { path, ui: { hello, env } });
    return path;
  }

  async function rememberWorkspace(dir: string) {
    if (settings) setSettings(await saveSettings(withRecent(settings, dir)));
  }

  /** Effort and budget for a new or resumed session, from settings (M1-15/M1-32). */
  function sessionOptions(mode: PermissionMode) {
    const effort = EFFORTS.find((e) => e === settings?.defaultEffort) ?? null;
    const budgetUsd = settings?.budgetUsd ?? null;
    if (mode === "auto" && budgetUsd === null) {
      throw new Error("The Autonomous profile needs a budget cap. Set one in Settings, or pick another profile.");
    }
    return { effort, budgetUsd, showThinking: settings?.showThinking !== false };
  }

  /**
   * Opt-in auto-apply before a new session (M2-18): the sidecar applies only safe actions. Returns notices for the
   * transcript; a failure never blocks the session.
   */
  async function autoApply(dir: string): Promise<string[]> {
    try {
      const { runId, results } = await request("bootstrap.autoApply", { cwd: dir });
      if (!runId) return [];
      const { runs } = await request("bootstrap.runs", { cwd: dir });
      const titles = new Map(runs.find((r) => r.runId === runId)?.actions.map((a) => [a.id, a.title]) ?? []);
      const applied = results.filter((r) => r.status === "applied").map((r) => titles.get(r.id) ?? r.id);
      return [
        ...(applied.length
          ? [`Applied automatically: ${applied.join(", ")}. Roll back in Workspace setup → History.`]
          : []),
        ...results
          .filter((r) => r.status === "failed")
          .map((r) => `Auto-apply couldn't apply ${titles.get(r.id) ?? r.id}: ${r.message ?? "unknown error"}`),
      ];
    } catch (err) {
      return [`Auto-apply didn't run: ${err}`];
    }
  }

  async function startSession(dir: string, modelAlias: string, mode: PermissionMode): Promise<string | null> {
    try {
      const { effort, budgetUsd, showThinking } = sessionOptions(mode);
      // Before the session starts, so what's applied (plugins, settings) is there from its first turn.
      const applied = settings?.autoApply ? await autoApply(dir) : [];
      const { sessionId } = await request("session.start", {
        cwd: dir,
        permissionMode: mode,
        ...(modelAlias ? { model: modelAlias } : {}),
        ...(effort ? { effort } : {}),
        ...(budgetUsd ? { maxBudgetUsd: budgetUsd } : {}),
        showThinking,
      });
      const items = [notice(`Session started in ${folderName(dir)}`), ...applied.map(notice)];
      setTabs((ts) => [
        ...ts,
        newTab(sessionId, dir, { title: NEW_TITLE, mode, items, modelAlias, effort, budgetUsd }),
      ]);
      setActive(sessionId);
      setRuntimeNotice(null);
      await rememberWorkspace(dir);
      return sessionId;
    } catch (err) {
      setRuntimeNotice(String(err));
      return null;
    }
  }

  /** Resumes a stored session into a tab: replaces its ended tab, or opens a new one (M1-22). */
  async function resume(sessionId: string, dir: string, title: string, modelAlias = model) {
    const mode = asMode(settings?.defaultMode);
    try {
      const { effort, budgetUsd, showThinking } = sessionOptions(mode);
      const { events } = await request("session.history", { cwd: dir, sessionId });
      await request("session.start", {
        cwd: dir,
        resume: sessionId,
        permissionMode: mode,
        ...(modelAlias ? { model: modelAlias } : {}),
        ...(effort ? { effort } : {}),
        ...(budgetUsd ? { maxBudgetUsd: budgetUsd } : {}),
        showThinking,
      });
      const items = closeAssistant(
        events.reduce<Item[]>((acc, e) => applyEvent(acc, e), [notice(`Resumed “${title}” in ${folderName(dir)}`)]),
      );
      const tab = newTab(sessionId, dir, { title, mode, items, resumed: true, modelAlias, effort, budgetUsd });
      setTabs((ts) => (ts.some((t) => t.sessionId === sessionId) ? updateTab(ts, sessionId, () => tab) : [...ts, tab]));
      setActive(sessionId);
      await rememberWorkspace(dir);
    } catch (err) {
      setRuntimeNotice(String(err));
    }
  }

  function openStored(s: SessionInfo) {
    const open = tabs.find((t) => t.sessionId === s.sessionId);
    if (open && !open.ended) setActive(s.sessionId);
    else void resume(s.sessionId, cwd.trim(), s.title);
  }

  async function sendText(sessionId: string, text: string, images: Attachment[] = []) {
    const itemId = nextId();
    patchTab(sessionId, (t) => ({
      ...t,
      running: true,
      title: t.title === NEW_TITLE ? text.slice(0, 60) : t.title,
      items: [
        ...closeAssistant(t.items),
        { kind: "user", id: itemId, text, ...(images.length ? { images: images.map((i) => i.preview) } : {}) },
      ],
    }));
    try {
      const { messageId } = await request("session.send", {
        sessionId,
        text,
        ...(images.length ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}),
      });
      patchTab(sessionId, (t) => ({ ...t, items: setMessageId(t.items, itemId, messageId) }));
    } catch (err) {
      patchTab(sessionId, (t) => ({
        ...t,
        running: false,
        ended: t.ended || isRpcError(err, RpcErrorCode.noSession),
        items: [...t.items, notice(String(err))],
      }));
    }
  }

  async function changeMode(sessionId: string, mode: PermissionMode) {
    if (mode === "auto" && tabs.find((t) => t.sessionId === sessionId)?.budgetUsd === null) {
      addNotice(sessionId, "Autonomous needs a budget cap: set one in Settings, then start or resume the session.");
      return;
    }
    try {
      await request("session.setMode", { sessionId, mode });
      patchTab(sessionId, (t) => ({ ...t, mode }));
    } catch (err) {
      addNotice(sessionId, String(err));
    }
  }

  /** Model and effort switches (M1-15) apply from the next turn. */
  async function changeModel(sessionId: string, alias: string) {
    try {
      await request("session.setModel", { sessionId, model: alias });
      patchTab(sessionId, (t) => ({ ...t, modelAlias: alias }));
    } catch (err) {
      addNotice(sessionId, String(err));
    }
  }

  async function changeEffort(sessionId: string, effort: Effort | null) {
    try {
      await request("session.setEffort", { sessionId, effort });
      patchTab(sessionId, (t) => ({ ...t, effort }));
    } catch (err) {
      addNotice(sessionId, String(err));
    }
  }

  async function answer(req: PermissionRequest, reply: PermissionAnswer) {
    patchTab(req.sessionId, (t) => ({
      ...t,
      permissions: t.permissions.filter((p) => p.requestId !== req.requestId),
      // An approved plan runs in the mode the user picked (M1-16).
      ...(reply.allow && reply.mode && req.toolName === "ExitPlanMode" ? { mode: reply.mode } : {}),
    }));
    try {
      await request("permission.respond", { sessionId: req.sessionId, requestId: req.requestId, ...reply });
    } catch (err) {
      addNotice(req.sessionId, String(err));
    }
  }

  /** "Rewind files to here" (M1-23): preview, confirm with the documented limits, then restore. */
  async function rewind(sessionId: string, messageId: string) {
    try {
      const preview = await request("session.rewind", { sessionId, messageId, dryRun: true });
      if (!preview.canRewind) {
        addNotice(sessionId, `Can't rewind files to this message: ${preview.error ?? "no checkpoint was saved."}`);
        return;
      }
      if (preview.filesChanged.length === 0) {
        addNotice(sessionId, "Nothing to rewind: the files the agent edited already match this point.");
        return;
      }
      const ok = await confirm({
        title: "Rewind files to before this message?",
        body: (
          <>
            <p>
              These files go back to how they were before this message (+{preview.insertions} / −{preview.deletions}{" "}
              lines):
            </p>
            <ul className="file-list">
              {preview.filesChanged.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            <p className="muted">
              Only edits made with Claude's file tools (Edit, Write) are restored. Changes made by shell commands, and
              files behind symlinks, are not. The conversation itself is not rewound.
            </p>
          </>
        ),
        confirmLabel: "Rewind files",
        danger: true,
      });
      if (!ok) return;
      const done = await request("session.rewind", { sessionId, messageId });
      addNotice(
        sessionId,
        done.canRewind
          ? `Rewound ${done.filesChanged.length} file(s) to before that message.`
          : `Rewind failed: ${done.error ?? "unknown error"}`,
      );
    } catch (err) {
      addNotice(sessionId, String(err));
    }
  }

  /** "Open in editor" (M1-28) with the editor from settings; relative paths are inside the tab's workspace. */
  async function openInEditor(sessionId: string, dir: string, file: string, line?: number) {
    const abs = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) ? file : joinPath(dir, file);
    try {
      await invoke("open_in_editor", { file: abs, line: line ?? null, editor: settings?.editor ?? "system" });
    } catch (err) {
      addNotice(sessionId, `Couldn't open ${file}: ${err}`);
    }
  }

  function closeTab(sessionId: string) {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (tab && !tab.ended) void request("session.close", { sessionId }).catch(() => undefined);
    const rest = tabs.filter((t) => t.sessionId !== sessionId);
    setTabs(rest);
    setTerminals((open) => withToggled(open, sessionId, false));
    if (active === sessionId) setActive(rest.at(-1)?.sessionId ?? null);
  }

  /** Renames the session in the SDK's session store too, so the stored list shows the same title (M1-24). */
  async function renameTab(sessionId: string, title: string) {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    patchTab(sessionId, (t) => ({ ...t, title }));
    try {
      await request("session.rename", { cwd: tab.cwd, sessionId, title });
    } catch (err) {
      addNotice(sessionId, `The new title is only kept in this window: ${err}`);
    }
  }

  /** Forks a session (M1-24) and opens the copy in a new tab. */
  async function forkTab(sessionId: string) {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    try {
      const forked = await request("session.fork", { cwd: tab.cwd, sessionId });
      await resume(forked.sessionId, tab.cwd, `${tab.title} (fork)`, tab.modelAlias);
    } catch (err) {
      addNotice(sessionId, `Couldn't fork: ${err}`);
    }
  }

  /** Shows a session, or Home for null; closes the setup page if it's open. */
  function show(sessionId: string | null) {
    setSetup(null);
    setActive(sessionId);
  }

  function openWorkspace(dir: string) {
    setCwd(dir);
    show(null);
  }

  async function openFolder() {
    const dir = await pickFolder();
    if (dir) openWorkspace(dir);
  }

  async function exportFromMenu() {
    try {
      const path = await exportDiagnostics();
      if (path) setRuntimeNotice(`Diagnostics saved to ${path}. Secrets, emails and your home folder are masked.`);
    } catch (err) {
      setRuntimeNotice(`Export failed: ${err}`);
    }
  }

  const toggleTerminal = (sessionId: string) =>
    setTerminals((open) => withToggled(open, sessionId, !open.has(sessionId)));

  useMenuCommands({
    "new-session": () => show(null),
    "open-folder": () => void openFolder(),
    "close-session": () => active && closeTab(active),
    settings: () => setSettingsOpen(true),
    "toggle-sidebar": () => setSidebarOpen((v) => !v),
    "toggle-right-panel": () => setRightOpen((v) => !v),
    "toggle-terminal": () => active && toggleTerminal(active),
    "export-diagnostics": () => void exportFromMenu(),
  });

  const activeTab = tabs.find((t) => t.sessionId === active);
  const permission = activeTab?.permissions[0];
  const workspace = cwd.trim();

  return (
    <Tooltip.Provider delayDuration={400}>
      <div className="app">
        <Group
          orientation="horizontal"
          className="shell"
          defaultLayout={shell.defaultLayout}
          onLayoutChanged={shell.onLayoutChanged}
        >
          {sidebarOpen && (
            <Panel id="sidebar" defaultSize={248} minSize={200} maxSize={400} groupResizeBehavior="preserve-pixel-size">
              <Sidebar
                tabs={tabs}
                active={active}
                recent={settings?.recentWorkspaces ?? []}
                ready={env ? env.ready : null}
                onNew={() => show(null)}
                onSelect={show}
                onClose={closeTab}
                onOpenWorkspace={openWorkspace}
                onSettings={() => setSettingsOpen(true)}
              />
            </Panel>
          )}
          {sidebarOpen && <Separator className="resize-handle" />}
          <Panel id="main" minSize={480}>
            <main className="main">
              {runtimeNotice && (
                <div className="banner" role="status">
                  <span className="grow">{runtimeNotice}</span>
                  <IconButton label="Dismiss" onClick={() => setRuntimeNotice(null)}>
                    <X size={14} />
                  </IconButton>
                </div>
              )}
              <div className="main-body">
                {active === null && !setup && (
                  <HomeView
                    env={env}
                    checking={checking}
                    onRecheck={() => void recheck()}
                    homeDir={hello?.homeDir ?? null}
                    connected={hello !== null}
                    cwd={cwd}
                    onCwdChange={setCwd}
                    recent={settings?.recentWorkspaces ?? []}
                    model={model}
                    onModelChange={setModel}
                    mode={mode}
                    onModeChange={setMode}
                    canAutonomous={settings?.budgetUsd != null}
                    onStart={() => void startSession(workspace, model, mode)}
                    onOpenSetup={() => setSetup({ cwd: workspace, model, back: null })}
                    openIds={new Set(tabs.filter((t) => !t.ended).map((t) => t.sessionId))}
                    onOpenStored={openStored}
                    confirm={confirm}
                  />
                )}
                {tabs.map((t) => (
                  <SessionView
                    key={t.sessionId}
                    tab={t}
                    hidden={t.sessionId !== active || setup !== null}
                    panelTab={panelTab}
                    rightOpen={rightOpen}
                    terminalOpen={terminals.has(t.sessionId)}
                    onToggleRight={() => setRightOpen((v) => !v)}
                    onToggleTerminal={() => toggleTerminal(t.sessionId)}
                    onSend={(text, images) => void sendText(t.sessionId, text, images)}
                    onInterrupt={() => void request("session.interrupt", { sessionId: t.sessionId })}
                    onModeChange={(m) => void changeMode(t.sessionId, m)}
                    onModelChange={(alias) => void changeModel(t.sessionId, alias)}
                    onEffortChange={(effort) => void changeEffort(t.sessionId, effort)}
                    onRewind={(messageId) => void rewind(t.sessionId, messageId)}
                    onResume={() => void resume(t.sessionId, t.cwd, t.title)}
                    onRename={(title) => void renameTab(t.sessionId, title)}
                    onFork={() => void forkTab(t.sessionId)}
                    onClose={() => closeTab(t.sessionId)}
                    onOpenFile={(file, line) => void openInEditor(t.sessionId, t.cwd, file, line)}
                    onOpenSetup={() => setSetup({ cwd: t.cwd, model: t.modelAlias, back: t.sessionId })}
                    confirm={confirm}
                  />
                ))}
                {setup && (
                  <Suspense fallback={<div className="setup-page" />}>
                    <SetupPage
                      key={setup.cwd}
                      cwd={setup.cwd}
                      model={setup.model}
                      backLabel={setup.back ? "Back to session" : "Back to Home"}
                      confirm={confirm}
                      onBack={() => setSetup(null)}
                      {...(setup.view ? { initialView: setup.view } : {})}
                    />
                  </Suspense>
                )}
              </div>
            </main>
          </Panel>
        </Group>

        {permission && activeTab && (
          <PermissionDialog
            key={permission.requestId}
            request={permission}
            canAutonomous={activeTab.budgetUsd !== null}
            onAnswer={(reply) => void answer(permission, reply)}
          />
        )}
        {settingsOpen && settings && (
          <SettingsDialog
            settings={settings}
            hello={hello}
            appVersion={appVersion}
            onSave={onSaveSettings}
            onExportDiagnostics={exportDiagnostics}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {confirmDialog}
      </div>
    </Tooltip.Provider>
  );
}

/** `open` with `id` added (on) or removed (off). */
function withToggled(open: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(open);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}
