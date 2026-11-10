import type { CostKind, StepAgent } from "@agentchainer/protocol";
import { t } from "../i18n/index.ts";
import { modelName } from "../modelName.ts";

/**
 * Who ran a step, for small places (M9-07): "Haiku 5.5" for Claude, whose steps are the usual ones; "Codex ·
 * gpt-6-luna" or "agy · gemini-3.8-flash-low" for the others. Agent and model names are product names, never
 * translated. Empty when the step names neither (a run from before M9).
 */
export function agentLabel(agent: StepAgent | undefined, model: string | undefined): string {
  const name = agent === "codex" ? "Codex" : agent === "agy" ? "agy" : agent === "claude" ? "Claude" : undefined;
  const shown = modelName(model);
  if (!agent || agent === "claude") return shown ?? name ?? "";
  return [name, shown].filter(Boolean).join(" · ");
}

/**
 * A cost as text, and what it means: Claude's own figure stays "≈$0.0123"; an estimate from tokens (Codex, agy)
 * reads "≈$0.0084 est." with the tokens in its title; a model with no price reads "cost unknown" (M9-07).
 */
export function costText(
  money: string,
  kind: CostKind | undefined,
  tokens: { input: number; output: number } | undefined,
): { text: string; title?: string } {
  const count = tokens ? (tokens.input + tokens.output).toLocaleString("en-US") : undefined;
  if (kind === "unknown")
    return {
      text: t("tasks.cost.unknown"),
      title: count ? t("tasks.cost.unknownHint", { tokens: count }) : t("tasks.cost.unknownNoTokens"),
    };
  if (kind === "estimate")
    return {
      text: t("tasks.cost.estimate", { cost: money }),
      ...(count ? { title: t("tasks.cost.estimateHint", { tokens: count }) } : {}),
    };
  return { text: money };
}
