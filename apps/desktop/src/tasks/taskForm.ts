import { type CriterionCheck, GATE_KINDS, type GateKind, type TaskContract, type Tier } from "@agentchainer/protocol";

/** The task page's form logic (M3-02, M3-03), kept out of the component so it can be tested. */

export const TIERS: Tier[] = ["S", "M", "L", "XL"];

/** What each tier runs, as the PRD's workflow templates describe it. */
export const TIER_HELP: Record<Tier, string> = {
  S: "One agent, then the project's checks.",
  M: "Plan, implement, checks, then a review.",
  L: "Specialist planning, implement, checks, then an independent review.",
  XL: "Split into sub-tasks, each with its own contract and worktree.",
};

/** Default spend caps per tier (planner.md §15); XL's applies per sub-task. Mirrors the sidecar's defaults. */
export const DEFAULT_BUDGET_USD: Record<Tier, number> = { S: 1, M: 3, L: 8, XL: 5 };

const GATE_LABEL: Record<GateKind, string> = {
  format: "Format",
  lint: "Lint",
  typecheck: "Typecheck",
  test: "Tests",
  build: "Build",
  smoke: "Smoke test",
};

export type CheckOption = { value: CriterionCheck; label: string; hint?: string; disabled?: boolean };

/** How a criterion can be proved: a gate the profile has a command for, the reviewer, or the user. */
export function checkOptions(gates: GateKind[]): CheckOption[] {
  return [
    ...GATE_KINDS.map((kind): CheckOption => {
      const ok = gates.includes(kind);
      return {
        value: `gate:${kind}`,
        label: `Gate: ${GATE_LABEL[kind]}`,
        ...(ok ? { hint: "Proved by a run" } : { hint: "No command detected", disabled: true }),
      };
    }),
    { value: "review", label: "Reviewer", hint: "Judged from the diff" },
    { value: "manual", label: "You check it", hint: "Not checked by AgentChainer" },
  ];
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
  if (state.stale) return "The contract changed: run triage again.";
  if (!c.objective) return "Write the objective.";
  if (c.acceptanceCriteria.length === 0) return "Add at least one acceptance criterion.";
  if (state.tier !== state.proposed && !state.reason.trim())
    return `Say why ${state.tier} rather than ${state.proposed}.`;
  const budget = Number(state.budget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) return "Set a budget between $0 and $1000.";
  return null;
}
