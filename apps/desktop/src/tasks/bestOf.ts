import type { MethodResult, StepAgent, VariantSummary } from "@agentchainer/protocol";

/** What `agents.available` says about Codex and the Antigravity CLI (M9-06). */
type AgentClis = MethodResult<"agents.available">;

/** Agents by their product name, never translated (M9-07). */
export const AGENT_NAMES: Record<StepAgent, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };

/** One Best-of-N variant as the dialog edits it (CP-06): an agent, and its model ("" for the agent's default). */
export type VariantRow = { agent: StepAgent; model: string };

/** The agents a variant may run on: Claude, and Codex or Antigravity when installed and signed in. */
export function variantAgents(clis: AgentClis | null): StepAgent[] {
  const others = (["codex", "agy"] as const).filter((a) => clis?.[a].installed && clis[a].signedIn);
  return ["claude", ...others];
}

/**
 * The rows to start from: the task's implementer, then another agent when this computer has one, else Claude on
 * another model, so the two differ.
 */
export function variantRows(agents: StepAgent[], implement: StepAgent = "claude"): VariantRow[] {
  const first: VariantRow = { agent: agents.includes(implement) ? implement : "claude", model: "" };
  const other = agents.find((a) => a !== first.agent);
  return [first, other ? { agent: other, model: "" } : { agent: "claude", model: first.model ? "" : "haiku" }];
}

/** A variant's implementer as the comparison names it: the agent, and its model when one was picked. */
export const variantLabel = (v: Pick<VariantSummary, "agent" | "model">) =>
  v.model ? `${AGENT_NAMES[v.agent]} · ${v.model}` : AGENT_NAMES[v.agent];
