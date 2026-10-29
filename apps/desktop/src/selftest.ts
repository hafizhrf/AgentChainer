import type { AgentEvent } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { takeDeltaLatencies } from "./sidecar.ts";
import { latencyStats } from "./stats.ts";
import type { Tab } from "./tabs.ts";

/**
 * Dev-only self-test (spike S2). When the app is launched with `AGENTCHAINER_SELFTEST='{"cwd","model","prompt"}'`
 * (and `AGENTCHAINER_METRICS=1`), the UI runs one turn on its own, logs latency stats through the sidecar, and quits.
 * With `"resume": true` it then closes the session, resumes it the way the session list does, and runs a second turn
 * (M1-22). With `"stay": true` the app stays open afterwards, in `theme` and with `open` shown (UX screenshots).
 * Driven by scripts/selftest-latency.mjs. Null in normal runs.
 */
/**
 * Views a screenshot run can open: Home, Settings, a session's terminal or right-panel tab, the first changed file's
 * diff, a section of Workspace settings, or a new session with nothing sent yet.
 */
const OPEN_VIEWS = [
  "home",
  "settings",
  "terminal",
  "files",
  "git",
  "diff",
  "setup",
  "plan",
  "permissions",
  "fresh",
] as const;

export type SelftestConfig = {
  cwd: string;
  model?: string;
  prompt: string;
  resume?: boolean;
  /** Keep the app open afterwards, optionally in a theme and with a view open: for screenshots. */
  stay?: boolean;
  theme?: "light" | "dark";
  open?: (typeof OPEN_VIEWS)[number];
};

export async function readSelftestConfig(): Promise<SelftestConfig | null> {
  const raw = await invoke<string | null>("selftest_config");
  if (!raw) return null;
  const cfg = JSON.parse(raw) as Partial<SelftestConfig>;
  if (typeof cfg.cwd !== "string" || typeof cfg.prompt !== "string") return null;
  return {
    cwd: cfg.cwd,
    prompt: cfg.prompt,
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.resume ? { resume: true } : {}),
    ...(cfg.stay ? { stay: true } : {}),
    ...(cfg.theme === "light" || cfg.theme === "dark" ? { theme: cfg.theme } : {}),
    ...(OPEN_VIEWS.find((v) => v === cfg.open) ? { open: cfg.open } : {}),
  };
}

export const quitApp = () => invoke("quit_app");

type TurnCompleted = Extract<AgentEvent, { type: "turn.completed" }>;

/** The App functions the self-test drives, so it exercises the same code paths as clicks do. */
export type SelftestDeps = {
  start: (cwd: string, model: string) => Promise<string | null>;
  send: (sessionId: string, text: string) => Promise<void>;
  nextTurn: (sessionId: string) => Promise<TurnCompleted>;
  close: (sessionId: string) => Promise<void>;
  resume: (sessionId: string, cwd: string, model: string) => Promise<void>;
  /** The tab as last rendered. */
  tab: (sessionId: string) => Tab | undefined;
};

export async function runSelftest(cfg: SelftestConfig, deps: SelftestDeps): Promise<Record<string, unknown>> {
  const model = cfg.model ?? "";
  takeDeltaLatencies();
  const sessionId = await deps.start(cfg.cwd, model);
  if (!sessionId) throw new Error("session.start failed");
  const first = await turn(deps, sessionId, cfg.prompt);
  const report = {
    deltaLatencyMs: latencyStats(takeDeltaLatencies()),
    turnMs: first.durationMs,
    totalCostUsd: first.totalCostUsd,
    subtype: first.subtype,
  };
  if (!cfg.resume) return report;

  await deps.close(sessionId);
  await deps.resume(sessionId, cfg.cwd, model);
  await rendered();
  const historyUserMessages = deps.tab(sessionId)?.items.filter((i) => i.kind === "user").length ?? 0;
  const second = await turn(deps, sessionId, "Reply with exactly one word: resumed");
  await rendered();
  const reply = deps
    .tab(sessionId)
    ?.items.filter((i) => i.kind === "assistant")
    .at(-1);
  return {
    ...report,
    resume: {
      historyUserMessages,
      subtype: second.subtype,
      reply: reply?.kind === "assistant" ? reply.text : null,
      totalCostUsd: second.totalCostUsd,
    },
  };
}

async function turn(deps: SelftestDeps, sessionId: string, text: string): Promise<TurnCompleted> {
  const done = deps.nextTurn(sessionId);
  await deps.send(sessionId, text);
  return done;
}

/** Lets React apply pending state updates before the self-test reads a tab. */
const rendered = () => new Promise((resolve) => setTimeout(resolve, 100));
