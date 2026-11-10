import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { type Task, TaskIdSchema, type UsageFamily, type UsageReport } from "@agentchainer/protocol";
import { AC_DIR } from "../ac-dir.ts";
import { estimateUsd } from "../backends/prices.ts";
import { loadTask } from "../tasks/store.ts";
import { type ClaudeTokens, claudeCostUsd } from "./claude-prices.ts";
import type { AgentRun } from "./ledger.ts";

/**
 * The usage page (CP-01): what agents spent across sessions, by model, project and day. ADR-0004 keeps the app off
 * the CLI's transcript files, so:
 * - **Claude sessions**, chats and task steps alike, come from the SDK's session history (`listSessions` across every
 *   project, then `getSessionMessages` and each subagent's). History keeps each response's model and tokens but no
 *   dollars, so the cost is an estimate at Claude's API prices (claude-prices.ts). A response is split into several
 *   messages sharing its id and usage, so each id counts once.
 * - **Codex and agy steps** come from the task records of the workspaces the app knows (M9-07), with their estimates.
 * History has no time per message, so a session counts on the day it was last active.
 */

/** A stored session, as `listSessions` gives it. */
export type StoredSession = {
  sessionId: string;
  summary: string;
  lastModified: number;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
};

export type UsageSources = {
  /** Every stored session, across projects. */
  sessions(): Promise<StoredSession[]>;
  /** A session's messages, its subagents' included. */
  messages(session: StoredSession): Promise<{ message: unknown }[]>;
  /** The tasks recorded in a workspace, sub-tasks included. */
  tasks(root: string): Task[];
  /** The Codex and agy turns the app recorded (ledger.ts), in any folder. */
  runs(): AgentRun[];
};

type Tally = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  unpriced: number;
};
const empty = (): Tally => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0 });
const add = (a: Tally, b: Tally) => {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
  a.costUsd += b.costUsd;
  a.unpriced += b.unpriced;
};
const tokensOf = (t: Tally) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** The chart's series: fixed families, so a color always means the same agent whatever the period shows. */
export function familyOf(model: string): UsageFamily {
  if (/^claude-opus/.test(model)) return "opus";
  if (/^claude-sonnet/.test(model)) return "sonnet";
  if (/^claude-haiku/.test(model)) return "haiku";
  if (/^claude-(fable|mythos)/.test(model)) return "fable";
  if (/^(gpt|o\d|codex)/.test(model)) return "codex";
  if (/^gemini/.test(model)) return "agy";
  return "other";
}

/** Local calendar day, `2026-11-10`. */
const dayOf = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** A session's tokens by model, each response once. */
export function tallySession(messages: { message: unknown }[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  const seen = new Set<string>();
  for (const m of messages) {
    const msg = m.message as {
      id?: string;
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_creation?: { ephemeral_1h_input_tokens?: number };
      };
    } | null;
    if (!msg?.usage || !msg.model || msg.model.startsWith("<")) continue;
    if (msg.id) {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    const u = msg.usage;
    const tokens: ClaudeTokens = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      ...(u.cache_creation?.ephemeral_1h_input_tokens
        ? { cacheWrite1h: u.cache_creation.ephemeral_1h_input_tokens }
        : {}),
    };
    const cost = claudeCostUsd(msg.model, tokens);
    const t = out.get(msg.model) ?? empty();
    add(t, {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      costUsd: cost ?? 0,
      unpriced: cost === null ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : 0,
    });
    out.set(msg.model, t);
  }
  return out;
}

/** Every task in a workspace, sub-tasks included (an XL task's steps run in them). */
export function allTasks(root: string): Task[] {
  const dir = path.join(root, AC_DIR, "tasks");
  if (!existsSync(dir)) return [];
  const out: Task[] = [];
  for (const id of readdirSync(dir)) {
    if (!TaskIdSchema.safeParse(id).success) continue;
    try {
      out.push(loadTask(root, id));
    } catch {
      // not a valid task
    }
  }
  return out;
}

/** Parsed sessions by id and last change: a session that didn't change since is read once per app run. */
const cache = new Map<string, { lastModified: number; byModel: Map<string, Tally> }>();

export async function usageReport(
  src: UsageSources,
  opts: { sinceDays: number | null; workspaces: string[]; now?: Date; topSessions?: number },
): Promise<UsageReport> {
  const now = opts.now ?? new Date();
  const since = opts.sinceDays === null ? null : now.getTime() - opts.sinceDays * 86_400_000;
  const rows: UsageReport["sessions"] = [];
  const byModel = new Map<string, Tally & { sessions: Set<string> }>();
  const byProject = new Map<string, Tally & { sessions: Set<string> }>();
  const byDay = new Map<string, Map<UsageFamily, number>>();
  const total = empty();

  const count = (row: {
    id: string;
    project: string;
    title: string;
    day: string;
    source: UsageReport["sessions"][number]["source"];
    models: Map<string, Tally>;
  }) => {
    const sum = empty();
    for (const [model, t] of row.models) {
      add(sum, t);
      const m = byModel.get(model) ?? { ...empty(), sessions: new Set<string>() };
      add(m, t);
      m.sessions.add(row.id);
      byModel.set(model, m);
      const day = byDay.get(row.day) ?? new Map<UsageFamily, number>();
      const fam = familyOf(model);
      day.set(fam, (day.get(fam) ?? 0) + t.costUsd);
      byDay.set(row.day, day);
    }
    if (!tokensOf(sum)) return;
    add(total, sum);
    const p = byProject.get(row.project) ?? { ...empty(), sessions: new Set<string>() };
    add(p, sum);
    p.sessions.add(row.id);
    byProject.set(row.project, p);
    rows.push({
      id: row.id,
      project: row.project,
      title: row.title,
      day: row.day,
      source: row.source,
      models: [...row.models.keys()],
      costUsd: sum.costUsd,
      tokens: tokensOf(sum),
      unpricedTokens: sum.unpriced,
    });
  };

  for (const s of await src.sessions()) {
    if (since !== null && s.lastModified < since) continue;
    let hit = cache.get(s.sessionId);
    if (!hit || hit.lastModified !== s.lastModified) {
      hit = { lastModified: s.lastModified, byModel: tallySession(await src.messages(s).catch(() => [])) };
      cache.set(s.sessionId, hit);
    }
    count({
      id: s.sessionId,
      project: s.cwd ?? "",
      title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
      day: dayOf(s.lastModified),
      source: "claude",
      models: hit.byModel,
    });
  }

  // Codex and agy turns the app recorded, each on its own day.
  const recorded = new Set<string>();
  for (const run of src.runs()) {
    const at = Date.parse(run.at);
    if (since !== null && at < since) continue;
    recorded.add(run.sessionId);
    const priced = run.costKind === "estimate";
    count({
      id: run.sessionId,
      project: run.cwd,
      title: run.title ?? `${run.agent === "codex" ? "Codex" : "agy"} · ${run.sessionId.slice(0, 8)}`,
      day: dayOf(at),
      source: run.agent,
      models: new Map([
        [
          run.model,
          {
            ...empty(),
            input: run.input,
            output: run.output,
            costUsd: priced ? run.costUsd : 0,
            unpriced: priced ? 0 : run.input + run.output,
          },
        ],
      ]),
    });
  }

  // Codex and agy steps from before the app recorded runs: the task records of the known workspaces. Claude's steps
  // are sessions above already.
  for (const root of new Set(opts.workspaces)) {
    for (const task of src.tasks(root)) {
      for (const step of task.run?.steps ?? []) {
        if (step.agent !== "codex" && step.agent !== "agy") continue;
        if (step.sessionId && recorded.has(step.sessionId)) continue;
        const at = Date.parse(step.endedAt ?? step.startedAt);
        if (since !== null && at < since) continue;
        const model = step.model ?? step.agent;
        const tokens = step.tokens ?? { input: 0, output: 0 };
        const priced = step.costKind === "estimate";
        const t: Tally = {
          ...empty(),
          input: tokens.input,
          output: tokens.output,
          costUsd: priced ? step.costUsd : 0,
          unpriced: priced ? 0 : tokens.input + tokens.output,
        };
        // A step recorded before prices existed: price its tokens now when the model has one.
        if (!step.costKind && step.model && tokens.input + tokens.output) {
          const usd = estimateUsd(step.model, { input: tokens.input, cached: 0, output: tokens.output });
          if (usd !== null) {
            t.costUsd = usd;
            t.unpriced = 0;
          }
        }
        count({
          id: step.sessionId ?? `${task.id}/${step.id}`,
          project: root,
          title: `${task.title ?? task.request.slice(0, 80)} · ${step.label}`,
          day: dayOf(at),
          source: step.agent,
          models: new Map([[model, t]]),
        });
      }
    }
  }

  const sorted = <T extends { costUsd: number }>(xs: T[]) => xs.sort((a, b) => b.costUsd - a.costUsd);
  // A session that ran on several days is one row: its spend added up, on its last day.
  const merged = new Map<string, UsageReport["sessions"][number]>();
  for (const r of rows) {
    const m = merged.get(r.id);
    if (!m) {
      merged.set(r.id, { ...r, models: [...r.models] });
      continue;
    }
    m.costUsd += r.costUsd;
    m.tokens += r.tokens;
    m.unpricedTokens += r.unpricedTokens;
    m.models = [...new Set([...m.models, ...r.models])];
    if (r.day > m.day) m.day = r.day;
  }
  const sessionRows = [...merged.values()];
  return {
    generatedAt: now.toISOString(),
    sinceDays: opts.sinceDays,
    totals: {
      costUsd: total.costUsd,
      tokens: tokensOf(total),
      input: total.input,
      output: total.output,
      cacheRead: total.cacheRead,
      cacheWrite: total.cacheWrite,
      unpricedTokens: total.unpriced,
      sessions: sessionRows.length,
    },
    byModel: sorted(
      [...byModel].map(([model, m]) => ({
        model,
        family: familyOf(model),
        costUsd: m.costUsd,
        tokens: tokensOf(m),
        input: m.input,
        output: m.output,
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite,
        unpricedTokens: m.unpriced,
        sessions: m.sessions.size,
      })),
    ),
    byProject: sorted(
      [...byProject].map(([project, p]) => ({
        project,
        costUsd: p.costUsd,
        tokens: tokensOf(p),
        sessions: p.sessions.size,
      })),
    ),
    byDay: [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, fams]) => ({ day, costUsd: Object.fromEntries(fams) as Partial<Record<UsageFamily, number>> })),
    sessions: sorted(sessionRows).slice(0, opts.topSessions ?? 50),
  };
}

/** Forgets parsed sessions (tests). */
export function clearUsageCache(): void {
  cache.clear();
}

/** One CSV field: quoted when it holds a comma, quote or line break; a leading `=+-@` is defused for spreadsheets. */
function csvField(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The report as a file: every session and task step as CSV rows, or the whole report as JSON. */
export function usageFile(report: UsageReport, format: "csv" | "json"): { text: string; rows: number } {
  if (format === "json") return { text: `${JSON.stringify(report, null, 2)}\n`, rows: report.sessions.length };
  const head = ["day", "source", "project", "title", "models", "tokens", "unpriced_tokens", "est_cost_usd", "id"];
  const lines = report.sessions.map((s) =>
    [s.day, s.source, s.project, s.title, s.models.join(" "), s.tokens, s.unpricedTokens, s.costUsd.toFixed(6), s.id]
      .map(csvField)
      .join(","),
  );
  return { text: `${[head.join(","), ...lines].join("\n")}\n`, rows: lines.length };
}
