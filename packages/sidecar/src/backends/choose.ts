import type { AgentRoles, StepAgent } from "@agentchainer/protocol";
import type { AgentStep, Workflow } from "../tasks/library.ts";

/**
 * Which agent runs a task's step (M9-06, ADR-0012 §5): any role on any agent the user has. The step's own `agent:`
 * wins, then the task's choice for the step's role, then Claude. (The workspace's defaults per role come next.)
 */

export type AgentRole = keyof AgentRoles;

/** A step's role, by what it does: a write step implements, a read step that returns a verdict reviews, others plan. */
export function roleOf(step: Pick<AgentStep, "access" | "output">): AgentRole {
  if (step.access === "write") return "implement";
  return step.output === "review" ? "review" : "plan";
}

export function agentFor(step: Pick<AgentStep, "access" | "output" | "agent">, chosen?: AgentRoles): StepAgent {
  return step.agent ?? chosen?.[roleOf(step)] ?? "claude";
}

/** Every agent step of a workflow, parallel members included. */
function agentSteps(workflow: Pick<Workflow, "steps">): AgentStep[] {
  return workflow.steps.flatMap((s) => ("parallel" in s ? s.parallel : "gates" in s ? [] : [s]));
}

/** The agents a run of `workflow` needs, besides Claude: each must be installed before it starts. */
export function agentsNeeded(workflow: Pick<Workflow, "steps">, chosen?: AgentRoles): StepAgent[] {
  const needed = new Set(agentSteps(workflow).map((s) => agentFor(s, chosen)));
  needed.delete("claude");
  return [...needed].sort();
}

/** The roles a workflow has, in its order: what the task's agent pickers offer. */
export function rolesOf(workflow: Pick<Workflow, "steps">): AgentRole[] {
  const seen: AgentRole[] = [];
  for (const s of agentSteps(workflow)) {
    const r = roleOf(s);
    if (!seen.includes(r)) seen.push(r);
  }
  return seen;
}
