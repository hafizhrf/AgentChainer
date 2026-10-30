import {
  type CriterionCheck,
  CriterionCheckSchema,
  GATE_KINDS,
  type GateKind,
  type TaskContract,
  type WorkspaceProfile,
} from "@agentchainer/protocol";
import { generatorHook } from "../bootstrap/generate.ts";
import { guarded } from "../bootstrap/workspace-guard.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";

/**
 * Drafting the task contract (M3-02, planner.md §3): a read-only session reads the repository and answers with
 * structured output. It can use Read, Grep and Glob only, the generators' hook keeps it inside the workspace, and the
 * workspace guard reverts anything that changed anyway. The user edits the draft and approves it.
 */

/** Gates the profile has a command for. `smoke` joins when the smoke generator's command kind exists (M3-08). */
export function availableGates(profile: WorkspaceProfile): GateKind[] {
  return GATE_KINDS.filter((kind) => kind !== "smoke" && profile.packages.some((p) => p.commands[kind]));
}

const CHECKS = ["review", "manual", ...GATE_KINDS.map((k) => `gate:${k}`)];

const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: {
    objective: { type: "string" },
    acceptanceCriteria: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, check: { type: "string", enum: CHECKS } },
        required: ["text", "check"],
        additionalProperties: false,
      },
    },
    constraints: { type: "array", items: { type: "string" } },
    outOfScope: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    affectedAreas: {
      type: "array",
      items: { type: "string", description: "One workspace-relative path or glob, with no notes or alternatives" },
    },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["objective", "acceptanceCriteria", "constraints", "outOfScope", "risks", "affectedAreas", "openQuestions"],
  additionalProperties: false,
};

const GUIDE = `You draft task contracts for AgentChainer. A contract says what will be done and what counts as done, before
any code changes. Read the repository to ground it (you can only read; you can't change anything), then answer with
the structured output:
- objective: the outcome in one or two sentences, not the steps.
- acceptanceCriteria: two to six concrete statements of done. Set each one's check:
  - "gate:<kind>" when a project check proves it. Only the gates listed as available exist. Prefer gate:test for
    behavior when tests exist: the criterion then means a test covers it and passes.
  - "review" when a reviewer can judge it from the diff.
  - "manual" when only the user can check it, such as how something looks or behaves in production.
- constraints: limits the work must respect, only those the request or the repository implies.
- outOfScope: related work this task won't do.
- risks: what could go wrong, such as breaking callers, losing data or weakening security.
- affectedAreas: workspace-relative paths or globs you expect to change, from what you read. One path per item and
  nothing else: no notes such as "(new)", no alternatives such as "a.ts or b.ts". New files are fine.
- openQuestions: decisions the request leaves open that change the work. Empty when the request is clear. Don't ask
  what the repository answers.
Keep every item short. Don't plan the implementation.`;

export function draftPrompt(request: string, profile: WorkspaceProfile, gates: GateKind[]): string {
  const packages = profile.packages.map((p) => {
    const commands = Object.keys(p.commands).join(", ") || "none";
    return `- ${p.path} (${p.stack}${p.frameworks.length ? `, ${p.frameworks.join(", ")}` : ""}): commands ${commands}`;
  });
  return [
    `Request: ${request}`,
    "",
    "Workspace (detected by AgentChainer):",
    ...(packages.length ? packages : ["- no packages detected"]),
    `Available gates: ${gates.length ? gates.join(", ") : "none"}.`,
  ].join("\n");
}

const MAX = { criteria: 30, list: 30, areas: 50, questions: 20, line: 2000, area: 500, objective: 4000 };

function lines(value: unknown, max: number, maxLength = MAX.line): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    const text = typeof v === "string" ? v.trim().slice(0, maxLength) : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, max);
}

/**
 * The paths in one drafted area. Models annotate them anyway ("index.html (new)", "a.ts or b.ts", backticks); the
 * notes are dropped and alternatives split, so the scope signal measures paths, not prose.
 */
export function cleanAreas(entry: string): string[] {
  const text = entry.replace(/`/g, "").replace(/\s+\(.*$/, "");
  return text
    .split(/\s*,\s*|\s+or\s+|\s+and\s+/)
    .map(cleanArea)
    .filter((a): a is string => a !== null);
}

/** A workspace-relative, `/`-separated area; null for anything absolute or leaving the workspace. */
export function cleanArea(area: string): string | null {
  const a = area.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!a || a.startsWith("/") || /^[a-zA-Z]:/.test(a) || a.split("/").includes("..")) return null;
  return a.slice(0, MAX.area);
}

/**
 * Turns a draft (the model's output, or the user's edits) into a valid contract: trimmed, deduplicated and capped;
 * criteria numbered c1…cn; a check that's missing, unknown or names a gate the profile lacks becomes `manual`, so it
 * can't silently count as proved; areas outside the workspace are dropped.
 */
export function normalizeContract(request: string, draft: unknown, gates: GateKind[]): TaskContract {
  const d = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>;
  const criteria = Array.isArray(d.acceptanceCriteria) ? d.acceptanceCriteria : [];
  const acceptanceCriteria = criteria
    .map((c) => (c && typeof c === "object" ? (c as Record<string, unknown>) : {}))
    .map((c) => ({ text: typeof c.text === "string" ? c.text.trim().slice(0, MAX.line) : "", check: c.check }))
    .filter((c) => c.text)
    .slice(0, MAX.criteria)
    .map((c, i) => {
      const parsed = CriterionCheckSchema.safeParse(c.check);
      let check: CriterionCheck = parsed.success ? parsed.data : "manual";
      if (check.startsWith("gate:") && !gates.includes(check.slice(5) as GateKind)) check = "manual";
      return { id: `c${i + 1}`, text: c.text, check };
    });
  const areas = lines(d.affectedAreas, MAX.areas, MAX.area).flatMap(cleanAreas);
  return {
    task: request,
    objective: typeof d.objective === "string" ? d.objective.trim().slice(0, MAX.objective) : "",
    acceptanceCriteria,
    constraints: lines(d.constraints, MAX.list),
    outOfScope: lines(d.outOfScope, MAX.list),
    risks: lines(d.risks, MAX.list),
    affectedAreas: [...new Set(areas)].slice(0, MAX.areas),
    openQuestions: lines(d.openQuestions, MAX.questions),
  };
}

export type DraftOptions = { model?: string; maxBudgetUsd?: number; abortController?: AbortController };

/** Drafts the contract. The cost is returned with the result or the error, so a failed draft is still accounted. */
export async function draftContract(
  sdk: AgentSdkModule,
  claudePath: string,
  root: string,
  request: string,
  profile: WorkspaceProfile,
  opts: DraftOptions = {},
): Promise<{ contract: TaskContract | null; error?: string; costUsd: number }> {
  const gates = availableGates(profile);
  let costUsd = 0;
  const { result } = await guarded(root, async () => {
    const q = sdk.query({
      prompt: draftPrompt(request, profile, gates),
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: claudePath,
        ...(opts.model ? { model: opts.model } : {}),
        tools: ["Read", "Grep", "Glob"],
        // Isolated from the user's and the project's settings: no hooks, plugins or MCP servers run here.
        settingSources: [],
        persistSession: false,
        maxTurns: 30,
        maxBudgetUsd: opts.maxBudgetUsd ?? 0.5,
        systemPrompt: { type: "preset", preset: "claude_code", append: GUIDE },
        outputFormat: { type: "json_schema", schema: DRAFT_JSON_SCHEMA },
        hooks: { PreToolUse: [{ hooks: [generatorHook(root, [])] }] },
        // The hook above already decided; anything that reaches here is allowed.
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
      },
    });
    for await (const m of q) {
      if (m.type !== "result") continue;
      costUsd += m.total_cost_usd;
      if (m.subtype !== "success") return { contract: null, error: `Drafting stopped: ${m.subtype}.` };
      return { contract: normalizeContract(request, m.structured_output, gates) };
    }
    return { contract: null, error: "Drafting ended without a result." };
  });
  return { ...result, costUsd };
}
