import {
  type AgentEvent,
  type EnvCheck,
  type Methods,
  type PermissionMode,
  type PermissionRequest,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type SessionInfo,
} from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "./Dialog.tsx";
import { Readiness } from "./Readiness.tsx";
import { SessionList } from "./SessionList.tsx";
import { SessionView } from "./SessionView.tsx";
import { MODELS, SettingsPanel } from "./SettingsPanel.tsx";
import { quitApp, readSelftestConfig, runSelftest } from "./selftest.ts";
import { loadSettings, type Settings, saveSettings, withRecent } from "./settings.ts";
import { connect, isRpcError, onExit, onReady, request, requestWithTimeout, subscribe } from "./sidecar.ts";
import { asMode, folderName, newTab, type Tab, tabEvent, updateTab } from "./tabs.ts";
import { applyEvent, closeAssistant, type Item, nextId, setMessageId } from "./transcript.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import "./App.css";

/** Guards against React StrictMode running the mount effect twice in dev. */
let selftestStarted = false;

const PING_EVERY_MS = 20_000;
const PING_TIMEOUT_MS = 5_000;
const NEW_TITLE = "New session";

// App shell (M1-01…M1-07) with one session per tab (M1-06/M1-08) and stored sessions (M1-21…M1-24). The visual
// design pass is the UX track.

type Hello = Methods["system.hello"]["result"];
type TurnCompleted = Extract<AgentEvent, { type: "turn.completed" }>;

const notice = (text: string): Item => ({ kind: "notice", id: nextId(), text });

export function App() {
  const [hello, setHello] = useState<Hello | null>(null);
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  /** The active tab's session id; null shows the new-session screen. */
  const [active, setActive] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
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
        await quitApp();
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
      if (event.type === "turn.completed") {
        turnWaiters.current.get(sessionId)?.(event);
        turnWaiters.current.delete(sessionId);
      }
      patchTab(sessionId, (t) => tabEvent(t, event));
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

  async function rememberWorkspace(dir: string) {
    if (settings) setSettings(await saveSettings(withRecent(settings, dir)));
  }

  async function startSession(dir: string, modelAlias: string, mode: PermissionMode): Promise<string | null> {
    try {
      const { sessionId } = await request("session.start", {
        cwd: dir,
        permissionMode: mode,
        ...(modelAlias ? { model: modelAlias } : {}),
      });
      setTabs((ts) => [
        ...ts,
        newTab(sessionId, dir, { title: NEW_TITLE, mode, items: [notice(`Session started in ${dir}`)] }),
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
      const { events } = await request("session.history", { cwd: dir, sessionId });
      await request("session.start", {
        cwd: dir,
        resume: sessionId,
        permissionMode: mode,
        ...(modelAlias ? { model: modelAlias } : {}),
      });
      const items = closeAssistant(events.reduce(applyEvent, [notice(`Resumed “${title}” in ${dir}`)]));
      const tab = newTab(sessionId, dir, { title, mode, items, resumed: true });
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

  async function sendText(sessionId: string, text: string) {
    const itemId = nextId();
    patchTab(sessionId, (t) => ({
      ...t,
      running: true,
      title: t.title === NEW_TITLE ? text.slice(0, 60) : t.title,
      items: [...closeAssistant(t.items), { kind: "user", id: itemId, text }],
    }));
    try {
      const { messageId } = await request("session.send", { sessionId, text });
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
    try {
      await request("session.setMode", { sessionId, mode });
      patchTab(sessionId, (t) => ({ ...t, mode }));
    } catch (err) {
      addNotice(sessionId, String(err));
    }
  }

  async function answer(req: PermissionRequest, allow: boolean) {
    patchTab(req.sessionId, (t) => ({ ...t, permissions: t.permissions.filter((p) => p.requestId !== req.requestId) }));
    await request("permission.respond", { sessionId: req.sessionId, requestId: req.requestId, allow });
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

  function closeTab(sessionId: string) {
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (tab && !tab.ended) void request("session.close", { sessionId }).catch(() => undefined);
    const rest = tabs.filter((t) => t.sessionId !== sessionId);
    setTabs(rest);
    if (active === sessionId) setActive(rest.at(-1)?.sessionId ?? null);
  }

  const activeTab = tabs.find((t) => t.sessionId === active);
  const permission = activeTab?.permissions[0];
  const workspace = cwd.trim();

  return (
    <div className="app">
      <header className="topbar">
        <strong>AgentChainer</strong>
        <span className="muted">
          {hello
            ? `${hello.claudeVersion ?? "claude not found"} · SDK ${hello.sdkVersion} · Node ${hello.nodeVersion}`
            : "Starting the agent runtime…"}
        </span>
      </header>
      {runtimeNotice && <div className="banner">{runtimeNotice}</div>}

      <nav className="tabs" aria-label="Sessions">
        {tabs.map((t) => (
          <div key={t.sessionId} className={`tab${t.sessionId === active ? " active" : ""}`}>
            <button
              type="button"
              className="tab-label"
              aria-current={t.sessionId === active}
              title={`${t.title}\n${t.cwd}`}
              onClick={() => setActive(t.sessionId)}
            >
              <span className="tab-folder">{folderName(t.cwd)}</span> {t.title}
              {t.permissions.length > 0 && <span className="tab-dot" title="Waiting for your approval" />}
              {t.running && <span className="muted"> ⋯</span>}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${t.title}`}
              onClick={() => closeTab(t.sessionId)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className={`tab new${active === null ? " active" : ""}`}
          aria-current={active === null}
          onClick={() => setActive(null)}
        >
          + New session
        </button>
      </nav>

      {active === null && (
        <section className="setup">
          <h1>Start a session</h1>
          <Readiness env={env} checking={checking} onRecheck={() => void recheck()} />
          <WorkspacePicker
            value={cwd}
            onChange={setCwd}
            recent={settings?.recentWorkspaces ?? []}
            homeDir={hello?.homeDir ?? null}
          />
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!env?.ready || !workspace}
            onClick={() => void startSession(workspace, model, asMode(settings?.defaultMode))}
          >
            Start session
          </button>
          {hello && workspace && (
            <SessionList
              cwd={workspace}
              openIds={new Set(tabs.filter((t) => !t.ended).map((t) => t.sessionId))}
              onOpen={openStored}
              confirm={confirm}
            />
          )}
          {settings && <SettingsPanel key={JSON.stringify(settings)} settings={settings} onSave={onSaveSettings} />}
        </section>
      )}

      {tabs.map((t) => (
        <SessionView
          key={t.sessionId}
          tab={t}
          hidden={t.sessionId !== active}
          onSend={(text) => void sendText(t.sessionId, text)}
          onInterrupt={() => void request("session.interrupt", { sessionId: t.sessionId })}
          onModeChange={(mode) => void changeMode(t.sessionId, mode)}
          onRewind={(messageId) => void rewind(t.sessionId, messageId)}
          onResume={() => void resume(t.sessionId, t.cwd, t.title)}
        />
      ))}

      {permission && (
        <div className="overlay">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="perm-title">
            <h2 id="perm-title">Allow {permission.toolName}?</h2>
            {permission.description && <p>{permission.description}</p>}
            {permission.agentId && <p className="muted">Requested by subagent {permission.agentId}</p>}
            <pre>{JSON.stringify(permission.input, null, 2)}</pre>
            <div className="dialog-actions">
              <button type="button" className="secondary" onClick={() => void answer(permission, false)}>
                Deny
              </button>
              <button type="button" onClick={() => void answer(permission, true)}>
                Allow once
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
