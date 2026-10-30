import {
  type TaskContract,
  TIERS,
  type Tier,
  type Triage,
  type TriageSignal,
  type WorkspaceProfile,
} from "@agentchainer/protocol";
import { z } from "zod";
import type { AgentSdkModule } from "../sdk-loader.ts";

/**
 * Triage (M3-03, planner.md §4): deterministic signals set a floor, a cheap model proposes a tier, and the proposal is
 * the higher of the two, so a risk keyword can't be talked down. The thresholds are first guesses, tuned against the
 * labeled benchmark (`scripts/benchmark-triage.ts`).
 */

const ORDER: Record<Tier, number> = { S: 0, M: 1, L: 2, XL: 3 };

export function maxTier(a: Tier, b: Tier): Tier {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** Default spend caps per tier (planner.md §15); XL's applies per sub-task. */
export const DEFAULT_BUDGET_USD: Record<Tier, number> = { S: 1, M: 3, L: 8, XL: 5 };

/** Security- and data-sensitive work: at least L. Whole words with common endings (tokens, deploys), any case. */
export const RISK_KEYWORDS = [
  "auth",
  "authentication",
  "authorization",
  "oauth",
  "login",
  "password",
  // Not a bare "token": design tokens and token budgets aren't security work.
  "access token",
  "auth token",
  "api token",
  "refresh token",
  "session token",
  "bearer",
  "api key",
  "jwt",
  "secret",
  "credential",
  "payment",
  "billing",
  "migration",
  "schema",
  "database",
  "infra",
  "infrastructure",
  "deploy",
  "deployment",
  "permission",
  "crypto",
  "encryption",
];

/** Work that spreads across the codebase: at least L. */
export const BREADTH_PHRASES = [
  "everywhere",
  "across the codebase",
  "across the repo",
  "across the project",
  "throughout the codebase",
  "all files",
  "every file",
  "every module",
  "migrate",
  "rename across",
  "refactor the",
];

const REPO_FILES_FOR_M = 10_000;
const AREA_FILES_FOR_L = 40;

export type SignalInput = {
  request: string;
  contract: TaskContract;
  profile: WorkspaceProfile;
  /** Workspace files, `/`-separated (from the listing), and whether the listing was cut short. */
  files: string[];
  truncated: boolean;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function found(text: string, words: string[]): string[] {
  return words.filter((w) => new RegExp(`(?<![\\w-])${escapeRegex(w)}(?:s|es|d|ed|ing)?(?![\\w-])`, "i").test(text));
}

/** The folder or file an area names, without its glob part: `src/**\/*.ts` → `src`, `*.md` → "" (the root). */
export function staticPrefix(area: string): string {
  const clean = area.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const glob = clean.search(/[*?[{]/);
  if (glob === -1) return clean;
  const head = clean.slice(0, glob);
  return head.includes("/") ? head.slice(0, head.lastIndexOf("/")) : "";
}

/** Tests sit next to the code they cover, so they don't widen a task's scope: `test/`, `*.test.ts`, `x_test.go`. */
export function isTestPath(area: string): boolean {
  const parts = area.split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.some((p) => /^(tests?|__tests__|specs?|testdata)$/.test(p)) ||
    /[._-](test|spec)\.\w+$/.test(name) ||
    /^test_.+\.py$/.test(name)
  );
}

/**
 * The deterministic signals and the floor they set. Keywords are read from the request and the parts of the contract
 * that describe the work (objective, criteria, risks, areas), not from constraints or out-of-scope, which name what
 * the task won't touch.
 */
export function signals(input: SignalInput): { signals: TriageSignal[]; floor: Tier } {
  const { request, contract, profile, files, truncated } = input;
  const out: TriageSignal[] = [];
  const work = [
    request,
    contract.objective,
    ...contract.acceptanceCriteria.map((c) => c.text),
    ...contract.risks,
    ...contract.affectedAreas.map((a) => a.replace(/[/_.]/g, " ")),
  ].join("\n");

  const risky = found(work, RISK_KEYWORDS);
  if (risky.length) out.push({ signal: "risk-keywords", detail: `Mentions ${risky.join(", ")}.`, floor: "L" });

  const broad = found(`${request}\n${contract.objective}`, BREADTH_PHRASES);
  if (broad.length) out.push({ signal: "breadth", detail: `Says “${broad.join("”, “")}”.`, floor: "L" });

  const areas = contract.affectedAreas.map(staticPrefix);
  if (areas.length === 0) {
    out.push({ signal: "scope", detail: "No affected areas listed.", floor: null });
  } else {
    // An area belongs to its package in a monorepo, otherwise to its top-level folder; root files belong to ".".
    const packages = profile.packages.map((p) => p.path).filter((p) => p !== ".");
    const isRootFile = (a: string) =>
      !a || (!a.includes("/") && !files.some((f) => f.startsWith(`${a}/`)) && /\.\w+$/.test(a));
    const rootOf = (a: string) =>
      packages.find((p) => a === p || a.startsWith(`${p}/`)) ?? (isRootFile(a) ? "." : (a.split("/")[0] ?? "."));
    const roots = new Set(areas.filter((a) => !isTestPath(a)).map(rootOf));
    const covers = (a: string, f: string) => (a ? f === a || f.startsWith(`${a}/`) : !f.includes("/"));
    const under = files.filter((f) => areas.some((a) => covers(a, f))).length;
    const detail = `${areas.length} area${areas.length === 1 ? "" : "s"} in ${roots.size} top-level part${roots.size === 1 ? "" : "s"} (${[...roots].join(", ")}), ${under} existing file${under === 1 ? "" : "s"}.`;
    const floor: Tier | null = roots.size >= 4 || under >= AREA_FILES_FOR_L ? "L" : roots.size >= 2 ? "M" : null;
    out.push({ signal: "scope", detail, floor });
    const missing = contract.affectedAreas.filter((_, i) => {
      const a = areas[i] ?? "";
      return a !== "" && !files.some((f) => covers(a, f));
    });
    if (missing.length)
      out.push({ signal: "new-areas", detail: `New or not found: ${missing.join(", ")}.`, floor: null });
  }

  if (truncated || files.length > REPO_FILES_FOR_M) {
    out.push({ signal: "repo-size", detail: `${truncated ? "More than " : ""}${files.length} files.`, floor: "M" });
  }

  const tests = profile.packages.some((p) => p.commands.test);
  if (!tests) out.push({ signal: "tests", detail: "No test command detected.", floor: null });

  const floor = out.reduce<Tier>((t, s) => (s.floor ? maxTier(t, s.floor) : t), "S");
  return { signals: out, floor };
}

const ClassificationSchema = z.object({
  tier: z.enum(TIERS),
  rationale: z.string().min(1).max(2000),
  confidence: z.enum(["low", "medium", "high"]),
});
export type Classification = z.infer<typeof ClassificationSchema>;

const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    tier: { type: "string", enum: [...TIERS] },
    rationale: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["tier", "rationale", "confidence"],
  additionalProperties: false,
};

export function classifyPrompt(request: string, contract: TaskContract, found: TriageSignal[]): string {
  const list = (title: string, items: string[]) => (items.length ? [`${title}:`, ...items.map((i) => `- ${i}`)] : []);
  return [
    "Classify this software task into a tier for an AI coding workflow.",
    "- S: a typo, a small bug or a config tweak. One agent, then the project's checks.",
    "- M: a feature or fix within one module. Plan, implement, checks, review.",
    "- L: a cross-module feature or a security-relevant change. Specialist planning, implement, independent review.",
    "- XL: an epic or a migration that should be split into sub-tasks with their own contracts.",
    "",
    `Task: ${request}`,
    `Objective: ${contract.objective}`,
    ...list(
      "Acceptance criteria",
      contract.acceptanceCriteria.map((c) => c.text),
    ),
    ...list("Risks", contract.risks),
    ...list("Affected areas", contract.affectedAreas),
    ...list(
      "Signals measured by AgentChainer",
      found.map((s) => `${s.signal}: ${s.detail}`),
    ),
    "",
    "Pick the smallest tier that does the task safely. Reply with only a JSON object:",
    '{"tier": "S" | "M" | "L" | "XL", "rationale": "one or two sentences", "confidence": "low" | "medium" | "high"}',
  ].join("\n");
}

/** The first JSON object in a text reply, for when structured output isn't delivered. */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The cheap model's tier (haiku, no tools). Never throws for a failed call: it returns the error instead. */
export async function classify(
  sdk: AgentSdkModule,
  claudePath: string,
  root: string,
  prompt: string,
  abortController?: AbortController,
): Promise<{ model: Classification | null; error?: string; costUsd: number }> {
  let costUsd = 0;
  try {
    const q = sdk.query({
      prompt,
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: claudePath,
        model: "haiku",
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        maxBudgetUsd: 0.05,
        outputFormat: { type: "json_schema", schema: CLASSIFICATION_JSON_SCHEMA },
        ...(abortController ? { abortController } : {}),
      },
    });
    for await (const m of q) {
      if (m.type !== "result") continue;
      costUsd += m.total_cost_usd;
      if (m.subtype !== "success") return { model: null, error: `The classification stopped: ${m.subtype}.`, costUsd };
      const parsed = ClassificationSchema.safeParse(m.structured_output ?? jsonIn(m.result));
      if (parsed.success) return { model: parsed.data, costUsd };
      return { model: null, error: "The classification wasn't a valid answer.", costUsd };
    }
    return { model: null, error: "The classification ended without a result.", costUsd };
  } catch (err) {
    if (abortController?.signal.aborted) throw err;
    return { model: null, error: err instanceof Error ? err.message : String(err), costUsd };
  }
}

/** Combines the signals and the model's tier into a triage record; the proposal is the default choice. */
export function triageRecord(
  found: { signals: TriageSignal[]; floor: Tier },
  model: { model: Classification | null; error?: string },
  now = new Date(),
): Triage {
  const proposed = model.model ? maxTier(model.model.tier, found.floor) : found.floor;
  return {
    signals: found.signals,
    floor: found.floor,
    model: model.model,
    ...(model.error ? { modelError: model.error } : {}),
    proposed,
    chosen: proposed,
    budgetUsd: DEFAULT_BUDGET_USD[proposed],
    at: now.toISOString(),
  };
}
