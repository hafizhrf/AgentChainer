import {
  type AgentEvent,
  type EnvCheck,
  type Methods,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRequest,
} from "@agentchainer/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { quitApp, readSelftestConfig } from "./selftest.ts";
import { connect, onExit, request, subscribe, takeDeltaLatencies } from "./sidecar.ts";
import { latencyStats } from "./stats.ts";
import { type AgentItem, applyEvent, closeAssistant, type Item, nextId, type ToolItem } from "./transcript.ts";
import "./App.css";

/** Guards against React StrictMode running the mount effect twice in dev. */
let selftestStarted = false;

// Spike UI (S2–S5): readiness check, one session, streaming text, tool and subagent cards, approvals.
// The real session core is M1 and the visual design pass is the UX track.

type Hello = Methods["system.hello"]["result"];

const MODELS = [
  { value: "", label: "Default (from your Claude settings)" },
  { value: "haiku", label: "Haiku (fast, cheap)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask before edits and commands",
  acceptEdits: "Auto-accept file edits (commands still ask)",
  auto: "Auto: Claude decides, asks when unsure",
  plan: "Plan only (no changes)",
};

export function App() {
  const [hello, setHello] = useState<Hello | null>(null);
  const [env, setEnv] = useState<EnvCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once on mount; the handlers only call state setters, which are stable.
  useEffect(() => {
    connect()
      .then(() => request("system.hello", { protocolVersion: 1 }))
      .then((h) => {
        setHello(h);
        return recheck();
      })
      .then(async (checked) => {
        const cfg = await readSelftestConfig();
        if (!cfg || !checked.ready || selftestStarted) return;
        selftestStarted = true;
        selftestActive.current = true;
        setCwd(cfg.cwd);
        takeDeltaLatencies();
        await startSession(cfg.cwd, cfg.model ?? "");
        await sendText(cfg.prompt);
      })
      .catch((err: unknown) => setFatal(String(err)));

    const offExit = onExit((status) => setFatal(`Sidecar exited: ${status}`));
    const offEvents = subscribe((n) => {
      if (n.method === "permission.request") setPermissions((q) => [...q, n.params]);
      else onAgentEvent(n.params);
    });
    return () => {
      offExit();
      offEvents();
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the transcript changes.
  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [items]);

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
      const reported = PERMISSION_MODES.find((m) => m === e.permissionMode);
      if (reported) setMode(reported);
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

  async function startSession(dir: string, modelAlias: string) {
    try {
      await request("session.start", { cwd: dir, ...(modelAlias ? { model: modelAlias } : {}) });
      setSession({});
      setItems([{ kind: "notice", id: nextId(), text: `Session started in ${dir}` }]);
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
          {fatal
            ? fatal
            : hello
              ? `${hello.claudeVersion ?? "claude not found"} · SDK ${hello.sdkVersion} · Node ${hello.nodeVersion}`
              : "Connecting to sidecar…"}
        </span>
      </header>

      {!session ? (
        <section className="setup">
          <h1>Start a session</h1>
          <Readiness env={env} checking={checking} onRecheck={() => void recheck()} />
          <label>
            Workspace folder
            {/* No default: owner testing showed a home-folder workspace lets the agent roam the whole home directory. */}
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={hello ? `e.g. ${hello.homeDir}/projects/my-app` : "Path to a project folder"}
              spellCheck={false}
            />
          </label>
          {hello && cwd.trim().replace(/\/+$/, "") === hello.homeDir && (
            <p className="warn">
              That's your whole home folder. Pick a single project folder so the agent stays inside it.
            </p>
          )}
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
          <button type="button" disabled={!env?.ready || !cwd} onClick={() => void startSession(cwd, model)}>
            Start session
          </button>
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
                onChange={(e) => void changeMode(e.target.value as PermissionMode)}
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

/** Onboarding readiness (spike S5). The app never signs in for the user; it shows the terminal command (ADR-0002). */
function Readiness({ env, checking, onRecheck }: { env: EnvCheck | null; checking: boolean; onRecheck: () => void }) {
  if (!env) return <p className="muted">{checking ? "Checking your setup…" : "Waiting for the sidecar…"}</p>;
  const install =
    env.platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  const rows: { ok: boolean; label: string; fix?: string; command?: string }[] = [
    env.claude.path
      ? { ok: true, label: `Claude Code CLI found (${env.claude.version ?? "version unknown"})` }
      : {
          ok: false,
          label: "Claude Code CLI not found",
          fix: "Install it in your terminal, then open a new terminal:",
          command: install,
        },
  ];
  if (env.claude.path) {
    rows.push(
      env.claude.versionOk
        ? { ok: true, label: `Version ${env.claude.minVersion} or newer` }
        : {
            ok: false,
            label: `Version older than ${env.claude.minVersion}`,
            fix: "Update it in your terminal:",
            command: "claude update",
          },
    );
    rows.push(
      env.auth?.loggedIn
        ? { ok: true, label: `Signed in (${authLabel(env)})` }
        : {
            ok: false,
            label: "Not signed in",
            fix: "Sign in yourself in your terminal (AgentChainer never handles your login):",
            command: "claude auth login",
          },
    );
  }
  rows.push(
    env.git.version
      ? { ok: true, label: env.git.version }
      : { ok: false, label: "git not found", fix: "Install git from https://git-scm.com/downloads." },
  );

  return (
    <div className="readiness">
      <ul>
        {rows.map((r) => (
          <li key={r.label} className={r.ok ? "ok" : "fail"}>
            <span>{r.ok ? "✓" : "✕"}</span>
            <div>
              {r.label}
              {r.fix && <div className="muted">{r.fix}</div>}
              {r.command && <code className="command">{r.command}</code>}
            </div>
          </li>
        ))}
      </ul>
      {!env.ready && (
        <p className="muted">
          Step-by-step guide: <code>docs/guides/AUTH_SETUP.md</code>
        </p>
      )}
      <button type="button" className="secondary" disabled={checking} onClick={onRecheck}>
        {checking ? "Checking…" : "Re-check"}
      </button>
    </div>
  );
}

function authLabel(env: EnvCheck): string {
  const a = env.auth;
  if (!a) return "unknown";
  if (a.method === "claude.ai") return "Claude subscription";
  if (a.method === "api_key") return "API key";
  if (a.method === "third_party") return `cloud provider: ${a.provider}`;
  return a.method;
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
