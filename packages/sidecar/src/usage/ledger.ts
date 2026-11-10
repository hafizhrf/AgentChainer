import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CostKind, StepAgent } from "@agentchainer/protocol";
import { z } from "zod";
import { log } from "../rpc.ts";

/**
 * The app's own record of the turns it ran on Codex and the Antigravity CLI (CP-01). agy has no API for its history
 * or usage, and Codex's account usage has no per-model split, so the usage page counts the runs the app launched from
 * here, in any folder. One JSON line per turn in `agent-runs.jsonl` in the app's data folder
 * (`AGENTCHAINER_USAGE_DIR`): when, which agent and model, its tokens and estimate, the folder and the session. No
 * prompts or replies. Claude's turns aren't recorded: its sessions keep their own history (ADR-0004).
 */
export const AgentRunSchema = z.object({
  at: z.string(),
  agent: z.enum(["codex", "agy"]),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  costUsd: z.number(),
  costKind: z.enum(["estimate", "unknown"]),
  cwd: z.string(),
  sessionId: z.string(),
  /** The task and step it ran for, or the chat's title. */
  title: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

const FILE = "agent-runs.jsonl";

function dir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.AGENTCHAINER_USAGE_DIR || null;
}

/** Appends one turn; a run without a folder to write to (tests, scripts) isn't recorded, and a failure only logs. */
export function recordRun(
  run: Omit<AgentRun, "at" | "costKind"> & { at?: string; costKind?: CostKind; agent: Exclude<StepAgent, "claude"> },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const d = dir(env);
  if (!d) return;
  const line: AgentRun = {
    ...run,
    at: run.at ?? new Date().toISOString(),
    costKind: run.costKind ?? "unknown",
  };
  try {
    mkdirSync(d, { recursive: true });
    appendFileSync(path.join(d, FILE), `${JSON.stringify(line)}\n`);
  } catch (err) {
    log(`usage: couldn't record a ${run.agent} run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Every recorded turn; a broken line is skipped. */
export function readRuns(env: NodeJS.ProcessEnv = process.env): AgentRun[] {
  const d = dir(env);
  if (!d || !existsSync(path.join(d, FILE))) return [];
  const out: AgentRun[] = [];
  for (const line of readFileSync(path.join(d, FILE), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = AgentRunSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // a line cut short by a crash
    }
  }
  return out;
}
