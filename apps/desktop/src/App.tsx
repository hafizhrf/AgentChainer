import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PERMISSION_MODES, type AgentEvent, type Methods, type PermissionMode, type PermissionRequest } from "@agentchainer/protocol";
import { connect, onExit, request, subscribe } from "./sidecar.ts";
import "./App.css";

// Spike S2/S3 UI: one session, streaming text, tool cards, approvals. The real session core is M1.

type Hello = Methods["system.hello"]["result"];
type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; open: boolean }
  | { kind: "tool"; id: string; name: string; input: unknown; status: "running" | "done" | "error"; output?: string }
  | { kind: "notice"; id: number; text: string };

const MODELS = [
  { value: "", label: "Default (from your Claude settings)" },
  { value: "haiku", label: "Haiku (fast, cheap)" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Ask before edits and commands",
  acceptEdits: "Auto-accept file edits",
  plan: "Plan only (no changes)",
};

let seq = 0;

export function App() {
  const [hello, setHello] = useState<Hello | null>(null);
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

  useEffect(() => {
    connect()
      .then(() => request("system.hello", { protocolVersion: 1 }))
      .then((h) => {
        setHello(h);
        setCwd((current) => current || h.homeDir);
      })
      .catch((err: unknown) => setFatal(String(err)));

    const offExit = onExit((status) => setFatal(`Sidecar exited: ${status}`));
    const offEvents = subscribe((n) => {
      if (n.method === "permission.request") setPermissions((q) => [...q, n.params]);
      else applyEvent(n.params);
    });
    return () => {
      offExit();
      offEvents();
    };
  }, []);

  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [items]);

  function applyEvent(e: AgentEvent) {
    switch (e.type) {
      case "session.started": {
        // Arrives at the start of every turn (spike S2 finding), so this must stay idempotent.
        setSession({ model: e.model, claudeCodeVersion: e.claudeCodeVersion });
        const reported = PERMISSION_MODES.find((m) => m === e.permissionMode);
        if (reported) setMode(reported);
        break;
      }
      case "text.delta":
        setItems((prev) => {
          const last = prev.at(-1);
          if (last?.kind === "assistant" && last.open) {
            return [...prev.slice(0, -1), { ...last, text: last.text + e.text }];
          }
          return [...prev, { kind: "assistant", id: ++seq, text: e.text, open: true }];
        });
        break;
      case "tool.started":
        setItems((prev) => [
          ...closeAssistant(prev),
          { kind: "tool", id: e.toolUseId, name: e.name, input: e.input, status: "running" },
        ]);
        break;
      case "tool.completed":
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "tool" && it.id === e.toolUseId
              ? { ...it, status: e.isError ? "error" : "done", output: e.output }
              : it,
          ),
        );
        break;
      case "turn.completed":
        setItems(closeAssistant);
        setRunning(false);
        setCost((c) => ({ lastUsd: e.costUsd, totalUsd: c.totalUsd + e.costUsd, lastMs: e.durationMs }));
        break;
      case "error":
        setItems((prev) => [...closeAssistant(prev), { kind: "notice", id: ++seq, text: e.message }]);
        setRunning(false);
        break;
    }
  }

  async function startSession() {
    try {
      await request("session.start", { cwd, ...(model ? { model } : {}) });
      setSession({});
      setItems([{ kind: "notice", id: ++seq, text: `Session started in ${cwd}` }]);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "notice", id: ++seq, text: String(err) }]);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || running) return;
    setDraft("");
    setRunning(true);
    setItems((prev) => [...closeAssistant(prev), { kind: "user", id: ++seq, text }]);
    try {
      await request("session.send", { text });
    } catch (err) {
      setRunning(false);
      setItems((prev) => [...prev, { kind: "notice", id: ++seq, text: String(err) }]);
    }
  }

  async function changeMode(next: PermissionMode) {
    try {
      await request("session.setMode", { mode: next });
      setMode(next);
    } catch (err) {
      setItems((prev) => [...prev, { kind: "notice", id: ++seq, text: String(err) }]);
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
          {hello && !hello.claudePath && (
            <p className="warn">Claude Code CLI not found. Install it and sign in first (see docs/guides/AUTH_SETUP.md).</p>
          )}
          <label>
            Workspace folder
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
          </label>
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
          <button disabled={!hello?.claudePath || !cwd} onClick={() => void startSession()}>
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
                <button className="secondary" onClick={() => void request("session.interrupt", {})}>
                  Stop
                </button>
              ) : (
                <button disabled={!draft.trim()} onClick={() => void send()}>
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
              <button className="secondary" onClick={() => void answer(permission, false)}>
                Deny
              </button>
              <button onClick={() => void answer(permission, true)}>Allow once</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function closeAssistant(prev: Item[]): Item[] {
  const last = prev.at(-1);
  return last?.kind === "assistant" && last.open ? [...prev.slice(0, -1), { ...last, open: false }] : prev;
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return <div className="msg assistant">{item.text}</div>;
    case "notice":
      return <div className="notice">{item.text}</div>;
    case "tool": {
      const blocked = item.output?.includes("Blocked by AgentChainer guard") ?? false;
      return (
        <details className={`tool ${item.status}`} open={blocked}>
          <summary>
            <span className="tool-status">{item.status === "running" ? "⋯" : item.status === "done" ? "✓" : "✕"}</span>
            {item.name} <code>{toolSummary(item.input)}</code>
            {blocked && <span className="badge">blocked by guard</span>}
          </summary>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.output !== undefined && <pre className="tool-output">{item.output}</pre>}
        </details>
      );
    }
  }
}

function toolSummary(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    const v = o.command ?? o.file_path ?? o.pattern ?? o.url ?? o.description;
    if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  return "";
}
