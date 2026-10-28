import {
  type AgentEvent,
  type EnvCheck,
  type Methods,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRequest,
  PROTOCOL_VERSION,
} from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Readiness } from "./Readiness.tsx";
import { MODE_LABELS, MODELS, SettingsPanel } from "./SettingsPanel.tsx";
import { quitApp, readSelftestConfig } from "./selftest.ts";
import { loadSettings, type Settings, saveSettings, withRecent } from "./settings.ts";
import { connect, onExit, onReady, request, requestWithTimeout, subscribe, takeDeltaLatencies } from "./sidecar.ts";
import { latencyStats } from "./stats.ts";
import { type AgentItem, applyEvent, closeAssistant, type Item, nextId, type ToolItem } from "./transcript.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import "./App.css";

/** Guards against React StrictMode running the mount effect twice in dev. */
let selftestStarted = false;

const PING_EVERY_MS = 20_000;
const PING_TIMEOUT_MS = 5_000;

// App shell (M1-01…M1-07) around the spike session UI (S2–S5). The full session core is the rest of M1, and the
// visual design pass is the UX track.

type Hello = Methods["system.hello"]["result"];

const asMode = (value: string | null | undefined): PermissionMode =>
  PERMISSION_MODES.find((m) => m === value) ?? "default";

export function App() {
  const [hello, setHello] = useState<Hello | null>(null);
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [runtimeNotice, setRuntimeNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [session, setSession] = useState<{ model?: string; claudeCodeVersion?: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [cost, setCost] = useState({ lastUsd: 0, totalUsd: 0, lastMs: 0 });
  const bottomRef = useRef<HTMLDivElement>(null);
  const selftestActive = useRef(false);
  /** True while the sidecar answers; the health ping only runs then, so a starting sidecar isn't restarted. */
  const alive = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once on mount; the handlers only call state setters, which are stable.
  useEffect(() => {
    connect()
      .then(() => Promise.all([loadSettings(), handshake()]))
      .then(async ([loaded, checked]) => {
        applySettings(loaded);
        const cfg = await readSelftestConfig();
        if (!cfg || !checked.ready || selftestStarted) return;
        selftestStarted = true;
        selftestActive.current = true;
        setCwd(cfg.cwd);
        takeDeltaLatencies();
        await startSession(cfg.cwd, cfg.model ?? "", "default");
        await sendText(cfg.prompt);
      })
      .catch((err: unknown) => setRuntimeNotice(String(err)));

    // Supervisor events (M1-01): the session dies with the process; a restarted sidecar needs a new handshake.
    const offExit = onExit((exit) => {
      alive.current = false;
      setRunning(false);
      setPermissions([]);
      setSession((s) => {
        if (s) setItems((prev) => [...prev, { kind: "notice", id: nextId(), text: "The agent runtime stopped." }]);
        return null;
      });
      setRuntimeNotice(
        `The agent runtime stopped (${exit.status})${exit.restarting ? " and is restarting…" : "."} Any running session ended.`,
      );
    });
    const offReady = onReady(() => {
      void handshake()
        .then(() => setRuntimeNotice((n) => (n ? "The agent runtime restarted. Start a new session." : null)))
        .catch(() => undefined);
    });
    const offEvents = subscribe((n) => {
      if (n.method === "permission.request") setPermissions((q) => [...q, n.params]);
      else onAgentEvent(n.params);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the transcript changes.
  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [items]);

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

  async function reportSelftest(e: Extract<AgentEvent, { type: "turn.completed" }>) {
    const stats = latencyStats(takeDeltaLatencies());
    const report = {
      selftest: { deltaLatencyMs: stats, turnMs: e.durationMs, costUsd: e.costUsd, subtype: e.subtype },
    };
    await request("debug.log", { message: JSON.stringify(report) });
    await quitApp();
  }

  function onAgentEvent(e: AgentEvent) {
    if (e.type === "session.started") {
      // Arrives at the start of every turn (spike S2 finding), so this must stay idempotent.
      setSession({ model: e.model, claudeCodeVersion: e.claudeCodeVersion });
      setMode(asMode(e.permissionMode));
      return;
    }
    if (e.type === "turn.completed") {
      setRunning(false);
      setCost((c) => ({ lastUsd: e.costUsd, totalUsd: c.totalUsd + e.costUsd, lastMs: e.durationMs }));
      if (selftestActive.current) {
        selftestActive.current = false;
        void reportSelftest(e);
      }
    }
    if (e.type === "error") setRunning(false);
    setItems((prev) => applyEvent(prev, e));
  }

  async function startSession(dir: string, modelAlias: string, permissionMode: PermissionMode) {
    try {
      await request("session.start", { cwd: dir, permissionMode, ...(modelAlias ? { model: modelAlias } : {}) });
      setSession({});
      setMode(permissionMode);
      setRuntimeNotice(null);
      setItems([{ kind: "notice", id: nextId(), text: `Session started in ${dir}` }]);
      if (settings) setSettings(await saveSettings(withRecent(settings, dir)));
    } catch (err) {
      setItems((prev) => [...prev, { kind: "notice", id: nextId(), text: String(err) }]);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    await sendText(text);
  }

  async function sendText(text: string) {
    setRunning(true);
    setItems((prev) => [...closeAssistant(prev), { kind: "user", id: nextId(), text }]);
    try {
      await request("session.send", { text });
    } catch (err) {
      setRunning(false);
      setItems((prev) => [...prev, { kind: "notice", id: nextId(), text: String(err) }]);
    }
  }

  async function changeMode(next: PermissionMode) {
    try {
      await request("session.setMode", { mode: next });
      setMode(next);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "notice", id: nextId(), text: String(err) }]);
    }
  }

  async function answer(req: PermissionRequest, allow: boolean) {
    setPermissions((q) => q.filter((p) => p.requestId !== req.requestId));
    await request("permission.respond", { requestId: req.requestId, allow });
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const permission = permissions[0];

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

      {!session ? (
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
            disabled={!env?.ready || !cwd.trim()}
            onClick={() => void startSession(cwd.trim(), model, asMode(settings?.defaultMode))}
          >
            Start session
          </button>
          {settings && <SettingsPanel key={JSON.stringify(settings)} settings={settings} onSave={onSaveSettings} />}
        </section>
      ) : (
        <>
          <main className="transcript">
            {items.map((it) => (
              <ItemView key={`${it.kind}-${it.id}`} item={it} />
            ))}
            {running && <div className="muted thinking">Working…</div>}
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
              <select
                value={mode}
                onChange={(e) => void changeMode(asMode(e.target.value))}
                aria-label="Permission mode"
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>
              <span className="muted grow">
                {session.model ?? "…"} · last turn ≈${cost.lastUsd.toFixed(4)} ({(cost.lastMs / 1000).toFixed(1)} s) ·
                session ≈${cost.totalUsd.toFixed(4)} (estimate)
              </span>
              {running ? (
                <button type="button" className="secondary" onClick={() => void request("session.interrupt", {})}>
                  Stop
                </button>
              ) : (
                <button type="button" disabled={!draft.trim()} onClick={() => void send()}>
                  Send
                </button>
              )}
            </div>
          </footer>
        </>
      )}

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
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return <div className="msg assistant">{item.text}</div>;
    case "notice":
      return <div className="notice">{item.text}</div>;
    case "tool":
      return <ToolView tool={item} />;
    case "agent":
      return <AgentView agent={item} />;
  }
}

function ToolView({ tool }: { tool: ToolItem }) {
  const blocked = tool.output?.includes("Blocked by AgentChainer guard") ?? false;
  return (
    <details className={`tool ${tool.status}`} open={blocked}>
      <summary>
        <StatusIcon status={tool.status} />
        {tool.name} <code>{toolSummary(tool.input)}</code>
        {blocked && <span className="badge">blocked by guard</span>}
      </summary>
      <pre>{JSON.stringify(tool.input, null, 2)}</pre>
      {tool.output !== undefined && <pre className="tool-output">{tool.output}</pre>}
    </details>
  );
}

function AgentView({ agent }: { agent: AgentItem }) {
  const meta = [
    agent.agentType,
    agent.durationMs !== undefined ? `${(agent.durationMs / 1000).toFixed(1)} s` : null,
    agent.tokens !== undefined ? `${agent.tokens.toLocaleString()} tokens` : null,
  ].filter(Boolean);
  return (
    <details className={`agent ${agent.status}`} open={agent.status === "running"}>
      <summary>
        <StatusIcon status={agent.status} />
        <strong>Subagent</strong> {agent.description}
        {meta.length > 0 && <span className="muted">{meta.join(" · ")}</span>}
      </summary>
      <div className="agent-children">
        {agent.children.map((c) =>
          c.kind === "tool" ? (
            <ToolView key={`tool-${c.id}`} tool={c} />
          ) : (
            <div key={`text-${c.id}`} className="msg agent-text">
              {c.text}
            </div>
          ),
        )}
        {agent.summary && <div className="agent-summary">{agent.summary}</div>}
      </div>
    </details>
  );
}

function StatusIcon({ status }: { status: "running" | "done" | "error" }) {
  return <span className="tool-status">{status === "running" ? "⋯" : status === "done" ? "✓" : "✕"}</span>;
}

function toolSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const v = o.command ?? o.file_path ?? o.pattern ?? o.url ?? o.description;
    if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  return "";
}
