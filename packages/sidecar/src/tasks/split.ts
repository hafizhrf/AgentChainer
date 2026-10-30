import type { GateKind, TaskContract, WorkspaceProfile } from "@agentchainer/protocol";
import { generatorHook } from "../bootstrap/generate.ts";
import { guarded } from "../bootstrap/workspace-guard.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { availableGates, DRAFT_JSON_SCHEMA, normalizeContract, workspaceLines } from "./contract.ts";
import type { AgentStep } from "./library.ts";
import { contractText } from "./orchestrator.ts";

/**
 * The XL split (M3-07, planner.md §8): a read-only session reads the repository and proposes sub-tasks, each with a
 * tier and a contract of its own, as structured output. Like drafting, it can only read; the user edits and approves
 * every sub-task before anything runs.
 */

export const MAX_SUBTASKS = 8;
const SUB_TIERS = ["S", "M", "L"] as const;
export type SubTier = (typeof SUB_TIERS)[number];

export const SPLIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    subtasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short imperative title" },
          request: { type: "string", description: "What to do, as a user would ask for it, in one to three sentences" },
          tier: { type: "string", enum: SUB_TIERS },
          dependsOn: {
            type: "array",
            items: { type: "integer" },
            description: "The numbers (1-based) of earlier sub-tasks whose changes this one needs first",
          },
          contract: DRAFT_JSON_SCHEMA,
        },
        required: ["title", "request", "tier", "dependsOn", "contract"],
        additionalProperties: false,
      },
    },
  },
  required: ["subtasks"],
  additionalProperties: false,
};

const GUIDE = `You split an approved, large task (tier XL) into sub-tasks for AgentChainer. Each sub-task runs on its own:
another agent implements it in a separate git worktree under its own contract, the project's checks run, and finished
sub-tasks are merged one by one into a single branch. Read the repository to ground the split (you can only read), then
answer with the structured output:
- two to eight sub-tasks that together meet the whole contract, and nothing outside it;
- each small enough for one agent. tier: "S" a small change, "M" a feature within one module, "L" a cross-module or
  security-relevant change. Never bigger: split further instead;
- dependsOn: the numbers of earlier sub-tasks whose changes this one needs. Sub-tasks without a dependency between
  them may run at the same time, so they must not change the same files; when two would, make one depend on the other.
  List dependencies before the sub-tasks that need them;
- contract: like any task contract. objective; two to six acceptance criteria, each with its check ("gate:<kind>" for
  the available gates only, "review", or "manual"); constraints; outOfScope, including the other sub-tasks' work;
  risks; affectedAreas (workspace-relative paths, one per item); openQuestions, empty unless something is undecided.
Keep every item short. Don't implement anything and don't plan the code.`;

export function splitPrompt(contract: TaskContract, profile: WorkspaceProfile, gates: GateKind[]): string {
  return [contractText(contract), "", ...workspaceLines(profile, gates)].join("\n");
}

/** One proposed sub-task, cleaned up: `dependsOn` holds indexes of earlier sub-tasks in this list. */
export type SubtaskDraft = {
  title: string;
  request: string;
  tier: SubTier;
  dependsOn: number[];
  contract: TaskContract;
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");

/**
 * Cleans the split's answer: untitled entries are dropped, the tier is S, M or L (M when unclear), and a dependency
 * must name an earlier sub-task that was kept, so the order has no cycles.
 */
export function normalizeSplit(raw: unknown, gates: GateKind[]): SubtaskDraft[] {
  const list =
    raw && typeof raw === "object" && Array.isArray((raw as { subtasks?: unknown }).subtasks)
      ? ((raw as { subtasks: unknown[] }).subtasks as unknown[])
      : [];
  const out: SubtaskDraft[] = [];
  // The split's 1-based numbers → indexes in `out`, for the entries that were kept.
  const kept = new Map<number, number>();
  for (const [i, entry] of list.entries()) {
    if (out.length >= MAX_SUBTASKS) break;
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const title = text(e.title, 120);
    if (!title) continue;
    const request = text(e.request, 2000) || title;
    const tier = SUB_TIERS.find((t) => t === e.tier) ?? "M";
    const deps = Array.isArray(e.dependsOn) ? e.dependsOn : [];
    const dependsOn = [
      ...new Set(
        deps.flatMap((n) => (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= i ? [kept.get(n)] : [])),
      ),
    ].filter((n): n is number => n !== undefined);
    kept.set(i + 1, out.length);
    out.push({ title, request, tier, dependsOn, contract: normalizeContract(request, e.contract, gates) });
  }
  return out;
}

/** Runs the split session. A failed or empty answer comes back as `error`; its spend is reported either way. */
export async function proposeSplit(
  sdk: AgentSdkModule,
  claudePath: string,
  root: string,
  contract: TaskContract,
  profile: WorkspaceProfile,
  step: AgentStep,
  opts: { model?: string; abortController?: AbortController } = {},
): Promise<{ subtasks: SubtaskDraft[]; error?: string; costUsd: number }> {
  const gates = availableGates(profile, root);
  let costUsd = 0;
  const { result } = await guarded(root, async () => {
    const q = sdk.query({
      prompt: splitPrompt(contract, profile, gates),
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: claudePath,
        ...(opts.model ? { model: opts.model } : {}),
        tools: ["Read", "Grep", "Glob"],
        // Isolated from the user's and the project's settings, like drafting: no hooks, plugins or MCP servers.
        settingSources: [],
        persistSession: false,
        maxTurns: step.limits.maxTurns,
        maxBudgetUsd: step.limits.maxBudgetUsd,
        systemPrompt: { type: "preset", preset: "claude_code", append: GUIDE },
        outputFormat: { type: "json_schema", schema: SPLIT_JSON_SCHEMA },
        hooks: { PreToolUse: [{ hooks: [generatorHook(root, [])] }] },
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
      },
    });
    for await (const m of q) {
      if (m.type !== "result") continue;
      costUsd += m.total_cost_usd;
      if (m.subtype !== "success") return { subtasks: [], error: `The split stopped: ${m.subtype}.` };
      const subtasks = normalizeSplit(m.structured_output, gates);
      return subtasks.length ? { subtasks } : { subtasks, error: "The split proposed no sub-tasks." };
    }
    return { subtasks: [], error: "The split ended without a result." };
  });
  return { ...result, costUsd };
}
