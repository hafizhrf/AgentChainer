import { GATE_KINDS, STEP_INPUTS, type TaskContract, WORKFLOW_ROLES } from "@agentchainer/protocol";
import { t } from "../i18n/index.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import type { Library } from "./library.ts";
import { checkWorkflowText } from "./project-workflows.ts";

/**
 * Workflows made by AI (UX-14, docs/design/chat-and-tasks.md §6.2–6.3): a model writes a tier's workflow as YAML from
 * the person's description (the editor's Generate with AI) or from a task's contract (a task's own flow). It has no
 * tools; what it writes is checked like a hand-written workflow, retried once with the errors, and never used before
 * a person keeps or approves it.
 */

export type GenTier = "S" | "M" | "L";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    yaml: { type: "string", description: "The whole workflow file, YAML, without code fences" },
    summary: { type: "string", description: "One or two sentences: what the flow does differently, and why" },
  },
  required: ["yaml", "summary"],
  additionalProperties: false,
};

const GUIDE = `You design AgentChainer task workflows: the steps a task runs, as a YAML file. Answer with the structured
output only. Rules the file must follow (it is checked; anything else is refused):
- Top level: id (must stay exactly as given), tier (as given), version (an integer), description (one sentence), steps.
- An agent step: id (lowercase, a-z0-9 and -), label, role, access (read | write), inputs (a list of: ${STEP_INPUTS.join(", ")}),
  optional output (plan | review), limits: { maxTurns, maxBudgetUsd }.
  Roles: ${WORKFLOW_ROLES.join(", ")}. A read step uses a read-only role (architect, test-planner, independent-reviewer,
  security-reviewer, docs-writer); the implementer is the write step. Exactly one write step does the change.
  output: plan only on a read step whose plan the implementer takes (its inputs then include plan); output: review only
  on a read step (a reviewer).
- A gates step: id, label, gates (a list of: ${GATE_KINDS.join(", ")}), and fix: { step: <the write step's id>,
  maxRounds, maxBudgetUsd } to send failures back.
- A review step may have fix: { step: <the write step's id>, maxRounds, maxBudgetUsd } for its must-fix findings.
- A parallel group: { label, parallel: [read-only agent steps without output or fix] }.
- Keep budgets modest (a step's maxBudgetUsd at most 3) and fix rounds at most 3.
Change only what the request asks for; keep the rest of the given workflow as it is.`;

/** The prompt: the rules, the tier's current workflow, and what to change (a description, or a task's contract). */
export function generatePrompt(
  tier: GenTier,
  current: string,
  ask: { description?: string; contract?: TaskContract },
  previous?: { yaml: string; error: string },
): string {
  return [
    `Tier: ${tier}. The current ${tier} workflow, to start from:`,
    "```yaml",
    current.trim(),
    "```",
    "",
    ...(ask.description ? [`What the person wants: ${ask.description}`] : []),
    ...(ask.contract
      ? [
          "Design the flow for this one task, from its approved contract. Only change the tier's flow where the task",
          "calls for it (e.g. a test planner before a risky change, a security review when it touches auth); when the",
          "tier's flow fits, return it as it is.",
          JSON.stringify({ ...ask.contract, approvedAt: undefined }),
        ]
      : []),
    ...(previous
      ? [
          "",
          "Your last answer was refused. Fix it and answer again.",
          `Why: ${previous.error}`,
          "It was:",
          previous.yaml,
        ]
      : []),
  ].join("\n");
}

export type Generated = { yaml: string | null; summary: string; error?: string; costUsd: number };

/** One model call for a workflow, then the run's checks; one more call with the errors if it fails them. */
export async function generateWorkflow(
  sdk: AgentSdkModule,
  claudePath: string,
  root: string,
  tier: GenTier,
  current: string,
  ask: { description?: string; contract?: TaskContract },
  shipped: Library,
  opts: { model?: string; abortController?: AbortController } = {},
): Promise<Generated> {
  let costUsd = 0;
  let previous: { yaml: string; error: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const q = sdk.query({
      prompt: generatePrompt(tier, current, ask, previous),
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: claudePath,
        model: opts.model ?? "sonnet",
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        maxBudgetUsd: 0.5,
        systemPrompt: { type: "preset", preset: "claude_code", append: GUIDE },
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
      },
    });
    let answer = null as { yaml?: unknown; summary?: unknown } | null;
    for await (const m of q) {
      if (m.type !== "result") continue;
      costUsd += m.total_cost_usd;
      if (m.subtype !== "success")
        return { yaml: null, summary: "", error: t("tasks.generateWorkflow.stopped", { reason: m.subtype }), costUsd };
      answer = (m.structured_output ?? null) as typeof answer;
    }
    const yaml = typeof answer?.yaml === "string" ? stripFences(answer.yaml) : "";
    const summary = typeof answer?.summary === "string" ? answer.summary.trim() : "";
    if (!yaml) return { yaml: null, summary, error: t("tasks.generateWorkflow.noWorkflow"), costUsd };
    const error = checkWorkflowText(tier, yaml, shipped);
    if (!error) return { yaml: yaml.endsWith("\n") ? yaml : `${yaml}\n`, summary, costUsd };
    previous = { yaml, error };
  }
  return {
    yaml: null,
    summary: "",
    error: t("tasks.generateWorkflow.failedChecks", { error: String(previous?.error) }),
    costUsd,
  };
}

const stripFences = (text: string) =>
  text
    .trim()
    .replace(/^```(?:ya?ml)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
