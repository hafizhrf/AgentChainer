import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type AgentRoles, StepAgentSchema, TaskContractSchema, TierSchema } from "@agentchainer/protocol";
import { z } from "zod";
import { FIXTURE_SETUPS } from "../detect/fixture-copy.ts";

/**
 * The eval suite (M7-02, docs/design/evals.md §5): tasks on copies of `fixtures/`, each with a written contract and
 * acceptance checks. The checks' hidden files are copied in only after the run, so the agent never sees them.
 */

const CheckSchema = z.object({
  /** What the check shows, for the report. */
  name: z.string().min(1),
  /** Run without a shell, in the code folder; argv[0] is looked up on PATH. */
  argv: z.array(z.string().min(1)).min(1),
});

export const EvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  fixture: z.string().refine((f) => f in FIXTURE_SETUPS, "not a fixture with a setup in fixture-copy.ts"),
  request: z.string().min(1),
  contract: TaskContractSchema.omit({ task: true, approvedAt: true }),
  tier: TierSchema.exclude(["XL"]),
  /**
   * A folder under `test/evals/start/` copied over the fixture and committed before the run, e.g. to fix the fixture's
   * seeded bug so the case's gates start green.
   */
  start: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  /** Files under `test/evals/hidden/<id>/`, copied over the code folder after the run, before the checks. */
  hidden: z.boolean().default(false),
  checks: z.array(CheckSchema).min(1),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalSuiteSchema = z.object({
  version: z.literal(1),
  about: z.string(),
  cases: z.array(EvalCaseSchema).min(1),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

export function readSuite(file: string): EvalSuite {
  const suite = EvalSuiteSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const ids = suite.cases.map((c) => c.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`case ${twice} appears twice`);
  return suite;
}

/** What a variant changes; the rest is the app as checked out. */
export type Variant = {
  name: string;
  /** The model every step runs with; haiku when not given. */
  model: string;
  /** Workflow files (`s.yaml`, `m.yaml`, …) put in the fixture copy's `.agentchainer/workflows/`, by file name. */
  workflows: Record<string, string>;
  /** Where the workflows came from, for the report. */
  workflowsFrom: string | null;
  /** The agent per role (M9-06), as a task's own choice would set it; empty runs every step on Claude. */
  agents: AgentRoles;
};

const ROLES = ["plan", "implement", "review"] as const;

const WORKFLOW_FILES = ["s.yaml", "m.yaml", "l.yaml", "xl.yaml"];

/**
 * Parses `name[:key=value,…]`. Keys: `model=<model>`; `workflows=<dir>` (a folder of tier workflow files);
 * `workflows-ref=<git rev>` (the app's `catalog/workflows/` at that revision, e.g. `origin/main`, the usual baseline
 * for a workflow change); `agent=<claude|codex|agy>` for every role, or `plan=`, `implement=`, `review=` for one
 * (M9-06). Only Claude's spend counts toward the cost: the other CLIs report tokens, not dollars.
 */
export function parseVariant(spec: string, repoRoot: string): Variant {
  const [name = "", rest] = spec.split(/:(.*)/s, 2);
  if (!/^[\w.-]+$/.test(name)) throw new Error(`variant "${spec}": name it with letters, digits, . _ or -`);
  const v: Variant = { name, model: "haiku", workflows: {}, workflowsFrom: null, agents: {} };
  for (const pair of rest ? rest.split(",") : []) {
    const [key, value] = pair.split(/=(.*)/s, 2);
    if (!value) throw new Error(`variant "${spec}": ${pair} has no value`);
    if (key === "model") v.model = value;
    else if (key === "workflows") {
      v.workflows = readWorkflowDir(path.resolve(value));
      v.workflowsFrom = value;
    } else if (key === "workflows-ref") {
      v.workflows = workflowsAt(repoRoot, value);
      v.workflowsFrom = `catalog/workflows@${value}`;
    } else if (key === "agent" || (ROLES as readonly string[]).includes(key ?? "")) {
      const agent = StepAgentSchema.safeParse(value);
      if (!agent.success) throw new Error(`variant "${spec}": ${key} is claude, codex or agy, not ${value}`);
      for (const role of key === "agent" ? ROLES : [key as (typeof ROLES)[number]]) v.agents[role] = agent.data;
    } else {
      throw new Error(
        `variant "${spec}": unknown key ${key} (model, workflows, workflows-ref, agent, plan, implement, review)`,
      );
    }
  }
  return v;
}

function readWorkflowDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of WORKFLOW_FILES) {
    try {
      out[f] = readFileSync(path.join(dir, f), "utf8");
    } catch {
      // A tier without a file runs the app's workflow.
    }
  }
  if (!Object.keys(out).length) throw new Error(`${dir} has none of ${WORKFLOW_FILES.join(", ")}`);
  return out;
}

/** The app's tier workflows at a git revision. */
function workflowsAt(repoRoot: string, rev: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of WORKFLOW_FILES) {
    out[f] = execFileSync("git", ["show", `${rev}:catalog/workflows/${f}`], { cwd: repoRoot, encoding: "utf8" });
  }
  return out;
}
