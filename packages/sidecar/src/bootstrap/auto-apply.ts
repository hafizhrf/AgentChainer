import type { PlanAction } from "@agentchainer/protocol";

/**
 * Opt-in auto-apply (M2-18, docs/CATALOG.md §2): what may be applied before a new session without a preview. Only
 * recommended, pre-selected first-party and official catalog items, and fixes that only add lines (env rules in
 * .gitignore, importing AGENTS.md). Never generators (they cost model calls), fixes that change git state (untracking
 * .env, git init), or verified-vendor and community items (ADR-0005).
 */
export const AUTO_FIXES: ReadonlySet<string> = new Set(["fix:fix-gitignore", "fix:link-agents-md"]);

export function autoApplicable(action: PlanAction): boolean {
  if (action.state !== "recommended" || !action.selected) return false;
  if (action.kind === "fix") return AUTO_FIXES.has(action.id);
  if (action.kind === "catalog") return action.tier === "first-party" || action.tier === "official";
  return false;
}
