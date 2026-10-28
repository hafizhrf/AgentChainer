import { invoke } from "@tauri-apps/api/core";

/**
 * Dev-only self-test (spike S2). When the app is launched with `AGENTCHAINER_SELFTEST='{"cwd","model","prompt"}'`
 * (and `AGENTCHAINER_METRICS=1`), the UI runs one turn on its own, logs latency stats through the sidecar, and quits.
 * Driven by scripts/selftest-latency.mjs. Null in normal runs.
 */
export type SelftestConfig = { cwd: string; model?: string; prompt: string };

export async function readSelftestConfig(): Promise<SelftestConfig | null> {
  const raw = await invoke<string | null>("selftest_config");
  if (!raw) return null;
  const cfg = JSON.parse(raw) as Partial<SelftestConfig>;
  if (typeof cfg.cwd !== "string" || typeof cfg.prompt !== "string") return null;
  return { cwd: cfg.cwd, prompt: cfg.prompt, ...(cfg.model ? { model: cfg.model } : {}) };
}

export const quitApp = () => invoke("quit_app");
