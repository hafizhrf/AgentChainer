import { GATE_KINDS, TIERS } from "@agentchainer/protocol";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The task library (M3-04, M3-05): a workflow template per tier (`catalog/workflows/*.yaml`) and the role prompts
 * steps run with (`agents/ac-*.md`). Both are first-party and compiled into `library.json` by
 * `scripts/build-catalog.ts`, like the generators' skills, so nothing is parsed or fetched at runtime (ADR-0007).
 */

export const ROLES = [
  "implementer",
  "architect",
  "independent-reviewer",
  "test-planner",
  "security-reviewer",
  "docs-writer",
] as const;
export type Role = (typeof ROLES)[number];

const StepId = z.string().regex(/^[a-z][a-z0-9-]*$/);

/** Where fixes go: the write step whose session gets the failures, how many rounds, and their spend. */
const FixSchema = z
  .object({
    step: StepId,
    maxRounds: z.number().int().min(0).max(5),
    maxBudgetUsd: z.number().positive().max(100),
  })
  .strict();

export const AgentStepSchema = z
  .object({
    id: StepId,
    label: z.string().min(1),
    role: z.enum(ROLES),
    /** read: Read, Grep and Glob only, isolated from the user's settings. write: the normal tools and approvals. */
    access: z.enum(["read", "write"]),
    /** What the step's prompt includes: the contract, the plan step's output, the diff since the base, gate runs. */
    inputs: z.array(z.enum(["contract", "plan", "diff", "gates"])),
    /** What the orchestrator keeps from the step's answer: `plan.md`, or `review.json` (structured output). */
    output: z.enum(["plan", "review"]).optional(),
    /** A new session that sees only its inputs, never another step's transcript. */
    fresh: z.boolean().optional(),
    /** Review only: must-fix findings go back to this write step, then the gates run again. */
    fix: FixSchema.optional(),
    limits: z
      .object({ maxTurns: z.number().int().positive().max(500), maxBudgetUsd: z.number().positive().max(100) })
      .strict(),
  })
  .strict();
export type AgentStep = z.infer<typeof AgentStepSchema>;

export const GatesStepSchema = z
  .object({
    id: StepId,
    label: z.string().min(1),
    /** The gates this step runs, in order; kinds the workspace has no command for are reported as not run. */
    gates: z.array(z.enum(GATE_KINDS)).min(1),
    fix: FixSchema,
  })
  .strict();
export type GatesStep = z.infer<typeof GatesStepSchema>;

export type WorkflowStep = AgentStep | GatesStep;
export const isGates = (s: WorkflowStep): s is GatesStep => "gates" in s;

export const WorkflowSchema = z
  .object({
    id: z.string().regex(/^tier-[a-z]+$/),
    tier: z.enum(TIERS),
    version: z.number().int().positive(),
    description: z.string().min(1),
    steps: z.array(z.union([AgentStepSchema, GatesStepSchema])).min(1),
  })
  .strict()
  .superRefine((w, ctx) => {
    const ids = w.steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: `${w.id}: step ids must be unique` });
    for (const [i, s] of w.steps.entries()) {
      if (!s.fix) continue;
      const target = w.steps.find((t) => t.id === s.fix?.step);
      if (!target || isGates(target) || target.access !== "write" || w.steps.indexOf(target) > i) {
        ctx.addIssue({ code: "custom", message: `${w.id}/${s.id}: fix.step must name an earlier write step` });
      }
      if (!isGates(s) && s.output !== "review") {
        ctx.addIssue({ code: "custom", message: `${w.id}/${s.id}: only a review step takes fix` });
      }
    }
    for (const s of w.steps) {
      if (!isGates(s) && s.output === "review" && s.access !== "read") {
        ctx.addIssue({ code: "custom", message: `${w.id}/${s.id}: a review step must be read-only` });
      }
    }
  });
export type Workflow = z.infer<typeof WorkflowSchema>;

/** A role file's frontmatter, as `.claude/agents/` expects it, plus the prompt (its body). */
export const RoleSchema = z
  .object({
    name: z.string().regex(/^ac-[a-z-]+$/),
    description: z.string().min(1),
    /** Omitted: the normal tools. Read-only roles list theirs. */
    tools: z.string().optional(),
    /** `inherit` takes the task's model; the reviewer is stronger than the work it checks (planner.md §15). */
    model: z.enum(["inherit", "haiku", "sonnet", "opus"]),
    prompt: z.string().min(1),
  })
  .strict();
export type RoleDefinition = z.infer<typeof RoleSchema>;

export const LibrarySchema = z.object({
  workflows: z.record(z.string(), WorkflowSchema),
  roles: z.record(z.string(), RoleSchema),
});
export type Library = z.infer<typeof LibrarySchema>;

/** Splits a markdown file with YAML frontmatter into its fields and body. */
export function parseRoleFile(text: string): unknown {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("a role file starts with --- frontmatter ---");
  return { ...(parse(m[1] ?? "") as object), prompt: (m[2] ?? "").trim() };
}

/** Builds the library from the sources: `workflows` YAML texts by file name, role markdown texts by file name. */
export function buildLibrary(workflows: Record<string, string>, roles: Record<string, string>): Library {
  const out: Library = { workflows: {}, roles: {} };
  for (const [file, text] of Object.entries(workflows)) {
    const w = WorkflowSchema.safeParse(parse(text));
    if (!w.success) throw new Error(`catalog/workflows/${file} is invalid:\n${z.prettifyError(w.error)}`);
    if (`${w.data.tier.toLowerCase()}.yaml` !== file) throw new Error(`catalog/workflows/${file}: name it <tier>.yaml`);
    out.workflows[w.data.tier] = w.data;
  }
  for (const [file, text] of Object.entries(roles)) {
    const r = RoleSchema.safeParse(parseRoleFile(text));
    if (!r.success) throw new Error(`agents/${file} is invalid:\n${z.prettifyError(r.error)}`);
    if (`${r.data.name}.md` !== file) throw new Error(`agents/${file}: name it <name>.md`);
    out.roles[r.data.name.slice(3)] = r.data;
  }
  for (const role of ROLES) if (!out.roles[role]) throw new Error(`agents/ac-${role}.md is missing`);
  for (const w of Object.values(out.workflows)) {
    for (const s of w.steps) {
      if (isGates(s)) continue;
      const role = out.roles[s.role];
      if (s.access === "read" && role?.tools !== "Read, Grep, Glob") {
        throw new Error(`${w.id}/${s.id}: a read step's role must list tools: Read, Grep, Glob`);
      }
    }
  }
  return out;
}

export const libraryJsonText = (library: Library) => `${JSON.stringify(library, null, 2)}\n`;
