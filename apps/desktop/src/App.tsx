import {
  type AgentEvent,
  EFFORTS,
  type Effort,
  type EnvCheck,
  type FleetItem,
  folderKey,
  type Methods,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRequest,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type SessionInfo,
  type Task,
} from "@agentchainer/protocol";
import * as Tooltip from "@radix-ui/react-tooltip";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { applyTheme } from "./appearance.ts";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.tsx";
import type { Attachment } from "./Composer.tsx";
import { APP_COMMANDS, type AppCommand, chatContext, effortFromArg, modeFromArg, modelFromArg } from "./commands.ts";
import { useConfirm } from "./Dialog.tsx";
import { FleetView } from "./FleetView.tsx";
import { joinPath } from "./files.ts";
import { HomeView, pickFolder } from "./HomeView.tsx";
import { MODE_NAMES, modelChoices, rememberModels, THEMES } from "./options.ts";
import { type PermissionAnswer, PermissionDialog } from "./PermissionDialog.tsx";
import { PANEL_TAB_LABEL, PANEL_TABS, type PanelTab, parseHidden, serializeHidden, toggleHidden } from "./panelTabs.ts";
import { SessionView } from "./SessionView.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { FLEET, Sidebar } from "./Sidebar.tsx";
import { quitApp, readSelftestConfig, runSelftest, type SelftestConfig } from "./selftest.ts";
import { loadSettings, type Settings, saveSettings, type WorkspaceDef, withRecent } from "./settings.ts";
import type { SetupView } from "./setup/SetupPage.tsx";
import { connect, isRpcError, onExit, onReady, request, requestWithTimeout, subscribe } from "./sidecar.ts";
import {
  asMode,
  closeWaits,
  folderName,
  isFresh,
  newTab,
  permissionAnswered,
  permissionAsked,
  type Tab,
  tabEvent,
  updateTab,
} from "./tabs.ts";
import { HomeTasks } from "./tasks/HomeTasks.tsx";
import { type TaskTab, taskKey } from "./tasks/taskTabs.ts";
import { asTheme } from "./theme.ts";
import { applyEvent, closeAssistant, type Item, nextId, setMessageId } from "./transcript.ts";
import { UpdateDialog } from "./UpdateDialog.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { layoutStorage, usePersistentFlag, usePersistentValue } from "./ui/layoutStorage.ts";
import { menuShortcut, useMenuCommands } from "./useMenuCommands.ts";
import { WorkspaceDialog, WorkspacesCard } from "./WorkspaceDialog.tsx";

// The setup page shares the file-type icon set with the workspace panel; both load on first use.
const REPO = "https://github.com/hafizhrf/AgentChainer";
const SetupPage = lazy(() => import("./setup/SetupPage.tsx").then((m) => ({ default: m.SetupPage })));
const TaskPage = lazy(() => import("./tasks/TaskPage.tsx").then((m) => ({ default: m.TaskPage })));
// The M4-E2 bench is dev-only; it loads only when a self-test asks for it.
const GraphBench = lazy(() => import("./graph/GraphBench.tsx").then((m) => ({ default: m.GraphBench })));

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
  /** The M4-E2 graph bench, when a self-test asks for it (dev only). */
  const [bench, setBench] = useState<SelftestConfig | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = usePersistentFlag("agentchainer.sidebar", true);
  const [rightOpen, setRightOpen] = usePersistentFlag("agentchainer.right", true);
  const [hiddenTabs, setHiddenTabs] = usePersistentValue<PanelTab[]>(
    "agentchainer.panelTabs.hidden",
    [],
    parseHidden,
    serializeHidden,
  );
  /** Sessions whose terminal is open. */
  const [terminals, setTerminals] = useState<Set<string>>(new Set());
  /** The Workspace settings page, open over the session it came from (or Home when `back` is null). */
  const [setup, setSetup] = useState<{
    cwd: string;
    model: string;
    back: string | null;
    view?: SetupView;
  } | null>(null);
  /** Approvals from task steps' sessions, which have no tab (M3-06), oldest first. */
  const [taskApprovals, setTaskApprovals] = useState<PermissionRequest[]>([]);
  /** Task step sessions' running cost totals, for each turn's spend in cost history. */
  const stepTotals = useRef(new Map<string, number>());
  /** Tasks open as tabs (UX-13), beside the sessions; the active one is `task:<id>` in `active`. */
  const [taskTabs, setTaskTabs] = useState<TaskTab[]>([]);
  /** The named workspace picked on Home (M8-01); it applies while Home's folder is its primary folder. */
  const [wsId, setWsId] = useState<string | null>(null);
  /** The New or Edit workspace dialog. */
  const [wsDialog, setWsDialog] = useState<WorkspaceDef | "new" | null>(null);
  /** Every live session's fleet status, by session id (M8-02); ended ones stay until cleared or the app restarts. */
  const [fleet, setFleet] = useState<Record<string, FleetItem>>({});
  /** For each open task thread, the tasks whose approvals it shows as cards (the task and its sub-tasks). */
  const [shownTasks, setShownTasks] = useState<Record<string, string[]>>({});
  /** Self-test screenshots only: the right panel's tab. */
  const [panelTab, setPanelTab] = useState<PanelTab | undefined>(undefined);
  const [showFirstChange, setShowFirstChange] = useState(false);
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
  /** A task thread reports its task as it changes, for its tab in the sidebar (UX-13). */
  const onTaskChange = useCallback((task: Task, busy: boolean, ids: string[]) => {
    setShownTasks((all) => ({ ...all, [task.id]: ids }));
    setTaskTabs((all) =>
      all.map((t) =>
        t.id === task.id
          ? {
              ...t,
              title: (task.title ?? task.request).slice(0, 60),
              state: task.state,
              busy: busy || task.state === "running",
            }
          : t,
      ),
    );
  }, []);

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
        if (cfg.bench) return setBench(cfg);
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
        if (cfg.open === "diff") {
          setPanelTab("changes");
          setShowFirstChange(true);
        }
        if ((cfg.open === "setup" || cfg.open === "plan" || cfg.open === "permissions") && first)
          setSetup({
            cwd: first.cwd,
            model: first.modelAlias,
            back: first.sessionId,
            view: cfg.open === "setup" ? "overview" : cfg.open,
          });
        // A second session with nothing sent: no model call.
        if (cfg.open === "fresh") await startSession(cfg.cwd, cfg.model ?? "", "default");
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
                waits: closeWaits(t.waits, Date.now()),
                background: [],
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
      if (n.method === "fleet.changed") {
        const { item } = n.params;
        setFleet((f) => ({ ...f, [item.sessionId]: item }));
        return;
      }
      if (n.method === "permission.request") {
        // A task step's session has no tab: its approvals queue up and show over whatever page is open.
        const { task } = n.params;
        if (task && !tabsRef.current.some((t) => t.sessionId === n.params.sessionId)) {
          setTaskApprovals((q) => [...q, n.params]);
          return;
        }
        patchTab(n.params.sessionId, (t) => permissionAsked(t, n.params, Date.now()));
        return;
      }
      if (n.method === "task.updated") {
        // A run that ended cancels its steps' pending approvals.
        const { task } = n.params;
        if (task.state !== "running") setTaskApprovals((q) => q.filter((p) => p.task?.id !== task.id));
        return;
      }
      const { sessionId, event, task } = n.params;
      if (event.type === "turn.completed") {
        if (task && !tabsRef.current.some((t) => t.sessionId === sessionId)) recordStepCost(sessionId, event, task.cwd);
        else recordCost(sessionId, event);
      }
      if (event.type === "turn.completed") {
        turnWaiters.current.get(sessionId)?.(event);
        turnWaiters.current.delete(sessionId);
      }
      // The CLI's model list, kept for the start screen and Settings too (UX-12).
      if (event.type === "models.changed") rememberModels(event.models);
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
    // The fleet as the runtime has it now; changes arrive as `fleet.changed`.
    void request("fleet.list", {}).then(
      ({ items }) => setFleet((f) => ({ ...f, ...Object.fromEntries(items.map((i) => [i.sessionId, i])) })),
      () => undefined,
    );
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
  /** A task step's turn, for cost history: its session's running total gives the turn's spend. */
  function recordStepCost(sessionId: string, e: TurnCompleted, stepCwd: string) {
    const previous = stepTotals.current.get(sessionId);
    stepTotals.current.set(sessionId, e.totalCostUsd);
    const turn = {
      sessionId,
      cwd: stepCwd,
      at: Date.now(),
      totalCostUsd: e.totalCostUsd,
      deltaUsd: previous === undefined ? e.totalCostUsd : Math.max(0, e.totalCostUsd - previous),
      durationMs: Math.round(e.durationMs),
      inputTokens: null,
      outputTokens: null,
      model: null,
      subtype: e.subtype,
    };
    void invoke("cost_record", { turn }).catch((err: unknown) => console.warn(`cost history: ${err}`));
  }

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
          ? [`Applied automatically: ${applied.join(", ")}. Roll back in Workspace settings → History.`]
          : []),
        ...results
          .filter((r) => r.status === "failed")
          .map((r) => `Auto-apply couldn't apply ${titles.get(r.id) ?? r.id}: ${r.message ?? "unknown error"}`),
      ];
    } catch (err) {
      return [`Auto-apply didn't run: ${err}`];
    }
  }

  async function startSession(
    dir: string,
    modelAlias: string,
    mode: PermissionMode,
    folders: string[] = [],
  ): Promise<string | null> {
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
        ...(folders.length ? { folders } : {}),
      });
      const also = folders.length ? `, with ${folders.map(folderName).join(", ")}` : "";
      const items = [notice(`Session started in ${folderName(dir)}${also}`), ...applied.map(notice)];
      setTabs((ts) => [
        ...ts,
        newTab(sessionId, dir, { title: NEW_TITLE, mode, items, modelAlias, effort, budgetUsd, folders }),
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
      const { events, times } = await request("session.history", { cwd: dir, sessionId });
      // A chat of a multi-folder workspace resumes across the same folders (M8-01).
      const folders = tabs.find((t) => t.sessionId === sessionId)?.folders ?? [];
      await request("session.start", {
        cwd: dir,
        resume: sessionId,
        permissionMode: mode,
        ...(modelAlias ? { model: modelAlias } : {}),
        ...(effort ? { effort } : {}),
        ...(budgetUsd ? { maxBudgetUsd: budgetUsd } : {}),
        showThinking,
        ...(folders.length ? { folders } : {}),
      });
      const items = closeAssistant(
        // Stored times rebuild the agents' timing for the graph and the timeline (M4-08).
        events.reduce<Item[]>(
          (acc, e, i) => applyEvent(acc, e, times?.[i] ?? undefined),
          [notice(`Resumed “${title}” in ${folderName(dir)}`)],
        ),
      );
      const tab = newTab(sessionId, dir, {
        title,
        mode,
        items,
        resumed: true,
        modelAlias,
        effort,
        budgetUsd,
        folders,
      });
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
        {
          kind: "user",
          id: itemId,
          text,
          at: Date.now(),
          ...(images.length ? { images: images.map((i) => i.preview) } : {}),
        },
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
    // Shown at once, so Shift+Tab pressed quickly walks on from the mode just picked; put back if the switch fails.
    const before = tabs.find((t) => t.sessionId === sessionId)?.mode;
    patchTab(sessionId, (t) => ({ ...t, mode, ...(mode !== "plan" ? { planSwitch: null } : {}) }));
    try {
      await request("session.setMode", { sessionId, mode });
    } catch (err) {
      if (before) patchTab(sessionId, (t) => ({ ...t, mode: before }));
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
      ...permissionAnswered(t, req.requestId, Date.now()),
      // An approved plan runs in the mode the user picked (M1-16).
      ...(reply.allow && reply.mode && req.toolName === "ExitPlanMode" ? { mode: reply.mode, planSwitch: null } : {}),
    }));
    try {
      await request("permission.respond", { sessionId: req.sessionId, requestId: req.requestId, ...reply });
    } catch (err) {
      addNotice(req.sessionId, String(err));
    }
  }

  /** The app's own slash commands (UX-12); anything else typed after `/` went to Claude. */
  function runCommand(t: Tab, name: AppCommand, arg: string) {
    const id = t.sessionId;
    switch (name) {
      case "clear":
        void startSession(t.cwd, t.modelAlias, t.mode, t.folders);
        return;
      case "fork":
        void forkTab(id);
        return;
      case "model": {
        const m = arg ? modelFromArg(arg) : null;
        if (m === null) {
          addNotice(id, `Model: ${t.model ?? "default"}. Switch with /model haiku, sonnet, opus or default.`);
        } else void changeModel(id, m);
        return;
      }
      case "mode": {
        const m = arg ? modeFromArg(arg) : null;
        if (m === null) {
          addNotice(
            id,
            `Mode: ${MODE_NAMES[t.mode]}. Switch with /mode safe, standard, plan or autonomous, or Shift+Tab.`,
          );
        } else void changeMode(id, m);
        return;
      }
      case "effort": {
        const e = arg ? effortFromArg(arg) : undefined;
        if (e === undefined)
          addNotice(id, `Effort: ${t.effort ?? "default"}. Switch with /effort ${EFFORTS.join(", ")} or default.`);
        else void changeEffort(id, e);
        return;
      }
      case "usage": {
        const spent =
          t.cost.totalUsd === null ? "not known yet for a resumed session" : `≈$${t.cost.totalUsd.toFixed(4)}`;
        const ctx = t.context
          ? `; context ${Math.round(t.context.percentage)}% (${t.context.totalTokens.toLocaleString()} of ${t.context.maxTokens.toLocaleString()} tokens)`
          : "";
        addNotice(
          id,
          `This chat has spent ${spent}${t.budgetUsd !== null ? ` of a $${t.budgetUsd.toFixed(2)} cap` : ""}${ctx}. Estimates.`,
        );
        return;
      }
      case "task":
        if (settings?.tasksPreview !== true) {
          addNotice(id, "Tasks are a preview: turn them on in Settings, then try /task again.");
        } else if (arg) void makeTask(t, arg);
        else addNotice(id, "Say what to do after /task, or pick Task in the composer.");
        return;
      case "help":
        addNotice(
          id,
          `App commands: ${APP_COMMANDS.map((c) => `/${c.name}`).join(", ")}. Other / commands go to Claude, e.g. /compact.`,
        );
        return;
    }
  }

  async function answerTaskStep(req: PermissionRequest, reply: PermissionAnswer) {
    setTaskApprovals((q) => q.filter((p) => p.requestId !== req.requestId));
    try {
      await request("permission.respond", { sessionId: req.sessionId, requestId: req.requestId, ...reply });
    } catch (err) {
      setRuntimeNotice(`Couldn't answer the task step: ${err}`);
    }
  }

  /** Stops the run a step's approval belongs to; its other pending approvals go with it. */
  async function stopTaskStep(req: PermissionRequest) {
    const task = req.task;
    if (!task) return;
    setTaskApprovals((q) => q.filter((p) => p.task?.id !== task.id));
    try {
      await request("task.cancel", { cwd: task.cwd, id: task.id });
    } catch (err) {
      setRuntimeNotice(`Couldn't stop the task: ${err}`);
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
      // The SDK lists the files only on the dry run (CLI 2.1.314), so the count comes from the preview the user confirmed.
      const count = done.filesChanged.length || preview.filesChanged.length;
      addNotice(
        sessionId,
        done.canRewind
          ? `Rewound ${count} file(s) to before that message.`
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

  /** Shows a session or a task (`task:<id>`), or Home for null; closes Workspace settings if it's open. */
  function show(key: string | null) {
    setSetup(null);
    setActive(key);
  }

  /** Opens a task in its tab (UX-13); `autoDraft` drafts a new one as soon as it's loaded. */
  function openTask(dir: string, id: string, options: { autoDraft?: boolean; model?: string; title?: string } = {}) {
    setTaskTabs((all) =>
      all.some((t) => t.id === id)
        ? all
        : [
            ...all,
            {
              id,
              cwd: dir,
              title: options.title ?? "Task",
              state: "draft",
              busy: Boolean(options.autoDraft),
              autoDraft: Boolean(options.autoDraft),
              model: options.model ?? model,
            },
          ],
    );
    show(taskKey(id));
  }

  function closeTaskTab(id: string) {
    const rest = taskTabs.filter((t) => t.id !== id);
    setTaskTabs(rest);
    if (active === taskKey(id))
      setActive(tabs.at(-1)?.sessionId ?? (rest.at(-1) ? taskKey(rest.at(-1)?.id ?? "") : null));
  }

  /**
   * Makes a task from the composer's Task mode or `/task` (UX-13): an empty chat becomes the task; a chat with history
   * stays, and its last messages go to drafting as context.
   */
  async function makeTask(t: Tab, text: string) {
    try {
      const context = isFresh(t) ? "" : chatContext(t.items);
      const created = await request("task.create", {
        cwd: t.cwd,
        request: text,
        ...(context ? { context } : {}),
      });
      if (isFresh(t)) closeTab(t.sessionId);
      openTask(t.cwd, created.id, { autoDraft: true, model: t.modelAlias, title: text.slice(0, 60) });
    } catch (err) {
      addNotice(t.sessionId, `Couldn't make the task: ${err}`);
    }
  }

  function openWorkspace(dir: string) {
    setCwd(dir);
    setWsId(null);
    show(null);
  }

  /** A named multi-folder workspace (M8-01): Home in its primary folder, and New reaches its other folders too. */
  function openWorkspaceDef(def: WorkspaceDef) {
    setCwd(def.primary);
    setWsId(def.id);
    show(null);
  }

  async function saveWorkspaceDef(def: WorkspaceDef) {
    if (!settings) return;
    try {
      const others = settings.workspaces.filter((w) => w.id !== def.id);
      setSettings(await saveSettings({ ...settings, workspaces: [def, ...others] }));
      setWsDialog(null);
      openWorkspaceDef(def);
    } catch (err) {
      setRuntimeNotice(`Couldn't save the workspace: ${err}`);
    }
  }

  async function deleteWorkspaceDef(def: WorkspaceDef) {
    if (!settings) return;
    const ok = await confirm({
      title: `Remove the ${def.name} workspace?`,
      body: <p>Only the list goes: the folders and their files stay as they are.</p>,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setSettings(await saveSettings({ ...settings, workspaces: settings.workspaces.filter((w) => w.id !== def.id) }));
    if (wsId === def.id) setWsId(null);
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

  /**
   * New in Task mode (UX-13): a new chat in the active tab's folder, or Home's, with its composer set to Task. With no
   * folder yet, Home asks for one. Only with the Tasks preview on.
   */
  async function newTask() {
    if (settings?.tasksPreview !== true) return;
    const t = tabs.find((x) => x.sessionId === active) ?? taskTabs.find((x) => taskKey(x.id) === active);
    const dir = t?.cwd ?? cwd.trim();
    if (!dir) return show(null);
    const folders = t && "sessionId" in t ? t.folders : t ? [] : homeDef?.folders;
    const id = await startSession(dir, model, mode, folders ?? []);
    if (id) patchTab(id, (x) => ({ ...x, kind: "task" }));
  }

  const toggleTerminal = (sessionId: string) =>
    setTerminals((open) => withToggled(open, sessionId, !open.has(sessionId)));

  useMenuCommands({
    "new-session": () => show(null),
    "new-task": newTask,
    "open-folder": () => void openFolder(),
    "close-session": () => active && closeTab(active),
    settings: () => setSettingsOpen(true),
    "toggle-sidebar": () => setSidebarOpen((v) => !v),
    "toggle-right-panel": () => setRightOpen((v) => !v),
    "toggle-terminal": () => active && toggleTerminal(active),
    "export-diagnostics": () => void exportFromMenu(),
    "check-updates": () => setUpdatesOpen(true),
    "command-palette": () => setPaletteOpen(true),
  });

  const activeTab = tabs.find((t) => t.sessionId === active);
  // Claude's questions are cards in the thread (UX-12), not this dialog.
  const permission = activeTab?.permissions.find((p) => p.toolName !== "AskUserQuestion");
  // A task step's approval shows when the active session has none waiting.
  // A step's approval shows as a card in its task's thread (UX-13); only one whose task has no open thread is a dialog.
  const threaded = new Set(taskTabs.flatMap((t) => shownTasks[t.id] ?? [t.id]));
  const stepApproval = permission ? undefined : taskApprovals.find((p) => !p.task || !threaded.has(p.task.id));
  const workspace = cwd.trim();
  // The named workspace picked on Home, while Home's folder is still its primary folder.
  const homeDef =
    settings?.workspaces.find((w) => w.id === wsId && workspace && folderKey(w.primary) === folderKey(workspace)) ??
    null;

  /** Everything the command palette offers (UX-07), built from the same actions as the menu and the views. */
  function paletteCommands(): PaletteCommand[] {
    const t = activeTab;
    const cmds: PaletteCommand[] = [];
    const add = (group: string, id: string, title: string, run: () => void, extra: Partial<PaletteCommand> = {}) =>
      cmds.push({ group, id, title, run, ...extra });

    add("Session", "new-session", "New session", () => show(null), { shortcut: menuShortcut("new-session") });
    add("Session", "fleet", "Fleet: everything running", () => show(FLEET));
    if (settings?.tasksPreview === true)
      add("Session", "new-task", "New task (preview)", newTask, { shortcut: menuShortcut("new-task") });
    add("Session", "open-folder", "Open folder…", () => void openFolder(), { shortcut: menuShortcut("open-folder") });
    if (t) {
      if (t.running)
        add(
          "Session",
          "stop",
          "Stop the running turn",
          () => void request("session.interrupt", { sessionId: t.sessionId }),
          {
            shortcut: "Esc",
          },
        );
      if (t.ended) add("Session", "resume", "Resume this session", () => void resume(t.sessionId, t.cwd, t.title));
      add("Session", "fork", "Fork into a new session", () => void forkTab(t.sessionId));
      add("Session", "close-session", "Close session", () => closeTab(t.sessionId), {
        shortcut: menuShortcut("close-session"),
      });
      if (!t.ended) {
        for (const m of PERMISSION_MODES)
          if (m !== t.mode)
            add("Session", `mode-${m}`, `Permission profile: ${MODE_NAMES[m]}`, () => void changeMode(t.sessionId, m));
        for (const m of modelChoices(t.models.length ? t.models : undefined))
          if (m.value && m.value !== t.modelAlias)
            add("Session", `model-${m.value}`, `Model: ${m.label}`, () => void changeModel(t.sessionId, m.value));
      }
    }

    for (const tab of tabs)
      if (tab.sessionId !== active)
        add("Go to", `tab-${tab.sessionId}`, tab.title, () => show(tab.sessionId), { hint: folderName(tab.cwd) });
    for (const dir of settings?.recentWorkspaces ?? [])
      add("Go to", `workspace-${dir}`, `Open workspace: ${folderName(dir)}`, () => openWorkspace(dir), { hint: dir });

    const dir = t?.cwd ?? (workspace || null);
    if (dir) {
      const views: [SetupView, string][] = [
        ["overview", "Overview"],
        ["plan", "Setup plan"],
        ["commands", "Commands"],
        ["agents", "Agents"],
        ["permissions", "Permissions"],
        ["workflows", "Workflows"],
        ["deploy", "Deploy"],
        ["metrics", "Metrics"],
        ["history", "History"],
      ];
      for (const [view, label] of views)
        add(
          "Workspace",
          `setup-${view}`,
          `Workspace settings: ${label}`,
          () => setSetup({ cwd: dir, model: t?.modelAlias ?? model, back: t?.sessionId ?? null, view }),
          { hint: folderName(dir) },
        );
    }

    add("View", "toggle-sidebar", "Toggle sidebar", () => setSidebarOpen((v) => !v), {
      shortcut: menuShortcut("toggle-sidebar"),
    });
    add("View", "toggle-right-panel", "Toggle workspace panel", () => setRightOpen((v) => !v), {
      shortcut: menuShortcut("toggle-right-panel"),
    });
    if (t)
      add("View", "toggle-terminal", "Toggle terminal", () => toggleTerminal(t.sessionId), {
        shortcut: menuShortcut("toggle-terminal"),
      });
    for (const tab of PANEL_TABS) {
      const hidden = hiddenTabs.includes(tab);
      add("View", `panel-${tab}`, `${hidden ? "Show" : "Hide"} the ${PANEL_TAB_LABEL[tab]} tab`, () =>
        setHiddenTabs((h) => toggleHidden(h, tab)),
      );
    }
    if (hiddenTabs.length) add("View", "panel-all", "Show all panel tabs", () => setHiddenTabs(() => []));
    if (settings)
      for (const theme of THEMES)
        if (asTheme(settings.theme) !== theme.value)
          add(
            "View",
            `theme-${theme.value}`,
            `Theme: ${theme.label}`,
            () => void onSaveSettings({ ...settings, theme: theme.value }),
          );

    add("App", "settings", "Settings…", () => setSettingsOpen(true), { shortcut: menuShortcut("settings") });
    add("App", "check-updates", "Check for updates…", () => setUpdatesOpen(true));
    add("App", "export-diagnostics", "Export diagnostics…", () => void exportFromMenu());
    add(
      "App",
      "getting-started",
      "Getting started guide",
      () => void openUrl(`${REPO}/blob/main/docs/guides/AUTH_SETUP.md`),
    );
    add("App", "report-issue", "Report an issue", () => void openUrl(`${REPO}/issues/new`));
    return cmds;
  }

  if (bench)
    return (
      <Suspense fallback={null}>
        <GraphBench
          onDone={(report) =>
            void request("debug.log", { message: JSON.stringify({ selftest: { graphBench: report } }) }).then(() =>
              bench.stay ? undefined : quitApp(),
            )
          }
        />
      </Suspense>
    );

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
                // A page over the session (Workspace settings, a task) is what's shown, not the session.
                active={setup ? null : active}
                taskTabs={taskTabs}
                onCloseTask={closeTaskTab}
                fleet={Object.values(fleet)}
                waitingTasks={new Set(taskApprovals.flatMap((p) => (p.task ? [p.task.id] : [])))}
                recent={settings?.recentWorkspaces ?? []}
                ready={env ? env.ready : null}
                onNew={() => show(null)}
                {...(settings?.tasksPreview === true ? { onNewTask: () => void newTask() } : {})}
                onSelect={show}
                onClose={closeTab}
                onOpenWorkspace={openWorkspace}
                workspaces={settings?.workspaces ?? []}
                onOpenWorkspaceDef={openWorkspaceDef}
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
                {active === FLEET && !setup && (
                  <FleetView
                    items={Object.values(fleet)}
                    tabs={tabs}
                    onOpenChat={(id) => show(id)}
                    onOpenTask={(dir, id, title) => openTask(dir, id, { title })}
                    onStop={(item) =>
                      void (
                        item.task
                          ? request("task.cancel", { cwd: item.task.cwd, id: item.task.id })
                          : request("session.interrupt", { sessionId: item.sessionId })
                      ).catch((err: unknown) => setRuntimeNotice(`Couldn't stop it: ${err}`))
                    }
                    onClearEnded={() =>
                      setFleet((f) => Object.fromEntries(Object.entries(f).filter(([, i]) => i.status !== "ended")))
                    }
                  />
                )}
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
                    onStart={() => void startSession(workspace, model, mode, homeDef?.folders ?? [])}
                    onOpenSetup={() => setSetup({ cwd: workspace, model, back: null })}
                    openIds={new Set(tabs.filter((t) => !t.ended).map((t) => t.sessionId))}
                    onOpenStored={openStored}
                    confirm={confirm}
                  >
                    {settings && (
                      <WorkspacesCard
                        workspaces={settings.workspaces}
                        selected={homeDef}
                        onPick={openWorkspaceDef}
                        onNew={() => setWsDialog("new")}
                        onEdit={setWsDialog}
                        onDelete={(def) => void deleteWorkspaceDef(def)}
                      />
                    )}
                    {settings?.tasksPreview === true && hello !== null && workspace && (
                      <HomeTasks cwd={workspace} onOpen={(id, title) => openTask(workspace, id, { title })} />
                    )}
                  </HomeView>
                )}
                {tabs.map((t) => (
                  <SessionView
                    key={t.sessionId}
                    tab={t}
                    hidden={t.sessionId !== active || setup !== null}
                    panelTab={panelTab}
                    hiddenTabs={hiddenTabs}
                    onHiddenTabsChange={(next) => setHiddenTabs(() => next)}
                    showFirstChange={showFirstChange}
                    rightOpen={rightOpen}
                    terminalOpen={terminals.has(t.sessionId)}
                    onToggleRight={() => setRightOpen((v) => !v)}
                    onToggleTerminal={() => toggleTerminal(t.sessionId)}
                    onSend={(text, images) => void sendText(t.sessionId, text, images)}
                    {...(settings?.tasksPreview === true ? { onTask: (text: string) => void makeTask(t, text) } : {})}
                    onCommand={(name, arg) => runCommand(t, name, arg)}
                    onAnswer={(req, reply) => void answer(req, reply)}
                    onInterrupt={() => void request("session.interrupt", { sessionId: t.sessionId })}
                    onStopAgent={async (taskId) => {
                      await request("session.stopAgent", { sessionId: t.sessionId, taskId });
                    }}
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
                      key={`${setup.cwd}-${setup.view ?? "overview"}`}
                      cwd={setup.cwd}
                      model={setup.model}
                      backLabel={setup.back ? "Back to session" : "Back to Home"}
                      confirm={confirm}
                      onBack={() => setSetup(null)}
                      {...(setup.view ? { initialView: setup.view } : {})}
                    />
                  </Suspense>
                )}
                {taskTabs.length > 0 && (
                  <Suspense fallback={null}>
                    {taskTabs.map((t) => (
                      <TaskPage
                        key={`${t.cwd}-${t.id}`}
                        cwd={t.cwd}
                        taskId={t.id}
                        model={t.model}
                        mode={mode}
                        hidden={active !== taskKey(t.id) || setup !== null}
                        autoDraft={t.autoDraft}
                        confirm={confirm}
                        onClose={() => closeTaskTab(t.id)}
                        onChange={onTaskChange}
                        approvals={taskApprovals}
                        onAnswerApproval={(req, reply) => void answerTaskStep(req, reply)}
                        onStopFromApproval={(req) => void stopTaskStep(req)}
                        onOpenFile={(file) =>
                          invoke("open_in_editor", { file, line: null, editor: settings?.editor ?? "system" })
                        }
                      />
                    ))}
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
            cwd={activeTab.cwd}
            canAutonomous={activeTab.budgetUsd !== null}
            onAnswer={(reply) => void answer(permission, reply)}
          />
        )}
        {stepApproval?.task && (
          <PermissionDialog
            key={stepApproval.requestId}
            request={stepApproval}
            cwd={stepApproval.task.cwd}
            canAutonomous={false}
            onAnswer={(reply) => void answerTaskStep(stepApproval, reply)}
            onStopTask={() => void stopTaskStep(stepApproval)}
          />
        )}
        {wsDialog && (
          <WorkspaceDialog
            initial={wsDialog === "new" ? null : wsDialog}
            homeDir={hello?.homeDir ?? null}
            onSave={(def) => void saveWorkspaceDef(def)}
            onClose={() => setWsDialog(null)}
          />
        )}
        {settingsOpen && settings && (
          <SettingsDialog
            settings={settings}
            hello={hello}
            appVersion={appVersion}
            onSave={onSaveSettings}
            onExportDiagnostics={exportDiagnostics}
            onCheckUpdates={() => setUpdatesOpen(true)}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {updatesOpen && <UpdateDialog appVersion={appVersion} onClose={() => setUpdatesOpen(false)} />}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          commands={paletteOpen ? paletteCommands() : []}
        />
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
