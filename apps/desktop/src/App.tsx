import {
  type AgentEvent,
  EFFORTS,
  type Effort,
  type EnvCheck,
  type FleetItem,
  folderKey,
  type Methods,
  type PermissionMode,
  type PermissionRequest,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type Schedule,
  type SessionInfo,
  type StepAgent,
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
import { FleetView, type ScheduleAction } from "./FleetView.tsx";
import { joinPath } from "./files.ts";
import { HomeView, pickFolder } from "./HomeView.tsx";
import { approxUsd, count, usd as dollars } from "./i18n/format.ts";
import { t } from "./i18n/index.ts";
import { NewSessionDialog } from "./NewSessionDialog.tsx";
import { agentModes, fitMode, MODE_NAMES, modelChoices, rememberModels, THEMES } from "./options.ts";
import { type PermissionAnswer, PermissionDialog } from "./PermissionDialog.tsx";
import { PANEL_TAB_LABEL, PANEL_TABS, type PanelTab, parseHidden, serializeHidden, toggleHidden } from "./panelTabs.ts";
import { SessionView } from "./SessionView.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { FLEET, Sidebar, USAGE } from "./Sidebar.tsx";
import { notify as notifyOs, scheduledRunEnded } from "./schedules.ts";
import { quitApp, readSelftestConfig, runSelftest, type SelftestConfig } from "./selftest.ts";
import {
  foldersFor,
  loadSettings,
  type Settings,
  saveSettings,
  type WorkspaceDef,
  withRecent,
  withSessionFolders,
} from "./settings.ts";
import type { SetupView } from "./setup/SetupPage.tsx";
import { connect, isRpcError, onExit, onReady, request, requestWithTimeout, subscribe } from "./sidecar.ts";
import { TitleBar } from "./TitleBar.tsx";
import {
  asMode,
  closeWaits,
  folderName,
  isFresh,
  newTab,
  orphanChats,
  permissionAnswered,
  permissionAsked,
  type Tab,
  tabEvent,
  updateTab,
} from "./tabs.ts";
import { HomeTasks } from "./tasks/HomeTasks.tsx";
import { ScheduleDialog, type ScheduleTarget } from "./tasks/ScheduleDialog.tsx";
import { type TaskTab, taskKey } from "./tasks/taskTabs.ts";
import { TEAM_CAP_USD, usd } from "./team.ts";
import { asTheme } from "./theme.ts";
import { applyEvent, closeAssistant, type Item, nextId, setMessageId } from "./transcript.ts";
import { UpdateDialog } from "./UpdateDialog.tsx";
import { IconButton } from "./ui/IconButton.tsx";
import { layoutStorage, usePersistentFlag, usePersistentValue } from "./ui/layoutStorage.ts";
import { UsagePage } from "./usage/UsagePage.tsx";
import { type MenuCommand, menuShortcut, useMenuCommands } from "./useMenuCommands.ts";
import { WorkspaceDialog, WorkspacesCard } from "./WorkspaceDialog.tsx";

// The setup page shares the file-type icon set with the workspace panel; both load on first use.
const REPO = "https://github.com/hafizhrf/AgentChainer";
/** The product's name: never translated. */
const APP_NAME = "AgentChainer";
const SetupPage = lazy(() => import("./setup/SetupPage.tsx").then((m) => ({ default: m.SetupPage })));
const TaskPage = lazy(() => import("./tasks/TaskPage.tsx").then((m) => ({ default: m.TaskPage })));
// The M4-E2 bench is dev-only; it loads only when a self-test asks for it.
const GraphBench = lazy(() => import("./graph/GraphBench.tsx").then((m) => ({ default: m.GraphBench })));

/** Guards against React StrictMode running the mount effect twice in dev. */
let selftestStarted = false;

const PING_EVERY_MS = 20_000;
const PING_TIMEOUT_MS = 5_000;

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
  /** The agent profile a new chat starts as (M8-04); "" for none. */
  const [profile, setProfile] = useState("");
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
    /** A multi-folder workspace's folders, primary first (M8-01): the page switches between them. */
    folders?: string[];
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
  /** The New session dialog (UX-20): New, Ctrl+N, the palette and the home page open it. */
  const [newSession, setNewSession] = useState(false);
  /** The agent a new chat runs on (M9-09). */
  const [newAgent, setNewAgent] = useState<StepAgent>("claude");
  /** Every live session's fleet status, by session id (M8-02); ended ones stay until cleared or the app restarts. */
  const [fleet, setFleet] = useState<Record<string, FleetItem>>({});
  /** Chats the runtime still runs with no tab, after a reload (M1-36); re-attached once the settings are in. */
  const [orphans, setOrphans] = useState<FleetItem[]>([]);
  /** Resumes in flight, so a second click doesn't start the same session twice (M1-36). */
  const resuming = useRef(new Set<string>());
  /** Scheduled flows (M8-05), by `cwd|id`, and the one being edited. */
  const [schedules, setSchedules] = useState<Record<string, Schedule>>({});
  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget | null>(null);
  /** Each task's last state seen, so a scheduled run's end is told once (M8-05). */
  const taskStates = useRef(new Map<string, Task["state"]>());
  // The workspaces whose schedules run while the app is open: the recent ones and the named ones' primaries. Sent
  // again whenever the runtime (re)starts or the list changes, so a restarted sidecar runs them again (M8-05).
  const watchKey = [
    ...new Set([
      ...(settings?.recentWorkspaces ?? []),
      ...(settings?.workspaces ?? []).map((w) => w.primary),
      // A workspace with a schedule stays watched even if it drops out of the recent list.
      ...Object.values(schedules).map((s) => s.cwd),
    ]),
  ]
    .sort()
    .join("\n");
  useEffect(() => {
    if (!hello) return;
    request("schedule.watch", { cwds: watchKey ? watchKey.split("\n") : [] }).then(
      ({ schedules: list }) => setSchedules(Object.fromEntries(list.map((s) => [`${s.cwd}|${s.id}`, s]))),
      () => undefined,
    );
  }, [hello, watchKey]);
  // The app's task defaults reach the runtime at the start and on every change, scheduled runs included.
  const defaultsKey = JSON.stringify(settings?.taskDefaults ?? {});
  useEffect(() => {
    if (!hello) return;
    request("app.setDefaults", { defaults: JSON.parse(defaultsKey) }).catch(() => undefined);
  }, [hello, defaultsKey]);
  /** Every workspace the app knows (recent ones, named ones' folders): "Apply to all workspaces". */
  const knownWorkspaces = [
    ...new Set([
      ...(settings?.recentWorkspaces ?? []),
      ...(settings?.workspaces ?? []).flatMap((w) => [w.primary, ...w.folders]),
    ]),
  ];
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
      all.map((x) =>
        x.id === task.id
          ? {
              ...x,
              title: (task.title ?? task.request).slice(0, 60),
              state: task.state,
              busy: busy || task.state === "running",
            }
          : x,
      ),
    );
  }, []);

  const addNotice = (sessionId: string, text: string) =>
    patchTab(sessionId, (tab) => ({ ...tab, items: [...closeAssistant(tab.items), notice(text)] }));

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
        if (!cfg || selftestStarted) return;
        // Performance budgets (X-07): when Home is ready, how long that took, then idle for the memory sample. It
        // needs no CLI or login, so it runs whether or not the readiness check passed (CI runners have no CLI).
        if (cfg.bench === "startup") {
          selftestStarted = true;
          const uiReadyMs = Math.round(performance.now());
          await request("debug.log", {
            message: JSON.stringify({ selftest: { startup: { uiReadyMs, ready: checked.ready } } }),
          });
          setTimeout(() => void quitApp(), ((cfg.idleSeconds ?? 30) + 10) * 1000);
          return;
        }
        if (!checked.ready) return;
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
          resume: (sessionId, dir, modelAlias) => resume(sessionId, dir, t("app.selftest.title"), modelAlias),
          tab: (sessionId) => tabsRef.current.find((x) => x.sessionId === sessionId),
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
        if (
          (cfg.open === "setup" || cfg.open === "plan" || cfg.open === "permissions" || cfg.open === "plugins") &&
          first
        )
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
        ts.map((tab) =>
          tab.ended
            ? tab
            : {
                ...tab,
                ended: true,
                running: false,
                permissions: [],
                waits: closeWaits(tab.waits, Date.now()),
                background: [],
                items: [...closeAssistant(tab.items), notice(t("app.runtime.stoppedNotice"))],
              },
        ),
      );
      setRuntimeNotice(
        exit.restarting
          ? t("app.runtime.stoppedRestarting", { status: exit.status })
          : t("app.runtime.stopped", { status: exit.status }),
      );
    });
    const offReady = onReady(() => {
      void handshake()
        .then(() => setRuntimeNotice((n) => (n ? t("app.runtime.restarted") : null)))
        .catch(() => undefined);
    });
    const offEvents = subscribe((n) => {
      if (n.method === "fleet.changed") {
        const { item } = n.params;
        setFleet((f) => ({ ...f, [item.sessionId]: item }));
        // A Team chat's worker ends with its supervisor, or at the team's cap (M8-03): its tab can't send any more.
        if (item.parentId && item.status === "ended")
          patchTab(item.sessionId, (tab) => ({ ...tab, ended: true, running: false }));
        return;
      }
      if (n.method === "permission.request") {
        // A task step's session has no tab: its approvals queue up and show over whatever page is open.
        const { task } = n.params;
        // Nobody may be watching a scheduled run (M8-05): its approvals are told as OS notifications.
        if (task?.scheduled) {
          void notifyOs(
            t("app.schedule.needsYou", { title: task.title ?? t("app.schedule.scheduledTask") }),
            t("app.schedule.waitsForApproval", { tool: n.params.toolName }),
          );
        }
        if (task && !tabsRef.current.some((x) => x.sessionId === n.params.sessionId)) {
          setTaskApprovals((q) => [...q, n.params]);
          return;
        }
        patchTab(n.params.sessionId, (tab) => permissionAsked(tab, n.params, Date.now()));
        return;
      }
      if (n.method === "task.updated") {
        // A run that ended cancels its steps' pending approvals.
        const { task } = n.params;
        if (task.state !== "running") setTaskApprovals((q) => q.filter((p) => p.task?.id !== task.id));
        const ended = scheduledRunEnded(taskStates.current.get(task.id), task);
        if (ended) void notifyOs(ended.title, ended.body);
        taskStates.current.set(task.id, task.state);
        return;
      }
      if (n.method === "schedule.changed") {
        const { schedule } = n.params;
        setSchedules((all) => ({ ...all, [`${schedule.cwd}|${schedule.id}`]: schedule }));
        return;
      }
      if (n.method === "schedule.deleted") {
        const key = `${n.params.cwd}|${n.params.id}`;
        setSchedules((all) => Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)));
        return;
      }
      // A Team chat's worker (M8-03): its tab opens beside the supervisor's without taking focus, before its events.
      if (n.method === "session.opened") {
        const { sessionId, parentId, cwd: dir, name, access, profile: workerProfile } = n.params;
        setTabs((ts) => {
          const parent = ts.find((x) => x.sessionId === parentId);
          const tab = newTab(sessionId, dir, {
            title: name,
            mode: "default",
            parentId,
            access,
            ...(workerProfile ? { profile: workerProfile } : {}),
            modelAlias: parent?.modelAlias ?? "",
            ...(parent?.folders?.length ? { folders: parent.folders } : {}),
            items: [
              notice(
                t(access === "write" ? "app.worker.startedWrite" : "app.worker.startedRead", {
                  parent: parent?.title ?? t("app.worker.supervisor"),
                }),
              ),
            ],
          });
          return [...ts, tab];
        });
        return;
      }
      const { sessionId, event, task } = n.params;
      if (event.type === "turn.completed") {
        if (task && !tabsRef.current.some((x) => x.sessionId === sessionId)) recordStepCost(sessionId, event, task.cwd);
        else recordCost(sessionId, event);
      }
      if (event.type === "turn.completed") {
        turnWaiters.current.get(sessionId)?.(event);
        turnWaiters.current.delete(sessionId);
      }
      // The CLI's model list, kept for the start screen and Settings too (UX-12).
      if (event.type === "models.changed") rememberModels(event.models);
      patchTab(sessionId, (tab) => tabEvent(tab, event, Date.now()));
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
      throw new Error(t("app.runtime.protocolMismatch", { app: PROTOCOL_VERSION, runtime: h.protocolVersion }));
    }
    setHello(h);
    alive.current = true;
    // The fleet as the runtime has it now; changes arrive as `fleet.changed`.
    void request("fleet.list", {}).then(
      ({ items }) => {
        setFleet((f) => ({ ...f, ...Object.fromEntries(items.map((i) => [i.sessionId, i])) }));
        // A reload wipes the tabs but not the runtime's sessions: the chats it still runs get their tabs back.
        setOrphans(orphanChats(items, tabsRef.current));
      },
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
    const claudePathChanged =
      saved.claudePath !== settings?.claudePath ||
      saved.codexPath !== settings?.codexPath ||
      saved.agyPath !== settings?.agyPath;
    applySettings(saved);
    // The CLI paths reach the sidecar as env vars at spawn, so a change needs a restart (ready → re-check).
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
    const tab = tabsRef.current.find((x) => x.sessionId === sessionId);
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

  /** Moves `dir` to the front of the recent list; with a session, also remembers its other folders (M8-07). */
  async function rememberWorkspace(dir: string, session?: { id: string; folders: string[] }) {
    if (!settings) return;
    const recent = withRecent(settings, dir);
    setSettings(await saveSettings(session ? withSessionFolders(recent, session.id, session.folders) : recent));
  }

  /** Effort and budget for a new or resumed session, from settings (M1-15/M1-32). */
  function sessionOptions(mode: PermissionMode) {
    const effort = EFFORTS.find((e) => e === settings?.defaultEffort) ?? null;
    const budgetUsd = settings?.budgetUsd ?? null;
    if (mode === "auto" && budgetUsd === null) {
      throw new Error(t("app.session.autonomousNeedsCap"));
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
        ...(applied.length ? [t("app.autoApply.applied", { actions: applied.join(", ") })] : []),
        ...results
          .filter((r) => r.status === "failed")
          .map((r) =>
            t("app.autoApply.failed", {
              action: titles.get(r.id) ?? r.id,
              error: r.message ?? t("app.unknownError"),
            }),
          ),
      ];
    } catch (err) {
      return [t("app.autoApply.didntRun", { error: String(err) })];
    }
  }

  async function startSession(
    dir: string,
    modelAlias: string,
    mode: PermissionMode,
    folders: string[] = [],
    team = false,
    agentProfile = "",
    agent: StepAgent = "claude",
  ): Promise<string | null> {
    try {
      const { effort, budgetUsd: cap, showThinking } = sessionOptions(mode);
      // A Team chat (M8-03) always has a cap, for it and its workers together.
      const budgetUsd = team ? (cap ?? TEAM_CAP_USD) : cap;
      // Before the session starts, so what's applied (plugins, settings) is there from its first turn.
      const applied = settings?.autoApply ? await autoApply(dir) : [];
      const { sessionId } = await request("session.start", {
        cwd: dir,
        permissionMode: fitMode(agent, mode),
        // Another agent's chat takes its own models, so a Claude model picked isn't sent (M9-09).
        ...(modelAlias && agent === "claude" ? { model: modelAlias } : {}),
        ...(effort ? { effort } : {}),
        ...(budgetUsd ? { maxBudgetUsd: budgetUsd } : {}),
        showThinking,
        ...(folders.length ? { folders } : {}),
        ...(team ? { team } : {}),
        ...(agentProfile ? { profile: agentProfile } : {}),
        // A chat on another agent (M9-09): its own models, so the Claude model picked isn't sent.
        ...(agent !== "claude" ? { agent } : {}),
      });
      const items = [
        notice(startedNotice(dir, folders, agentProfile)),
        ...(team && budgetUsd ? [notice(t("app.session.teamChat", { cap: usd(budgetUsd) }))] : []),
        ...applied.map(notice),
      ];
      setTabs((ts) => [
        ...ts,
        newTab(sessionId, dir, {
          title: t("app.session.newTitle"),
          untitled: true,
          mode,
          items,
          modelAlias,
          effort,
          budgetUsd,
          folders,
          ...(agentProfile ? { profile: agentProfile } : {}),
          ...(team && budgetUsd ? { teamCapUsd: budgetUsd } : {}),
          agent,
        }),
      ]);
      setActive(sessionId);
      setRuntimeNotice(null);
      // A multi-folder chat's folders are remembered, so resuming it later reaches them again (M8-07).
      await rememberWorkspace(dir, { id: sessionId, folders });
      return sessionId;
    } catch (err) {
      setRuntimeNotice(String(err));
      return null;
    }
  }

  /** Resumes a stored session into a tab: replaces its ended tab, or opens a new one (M1-22). */
  async function resume(
    sessionId: string,
    dir: string,
    title: string,
    modelAlias = model,
    known?: string[],
    agent: StepAgent = tabsRef.current.find((x) => x.sessionId === sessionId)?.agent ?? "claude",
  ) {
    // Already open: show it (M1-36). Already being resumed: the first click does it.
    if (tabsRef.current.some((x) => x.sessionId === sessionId && !x.ended)) {
      setActive(sessionId);
      return;
    }
    if (resuming.current.has(sessionId)) return;
    resuming.current.add(sessionId);
    const mode = asMode(settings?.defaultMode);
    try {
      const { effort, budgetUsd, showThinking } = sessionOptions(mode);
      const { events, times } = await request("session.history", {
        cwd: dir,
        sessionId,
        ...(agent !== "claude" ? { agent } : {}),
      });
      // A chat of a multi-folder workspace resumes across the same folders (M8-01): its tab's, or else the ones recorded
      // when it ran, or its named workspace's (M8-07), e.g. opened from the sidebar after a restart, or a fork.
      const folders =
        known ?? tabs.find((x) => x.sessionId === sessionId)?.folders ?? foldersFor(settings, sessionId, dir);
      // …and as the same agent profile (M8-04), when its tab still knows it.
      const asProfile = tabs.find((x) => x.sessionId === sessionId)?.profile;
      await request("session.start", {
        cwd: dir,
        resume: sessionId,
        ...(asProfile ? { profile: asProfile } : {}),
        // A Codex chat has no plan mode; its own models only (M9-09).
        permissionMode: fitMode(agent, mode),
        ...(modelAlias && agent === "claude" ? { model: modelAlias } : {}),
        ...(agent !== "claude" ? { agent } : {}),
        ...(effort ? { effort } : {}),
        ...(budgetUsd ? { maxBudgetUsd: budgetUsd } : {}),
        showThinking,
        ...(folders.length ? { folders } : {}),
      });
      // A chat with no stored title (an agy chat after a reload, M9-09) goes by its first message, as it did.
      const asked = events.find((e) => e.type === "user.message");
      const shown =
        title === t("app.session.newTitle") && asked?.type === "user.message"
          ? (asked.text.split("\n")[0]?.trim().slice(0, 80) ?? "") || title
          : title;
      const items = closeAssistant(
        // Stored times rebuild the agents' timing for the graph and the timeline (M4-08).
        events.reduce<Item[]>(
          (acc, e, i) => applyEvent(acc, e, times?.[i] ?? undefined),
          [notice(t("app.session.resumed", { title: shown, folder: folderName(dir) }))],
        ),
      );
      const tab = newTab(sessionId, dir, {
        title: shown,
        mode: fitMode(agent, mode),
        items,
        resumed: true,
        modelAlias,
        effort,
        budgetUsd,
        folders,
        ...(asProfile ? { profile: asProfile } : {}),
        agent,
      });
      setTabs((ts) => (ts.some((x) => x.sessionId === sessionId) ? updateTab(ts, sessionId, () => tab) : [...ts, tab]));
      setActive(sessionId);
      await rememberWorkspace(dir, { id: sessionId, folders });
    } catch (err) {
      setRuntimeNotice(String(err));
    } finally {
      resuming.current.delete(sessionId);
    }
  }

  // The chats a reload left without a tab (M1-36), once the settings are in: each is re-attached with its history,
  // under its stored title, and shown as working if it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when orphans arrive; `resume` reads the settings this render has.
  useEffect(() => {
    if (!settings || !orphans.length) return;
    const lost = orphans;
    setOrphans([]);
    void (async () => {
      for (const item of lost) {
        const stored = await request("session.list", { cwd: item.cwd }).catch(() => ({ sessions: [] }));
        const title = stored.sessions.find((x) => x.sessionId === item.sessionId)?.title ?? t("app.session.newTitle");
        await resume(item.sessionId, item.cwd, title, undefined, undefined, item.agent ?? "claude");
        if (item.status === "working") patchTab(item.sessionId, (tab) => ({ ...tab, running: true }));
      }
    })();
  }, [settings, orphans]);

  function openStored(s: SessionInfo) {
    const open = tabs.find((x) => x.sessionId === s.sessionId);
    if (open && !open.ended) setActive(s.sessionId);
    else void resume(s.sessionId, cwd.trim(), s.title, model, undefined, s.agent ?? "claude");
  }

  async function sendText(sessionId: string, text: string, images: Attachment[] = []) {
    const itemId = nextId();
    // A new chat is named by its first message; the flag goes with it.
    patchTab(sessionId, ({ untitled, ...tab }) => ({
      ...tab,
      running: true,
      title: untitled ? text.slice(0, 60) : tab.title,
      items: [
        ...closeAssistant(tab.items),
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
      patchTab(sessionId, (tab) => ({ ...tab, items: setMessageId(tab.items, itemId, messageId) }));
    } catch (err) {
      patchTab(sessionId, (tab) => ({
        ...tab,
        running: false,
        ended: tab.ended || isRpcError(err, RpcErrorCode.noSession),
        items: [...tab.items, notice(String(err))],
      }));
    }
  }

  async function changeMode(sessionId: string, mode: PermissionMode) {
    if (mode === "auto" && tabs.find((x) => x.sessionId === sessionId)?.budgetUsd === null) {
      addNotice(sessionId, t("app.mode.autonomousNeedsCap"));
      return;
    }
    // Shown at once, so Shift+Tab pressed quickly walks on from the mode just picked; put back if the switch fails.
    const before = tabs.find((x) => x.sessionId === sessionId)?.mode;
    patchTab(sessionId, (tab) => ({ ...tab, mode, ...(mode !== "plan" ? { planSwitch: null } : {}) }));
    try {
      await request("session.setMode", { sessionId, mode });
    } catch (err) {
      if (before) patchTab(sessionId, (tab) => ({ ...tab, mode: before }));
      addNotice(sessionId, String(err));
    }
  }

  /** Model and effort switches (M1-15) apply from the next turn. */
  async function changeModel(sessionId: string, alias: string) {
    try {
      await request("session.setModel", { sessionId, model: alias });
      patchTab(sessionId, (tab) => ({ ...tab, modelAlias: alias }));
    } catch (err) {
      addNotice(sessionId, String(err));
    }
  }

  async function changeEffort(sessionId: string, effort: Effort | null) {
    try {
      await request("session.setEffort", { sessionId, effort });
      patchTab(sessionId, (tab) => ({ ...tab, effort }));
    } catch (err) {
      addNotice(sessionId, String(err));
    }
  }

  async function answer(req: PermissionRequest, reply: PermissionAnswer) {
    patchTab(req.sessionId, (tab) => ({
      ...permissionAnswered(tab, req.requestId, Date.now()),
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
  function runCommand(tab: Tab, name: AppCommand, arg: string) {
    const id = tab.sessionId;
    switch (name) {
      case "clear":
        void startSession(tab.cwd, tab.modelAlias, tab.mode, tab.folders, tab.team !== undefined, tab.profile);
        return;
      case "fork":
        void forkTab(id);
        return;
      case "model": {
        const m = arg ? modelFromArg(arg) : null;
        if (m === null) {
          addNotice(id, t("app.command.model", { model: tab.model ?? t("app.command.default") }));
        } else void changeModel(id, m);
        return;
      }
      case "mode": {
        const m = arg ? modeFromArg(arg) : null;
        if (m === null) {
          addNotice(id, t("app.command.mode", { mode: MODE_NAMES[tab.mode] }));
        } else void changeMode(id, m);
        return;
      }
      case "effort": {
        const e = arg ? effortFromArg(arg) : undefined;
        if (e === undefined)
          addNotice(
            id,
            t("app.command.effort", { effort: tab.effort ?? t("app.command.default"), efforts: EFFORTS.join(", ") }),
          );
        else void changeEffort(id, e);
        return;
      }
      case "usage":
        addNotice(id, usageNotice(tab));
        return;
      case "task":
        if (settings?.tasksPreview !== true) {
          addNotice(id, t("app.command.tasksPreviewOff"));
        } else if (arg) void makeTask(tab, arg);
        else addNotice(id, t("app.command.taskNeedsText"));
        return;
      case "help":
        addNotice(id, t("app.command.help", { commands: APP_COMMANDS.map((c) => `/${c.name}`).join(", ") }));
        return;
    }
  }

  async function answerTaskStep(req: PermissionRequest, reply: PermissionAnswer) {
    setTaskApprovals((q) => q.filter((p) => p.requestId !== req.requestId));
    try {
      await request("permission.respond", { sessionId: req.sessionId, requestId: req.requestId, ...reply });
    } catch (err) {
      setRuntimeNotice(t("app.task.answerFailed", { error: String(err) }));
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
      setRuntimeNotice(t("app.task.stopFailed", { error: String(err) }));
    }
  }

  /** "Rewind files to here" (M1-23): preview, confirm with the documented limits, then restore. */
  async function rewind(sessionId: string, messageId: string) {
    try {
      const preview = await request("session.rewind", { sessionId, messageId, dryRun: true });
      if (!preview.canRewind) {
        addNotice(sessionId, t("app.rewind.cant", { reason: preview.error ?? t("app.rewind.noCheckpoint") }));
        return;
      }
      if (preview.filesChanged.length === 0) {
        addNotice(sessionId, t("app.rewind.nothing"));
        return;
      }
      const ok = await confirm({
        title: t("app.rewind.title"),
        body: (
          <>
            <p>{t("app.rewind.files", { insertions: preview.insertions, deletions: preview.deletions })}</p>
            <ul className="file-list">
              {preview.filesChanged.map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
            </ul>
            <p className="muted">{t("app.rewind.limits")}</p>
          </>
        ),
        confirmLabel: t("app.rewind.confirm"),
        danger: true,
      });
      if (!ok) return;
      const done = await request("session.rewind", { sessionId, messageId });
      // The SDK lists the files only on the dry run (CLI 2.1.314), so the count comes from the preview the user confirmed.
      const files = done.filesChanged.length || preview.filesChanged.length;
      addNotice(
        sessionId,
        done.canRewind
          ? t("app.rewind.done", { count: files })
          : t("app.rewind.failed", { error: done.error ?? t("app.unknownError") }),
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
      addNotice(sessionId, t("app.openFailed", { file, error: String(err) }));
    }
  }

  /** Starts a chat nothing was sent to over as a Team chat, or as a plain one (M8-03): the tools come with the start. */
  async function setTeam(tab: Tab, on: boolean) {
    if (!isFresh(tab)) return;
    const id = await startSession(tab.cwd, tab.modelAlias, tab.mode, tab.folders ?? [], on, tab.profile);
    if (!id) return;
    void request("session.close", { sessionId: tab.sessionId }).catch(() => undefined);
    setTabs((ts) => ts.filter((x) => x.sessionId !== tab.sessionId));
  }

  /** A Fleet row's action on a schedule (M8-05). */
  async function scheduleAction(action: ScheduleAction, s: Schedule) {
    try {
      if (action === "edit") {
        const task = await request("task.get", { cwd: s.cwd, id: s.taskId });
        setScheduleTarget({
          cwd: s.cwd,
          taskId: s.taskId,
          title: s.title,
          budgetUsd: task.triage?.budgetUsd ?? null,
          ...(task.run?.model ? { model: task.run.model } : {}),
          schedule: s,
        });
      } else if (action === "toggle") {
        await request("schedule.save", {
          cwd: s.cwd,
          id: s.id,
          taskId: s.taskId,
          cadence: s.cadence,
          enabled: !s.enabled,
        });
      } else if (action === "run") {
        await request("schedule.runNow", { cwd: s.cwd, id: s.id });
      } else if (
        await confirm({
          title: t("app.schedule.deleteTitle", { title: s.title }),
          body: <p>{t("app.schedule.deleteBody")}</p>,
          confirmLabel: t("app.schedule.deleteConfirm"),
          danger: true,
        })
      ) {
        await request("schedule.delete", { cwd: s.cwd, id: s.id });
      }
    } catch (err) {
      setRuntimeNotice(t("app.schedule.failed", { error: String(err) }));
    }
  }

  function closeTab(sessionId: string) {
    const tab = tabs.find((x) => x.sessionId === sessionId);
    if (tab && !tab.ended) void request("session.close", { sessionId }).catch(() => undefined);
    const rest = tabs.filter((x) => x.sessionId !== sessionId);
    setTabs(rest);
    setTerminals((open) => withToggled(open, sessionId, false));
    if (active === sessionId) setActive(rest.at(-1)?.sessionId ?? null);
  }

  /** Renames the session in the SDK's session store too, so the stored list shows the same title (M1-24). */
  async function renameTab(sessionId: string, title: string) {
    const tab = tabs.find((x) => x.sessionId === sessionId);
    if (!tab) return;
    patchTab(sessionId, (x) => ({ ...x, title }));
    try {
      await request("session.rename", { cwd: tab.cwd, sessionId, title });
    } catch (err) {
      addNotice(sessionId, t("app.session.renameFailed", { error: String(err) }));
    }
  }

  /** Forks a session (M1-24) and opens the copy in a new tab. */
  async function forkTab(sessionId: string) {
    const tab = tabs.find((x) => x.sessionId === sessionId);
    if (!tab) return;
    try {
      const forked = await request("session.fork", { cwd: tab.cwd, sessionId });
      // The fork has no tab yet: it takes the original's folders (M8-07).
      await resume(
        forked.sessionId,
        tab.cwd,
        t("app.session.forkTitle", { title: tab.title }),
        tab.modelAlias,
        tab.folders ?? [],
      );
    } catch (err) {
      addNotice(sessionId, t("app.session.forkFailed", { error: String(err) }));
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
      all.some((x) => x.id === id)
        ? all
        : [
            ...all,
            {
              id,
              cwd: dir,
              title: options.title ?? t("app.task.defaultTitle"),
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
  async function makeTask(tab: Tab, text: string) {
    try {
      const context = isFresh(tab) ? "" : chatContext(tab.items);
      const created = await request("task.create", {
        cwd: tab.cwd,
        request: text,
        ...(context ? { context } : {}),
        // A chat across a workspace's folders makes a task across them (M8-01).
        ...(tab.folders?.length ? { folders: tab.folders } : {}),
      });
      if (isFresh(tab)) closeTab(tab.sessionId);
      openTask(tab.cwd, created.id, { autoDraft: true, model: tab.modelAlias, title: text.slice(0, 60) });
    } catch (err) {
      addNotice(tab.sessionId, t("app.task.makeFailed", { error: String(err) }));
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
      setRuntimeNotice(t("app.workspace.saveFailed", { error: String(err) }));
    }
  }

  async function deleteWorkspaceDef(def: WorkspaceDef) {
    if (!settings) return;
    const ok = await confirm({
      title: t("app.workspace.removeTitle", { name: def.name }),
      body: <p>{t("app.workspace.removeBody")}</p>,
      confirmLabel: t("app.workspace.removeConfirm"),
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
      if (path) setRuntimeNotice(t("app.diagnostics.saved", { path }));
    } catch (err) {
      setRuntimeNotice(t("app.diagnostics.failed", { error: String(err) }));
    }
  }

  /**
   * New in Task mode (UX-13): a new chat in the active tab's folder, or Home's, with its composer set to Task. With no
   * folder yet, Home asks for one. Only with the Tasks preview on.
   */
  async function newTask() {
    if (settings?.tasksPreview !== true) return;
    const open = tabs.find((x) => x.sessionId === active) ?? taskTabs.find((x) => taskKey(x.id) === active);
    const dir = open?.cwd ?? cwd.trim();
    if (!dir) return show(null);
    const folders = open && "sessionId" in open ? open.folders : open ? [] : homeDef?.folders;
    const id = await startSession(dir, model, mode, folders ?? []);
    if (id) patchTab(id, (x) => ({ ...x, kind: "task" }));
  }

  const toggleTerminal = (sessionId: string) =>
    setTerminals((open) => withToggled(open, sessionId, !open.has(sessionId)));

  const menuHandlers: Record<MenuCommand, () => void> = {
    "new-session": () => setNewSession(true),
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
  };
  useMenuCommands(menuHandlers);

  const activeTab = tabs.find((x) => x.sessionId === active);
  // Claude's questions are cards in the thread (UX-12), not this dialog.
  const permission = activeTab?.permissions.find((p) => p.toolName !== "AskUserQuestion");
  // A task step's approval shows when the active session has none waiting.
  // A step's approval shows as a card in its task's thread (UX-13); only one whose task has no open thread is a dialog.
  const threaded = new Set(taskTabs.flatMap((x) => shownTasks[x.id] ?? [x.id]));
  const stepApproval = permission ? undefined : taskApprovals.find((p) => !p.task || !threaded.has(p.task.id));
  const workspace = cwd.trim();
  // The named workspace picked on Home, while Home's folder is still its primary folder.
  const homeDef =
    settings?.workspaces.find((w) => w.id === wsId && workspace && folderKey(w.primary) === folderKey(workspace)) ??
    null;

  /** Everything the command palette offers (UX-07), built from the same actions as the menu and the views. */
  function paletteCommands(): PaletteCommand[] {
    const cur = activeTab;
    const cmds: PaletteCommand[] = [];
    const add = (group: string, id: string, title: string, run: () => void, extra: Partial<PaletteCommand> = {}) =>
      cmds.push({ group, id, title, run, ...extra });
    const session = t("app.palette.groupSession");
    const goTo = t("app.palette.groupGoTo");
    const view = t("app.palette.groupView");
    const app = t("app.palette.groupApp");

    add(session, "new-session", t("app.palette.newSession"), () => setNewSession(true), {
      shortcut: menuShortcut("new-session"),
    });
    add(session, "fleet", t("app.palette.fleet"), () => show(FLEET));
    add(session, "usage", t("app.palette.usage"), () => show(USAGE));
    if (settings?.tasksPreview === true)
      add(session, "new-task", t("app.palette.newTask"), newTask, { shortcut: menuShortcut("new-task") });
    add(session, "open-folder", t("app.palette.openFolder"), () => void openFolder(), {
      shortcut: menuShortcut("open-folder"),
    });
    if (cur) {
      if (cur.running)
        add(
          session,
          "stop",
          t("app.palette.stop"),
          () => void request("session.interrupt", { sessionId: cur.sessionId }),
          {
            shortcut: "Esc",
          },
        );
      if (cur.ended)
        add(session, "resume", t("app.palette.resume"), () => void resume(cur.sessionId, cur.cwd, cur.title));
      add(session, "fork", t("app.palette.fork"), () => void forkTab(cur.sessionId));
      add(session, "close-session", t("app.palette.closeSession"), () => closeTab(cur.sessionId), {
        shortcut: menuShortcut("close-session"),
      });
      if (!cur.ended) {
        for (const m of agentModes(cur.agent))
          if (m !== cur.mode)
            add(
              session,
              `mode-${m}`,
              t("app.palette.mode", { mode: MODE_NAMES[m] }),
              () => void changeMode(cur.sessionId, m),
            );
        for (const m of modelChoices(cur.models.length ? cur.models : undefined))
          if (m.value && m.value !== cur.modelAlias)
            add(
              session,
              `model-${m.value}`,
              t("app.palette.model", { model: m.label }),
              () => void changeModel(cur.sessionId, m.value),
            );
      }
    }

    for (const tab of tabs)
      if (tab.sessionId !== active)
        add(goTo, `tab-${tab.sessionId}`, tab.title, () => show(tab.sessionId), { hint: folderName(tab.cwd) });
    for (const dir of settings?.recentWorkspaces ?? [])
      add(
        goTo,
        `workspace-${dir}`,
        t("app.palette.openWorkspace", { folder: folderName(dir) }),
        () => openWorkspace(dir),
        {
          hint: dir,
        },
      );

    const dir = cur?.cwd ?? (workspace || null);
    if (dir) {
      const views: [SetupView, string][] = [
        ["overview", t("app.palette.setupOverview")],
        ["plan", t("app.palette.setupPlan")],
        ["commands", t("app.palette.setupCommands")],
        ["agents", t("app.palette.setupAgents")],
        ["plugins", t("app.palette.setupPlugins")],
        ["permissions", t("app.palette.setupPermissions")],
        ["workflows", t("app.palette.setupWorkflows")],
        ["deploy", t("app.palette.setupDeploy")],
        ["metrics", t("app.palette.setupMetrics")],
        ["history", t("app.palette.setupHistory")],
      ];
      for (const [setupView, title] of views)
        add(
          t("app.palette.groupWorkspace"),
          `setup-${setupView}`,
          title,
          () => setSetup({ cwd: dir, model: cur?.modelAlias ?? model, back: cur?.sessionId ?? null, view: setupView }),
          { hint: folderName(dir) },
        );
    }

    add(view, "toggle-sidebar", t("app.palette.toggleSidebar"), () => setSidebarOpen((v) => !v), {
      shortcut: menuShortcut("toggle-sidebar"),
    });
    add(view, "toggle-right-panel", t("app.palette.toggleRightPanel"), () => setRightOpen((v) => !v), {
      shortcut: menuShortcut("toggle-right-panel"),
    });
    if (cur)
      add(view, "toggle-terminal", t("app.palette.toggleTerminal"), () => toggleTerminal(cur.sessionId), {
        shortcut: menuShortcut("toggle-terminal"),
      });
    for (const tab of PANEL_TABS) {
      const hidden = hiddenTabs.includes(tab);
      const label = PANEL_TAB_LABEL[tab];
      add(
        view,
        `panel-${tab}`,
        hidden ? t("app.palette.showTab", { tab: label }) : t("app.palette.hideTab", { tab: label }),
        () => setHiddenTabs((h) => toggleHidden(h, tab)),
      );
    }
    if (hiddenTabs.length) add(view, "panel-all", t("app.palette.showAllTabs"), () => setHiddenTabs(() => []));
    if (settings)
      for (const theme of THEMES)
        if (asTheme(settings.theme) !== theme.value)
          add(
            view,
            `theme-${theme.value}`,
            t("app.palette.theme", { theme: theme.label }),
            () => void onSaveSettings({ ...settings, theme: theme.value }),
          );

    add(app, "settings", t("app.palette.settings"), () => setSettingsOpen(true), {
      shortcut: menuShortcut("settings"),
    });
    add(app, "check-updates", t("app.palette.checkUpdates"), () => setUpdatesOpen(true));
    add(app, "export-diagnostics", t("app.palette.exportDiagnostics"), () => void exportFromMenu());
    add(
      app,
      "getting-started",
      t("app.palette.gettingStarted"),
      () => void openUrl(`${REPO}/blob/main/docs/guides/AUTH_SETUP.md`),
    );
    add(app, "report-issue", t("app.palette.reportIssue"), () => void openUrl(`${REPO}/issues/new`));
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
        <TitleBar
          title={titleOf(activeTab?.cwd ?? taskTabs.find((x) => taskKey(x.id) === active)?.cwd ?? workspace)}
          tasks={settings?.tasksPreview === true}
          sidebarOpen={sidebarOpen}
          rightOpen={rightOpen}
          terminalOpen={activeTab ? terminals.has(activeTab.sessionId) : null}
          onCommand={(c) => menuHandlers[c]()}
        />
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
                onNew={() => {
                  show(null);
                  setNewSession(true);
                }}
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
          {sidebarOpen && <Separator className="resize-handle" aria-label={t("app.shell.resizeSidebar")} />}
          <Panel id="main" minSize={480}>
            <main className="main">
              {runtimeNotice && (
                <div className="banner" role="status">
                  <span className="grow">{runtimeNotice}</span>
                  <IconButton label={t("app.shell.dismiss")} onClick={() => setRuntimeNotice(null)}>
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
                      ).catch((err: unknown) => setRuntimeNotice(t("app.fleet.stopFailed", { error: String(err) })))
                    }
                    onClearEnded={() =>
                      setFleet((f) => Object.fromEntries(Object.entries(f).filter(([, i]) => i.status !== "ended")))
                    }
                    schedules={Object.values(schedules)}
                    onSchedule={(action, s) => void scheduleAction(action, s)}
                  />
                )}
                {active === USAGE && !setup && <UsagePage workspaces={knownWorkspaces} />}
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
                    onNewSession={() => setNewSession(true)}
                    {...(settings?.tasksPreview === true ? { onNewTask: () => void newTask() } : {})}
                    onNewWorkspace={() => setWsDialog("new")}
                    onOpenSetup={() =>
                      setSetup({
                        cwd: workspace,
                        model,
                        back: null,
                        ...(homeDef ? { folders: [homeDef.primary, ...homeDef.folders] } : {}),
                      })
                    }
                    openIds={new Set(tabs.filter((x) => !x.ended).map((x) => x.sessionId))}
                    onOpenStored={openStored}
                    confirm={confirm}
                    workspaces={
                      settings && (
                        <WorkspacesCard
                          workspaces={settings.workspaces}
                          selected={homeDef}
                          onPick={openWorkspaceDef}
                          onNew={() => setWsDialog("new")}
                          onEdit={setWsDialog}
                          onDelete={(def) => void deleteWorkspaceDef(def)}
                        />
                      )
                    }
                  >
                    {settings?.tasksPreview === true && hello !== null && workspace && (
                      <HomeTasks cwd={workspace} onOpen={(id, title) => openTask(workspace, id, { title })} />
                    )}
                  </HomeView>
                )}
                {tabs.map((tab) => (
                  <SessionView
                    key={tab.sessionId}
                    tab={tab}
                    hidden={tab.sessionId !== active || setup !== null}
                    panelTab={panelTab}
                    hiddenTabs={hiddenTabs}
                    onHiddenTabsChange={(next) => setHiddenTabs(() => next)}
                    showFirstChange={showFirstChange}
                    rightOpen={rightOpen}
                    terminalOpen={terminals.has(tab.sessionId)}
                    onToggleRight={() => setRightOpen((v) => !v)}
                    onToggleTerminal={() => toggleTerminal(tab.sessionId)}
                    onSend={(text, images) => void sendText(tab.sessionId, text, images)}
                    {...(settings?.tasksPreview === true ? { onTask: (text: string) => void makeTask(tab, text) } : {})}
                    onTeam={(on) => void setTeam(tab, on)}
                    onCommand={(name, arg) => runCommand(tab, name, arg)}
                    onAnswer={(req, reply) => void answer(req, reply)}
                    onInterrupt={() => void request("session.interrupt", { sessionId: tab.sessionId })}
                    onStopAgent={async (taskId) => {
                      await request("session.stopAgent", { sessionId: tab.sessionId, taskId });
                    }}
                    onModeChange={(m) => void changeMode(tab.sessionId, m)}
                    onModelChange={(alias) => void changeModel(tab.sessionId, alias)}
                    onEffortChange={(effort) => void changeEffort(tab.sessionId, effort)}
                    onRewind={(messageId) => void rewind(tab.sessionId, messageId)}
                    onResume={() => void resume(tab.sessionId, tab.cwd, tab.title)}
                    onRename={(title) => void renameTab(tab.sessionId, title)}
                    onFork={() => void forkTab(tab.sessionId)}
                    onClose={() => closeTab(tab.sessionId)}
                    onOpenFile={(file, line) => void openInEditor(tab.sessionId, tab.cwd, file, line)}
                    onOpenSetup={(dir) =>
                      setSetup({
                        cwd: dir ?? tab.cwd,
                        model: tab.modelAlias,
                        back: tab.sessionId,
                        ...(tab.folders?.length ? { folders: [tab.cwd, ...tab.folders] } : {}),
                      })
                    }
                    confirm={confirm}
                  />
                ))}
                {setup && (
                  <Suspense fallback={<div className="setup-page" />}>
                    <SetupPage
                      key={`${setup.cwd}-${setup.view ?? "overview"}`}
                      cwd={setup.cwd}
                      model={setup.model}
                      backLabel={setup.back ? t("app.setup.backToSession") : t("app.setup.backToHome")}
                      confirm={confirm}
                      onBack={() => setSetup(null)}
                      {...(setup.view ? { initialView: setup.view } : {})}
                      folders={setup.folders ?? []}
                      onFolderChange={(dir) => setSetup({ ...setup, cwd: dir })}
                      workspaces={knownWorkspaces}
                    />
                  </Suspense>
                )}
                {taskTabs.length > 0 && (
                  <Suspense fallback={null}>
                    {taskTabs.map((task) => (
                      <TaskPage
                        key={`${task.cwd}-${task.id}`}
                        cwd={task.cwd}
                        taskId={task.id}
                        model={task.model}
                        mode={mode}
                        hidden={active !== taskKey(task.id) || setup !== null}
                        autoDraft={task.autoDraft}
                        confirm={confirm}
                        onClose={() => closeTaskTab(task.id)}
                        onChange={onTaskChange}
                        approvals={taskApprovals}
                        onAnswerApproval={(req, reply) => void answerTaskStep(req, reply)}
                        onStopFromApproval={(req) => void stopTaskStep(req)}
                        onSchedule={(scheduled) =>
                          setScheduleTarget({
                            cwd: task.cwd,
                            taskId: scheduled.id,
                            title: scheduled.title ?? scheduled.request,
                            budgetUsd: scheduled.triage?.budgetUsd ?? null,
                            ...(scheduled.run?.model ? { model: scheduled.run.model } : {}),
                          })
                        }
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
        <NewSessionDialog
          open={newSession}
          onOpenChange={setNewSession}
          ready={env?.ready === true}
          homeDir={hello?.homeDir ?? null}
          cwd={cwd}
          onCwdChange={(dir) => {
            setCwd(dir);
            setWsId(null);
          }}
          recent={settings?.recentWorkspaces ?? []}
          workspaces={settings?.workspaces ?? []}
          onPickWorkspace={(def) => {
            setCwd(def.primary);
            setWsId(def.id);
          }}
          model={model}
          onModelChange={setModel}
          mode={mode}
          onModeChange={setMode}
          profile={profile}
          onProfileChange={setProfile}
          canAutonomous={settings?.budgetUsd != null}
          agent={newAgent}
          onAgentChange={setNewAgent}
          onStart={() => {
            setNewSession(false);
            void startSession(
              workspace,
              newAgent === "claude" ? model : "",
              mode,
              homeDef?.folders ?? [],
              false,
              newAgent === "claude" ? profile : "",
              newAgent,
            );
          }}
        />
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
        {scheduleTarget && (
          <ScheduleDialog
            target={scheduleTarget}
            onClose={() => setScheduleTarget(null)}
            onSaved={(s) => {
              setSchedules((all) => ({ ...all, [`${s.cwd}|${s.id}`]: s }));
              // Remembered, so its schedules are watched again after a restart.
              void rememberWorkspace(s.cwd);
            }}
          />
        )}
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

/** What the title bar's search field names: the open workspace's folder, or the app. */
function titleOf(dir: string): string {
  return dir ? t("app.shell.titleWithFolder", { folder: folderName(dir), app: APP_NAME }) : APP_NAME;
}

/** The first notice of a new chat: where it runs, with which other folders, as which agent profile. */
function startedNotice(dir: string, folders: string[], profile: string): string {
  const folder = folderName(dir);
  const others = folders.map(folderName).join(", ");
  if (folders.length && profile)
    return t("app.session.startedWithFoldersAsProfile", { folder, folders: others, profile });
  if (folders.length) return t("app.session.startedWithFolders", { folder, folders: others });
  if (profile) return t("app.session.startedAsProfile", { folder, profile });
  return t("app.session.started", { folder });
}

/** What `/usage` says as a notice: the chat's spend, against its cap, and how full its context window is. */
function usageNotice(tab: Tab): string {
  const spent = tab.cost.totalUsd === null ? t("app.command.spentUnknown") : approxUsd(tab.cost.totalUsd, 4);
  const cap = tab.budgetUsd !== null ? dollars(tab.budgetUsd, 2) : null;
  const c = tab.context;
  if (!c) return cap ? t("app.command.usageCap", { spent, cap }) : t("app.command.usage", { spent });
  const context = {
    spent,
    percent: Math.round(c.percentage),
    used: count(c.totalTokens),
    max: count(c.maxTokens),
  };
  return cap ? t("app.command.usageCapContext", { ...context, cap }) : t("app.command.usageContext", context);
}
