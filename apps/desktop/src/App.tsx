import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type AppInfo = { name: string; version: string };

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Round-trip to the Rust core proves the UI ⇄ core IPC path works.
    invoke<AppInfo>("app_info").then(setInfo, (e: unknown) => setError(String(e)));
  }, []);

  let status = "Connecting to core…";
  if (error) status = `Core unavailable: ${error}`;
  else if (info) status = `v${info.version} · app shell`;

  return (
    <main className="shell">
      <h1>AgentChainer</h1>
      <p className="tagline">Powered by Claude</p>
      <p className="status">{status}</p>
    </main>
  );
}
