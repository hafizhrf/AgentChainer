import { type CriterionCheck, GATE_KINDS, type GateKind, type TaskContract, type Tier } from "@agentchainer/protocol";
import { t } from "../i18n/index.ts";

/** The task page's form logic (M3-02, M3-03), kept out of the component so it can be tested. */

export const TIERS: Tier[] = ["S", "M", "L", "XL"];

/** What each tier runs, as the PRD's workflow templates describe it. */
export const TIER_HELP: Record<Tier, string> = {
  get S() {
    return t("tasks.form.tierHelpS");
  },
  get M() {
    return t("tasks.form.tierHelpM");
  },
  get L() {
    return t("tasks.form.tierHelpL");
  },
  get XL() {
    return t("tasks.form.tierHelpXl");
  },
};

/** Default spend caps per tier (planner.md §15); XL's applies per sub-task. Mirrors the sidecar's defaults. */
export const DEFAULT_BUDGET_USD: Record<Tier, number> = { S: 1, M: 3, L: 8, XL: 5 };

function gateLabel(kind: GateKind): string {
  switch (kind) {
    case "format":
      return t("tasks.form.gateFormat");
    case "lint":
      return t("tasks.form.gateLint");
    case "typecheck":
      return t("tasks.form.gateTypecheck");
    case "test":
      return t("tasks.form.gateTest");
    case "build":
      return t("tasks.form.gateBuild");
    case "smoke":
      return t("tasks.form.gateSmoke");
  }
}

export type CheckOption = { value: CriterionCheck; label: string; hint?: string; disabled?: boolean };

/** How a criterion can be proved: a gate the profile has a command for, the reviewer, or the user. */
export function checkOptions(gates: GateKind[]): CheckOption[] {
  return [
    ...GATE_KINDS.map((kind): CheckOption => {
      const ok = gates.includes(kind);
      return {
        value: `gate:${kind}`,
        label: t("tasks.form.gateCheck", { gate: gateLabel(kind) }),
        ...(ok ? { hint: t("tasks.form.provedByRun") } : { hint: t("tasks.form.noCommand"), disabled: true }),
      };
    }),
    { value: "review", label: t("tasks.form.reviewer"), hint: t("tasks.form.judgedFromDiff") },
    { value: "manual", label: t("tasks.form.youCheck"), hint: t("tasks.form.notChecked") },
  ];
}

function knownSignal(signal: string): string | undefined {
  switch (signal) {
    case "risk-keywords":
      return t("tasks.form.signalRiskKeywords");
    case "breadth":
      return t("tasks.form.signalBreadth");
    case "scope":
      return t("tasks.form.signalScope");
    case "new-areas":
      return t("tasks.form.signalNewAreas");
    case "repo-size":
      return t("tasks.form.signalRepoSize");
    case "tests":
      return t("tasks.form.signalTests");
    default:
      return undefined;
  }
}

/** A triage signal's name in sentence case; an unknown one from a newer sidecar reads as its words. */
export function signalLabel(signal: string): string {
  const words = signal.replace(/-/g, " ");
  return knownSignal(signal) ?? `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function checkLabel(check: CriterionCheck): string {
  return checkOptions([...GATE_KINDS]).find((o) => o.value === check)?.label ?? check;
}

function tidyList(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const text = item.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** The form's contract as it will be sent: trimmed, empty rows dropped, criteria numbered again. */
export function tidyContract(c: TaskContract): TaskContract {
  return {
    ...c,
    objective: c.objective.trim(),
    acceptanceCriteria: c.acceptanceCriteria
      .map((a) => ({ ...a, text: a.text.trim() }))
      .filter((a) => a.text)
      .map((a, i) => ({ ...a, id: `c${i + 1}` })),
    constraints: tidyList(c.constraints),
    outOfScope: tidyList(c.outOfScope),
    risks: tidyList(c.risks),
    affectedAreas: tidyList(c.affectedAreas),
    openQuestions: tidyList(c.openQuestions),
  };
}

/** Whether the edits change the contract that was triaged (blank rows and spacing don't count). */
export function contractChanged(edited: TaskContract, saved: TaskContract): boolean {
  const comparable = (c: TaskContract) => JSON.stringify({ ...tidyContract(c), approvedAt: undefined });
  return comparable(edited) !== comparable(saved);
}

/** Why Approve can't run yet, or null when it can. */
export function approveBlocker(state: {
  edited: TaskContract;
  stale: boolean;
  tier: Tier;
  proposed: Tier;
  reason: string;
  budget: string;
}): string | null {
  const c = tidyContract(state.edited);
  if (state.stale) return t("tasks.form.staleContract");
  if (!c.objective) return t("tasks.form.writeObjective");
  if (c.acceptanceCriteria.length === 0) return t("tasks.form.addCriterion");
  if (state.tier !== state.proposed && !state.reason.trim())
    return t("tasks.form.sayWhy", { tier: state.tier, proposed: state.proposed });
  if (state.budget === NO_BUDGET) return state.tier === "XL" ? t("tasks.form.xlNeedsBudget") : null;
  const budget = Number(state.budget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) return t("tasks.form.budgetRange");
  return null;
}

/** The budget field's value for a task with no spend cap (UX-13). */
export const NO_BUDGET = "none";

/** What `task.approve` takes: null for no budget. */
export const budgetValue = (budget: string): number | null => (budget === NO_BUDGET ? null : Number(budget));

/** "$2", "$2 per sub-task", or "no budget". */
export function budgetText(budgetUsd: number | null | undefined, xl = false): string {
  if (budgetUsd === null) return t("tasks.form.noBudget");
  if (budgetUsd === undefined) return "";
  return t(xl ? "tasks.form.budgetPerSubtask" : "tasks.form.budget", { amount: budgetUsd });
}
