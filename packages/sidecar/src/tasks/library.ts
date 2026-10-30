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

/** Read-only steps that run at the same time (L's planners); their answers merge into `plan.md`, one section each. */
export const ParallelStepSchema = z
  .object({
    id: StepId,
    label: z.string().min(1),
    parallel: z.array(AgentStepSchema).min(2).max(5),
    output: z.literal("plan"),
  })
  .strict();
export type ParallelStep = z.infer<typeof ParallelStepSchema>;

export type WorkflowStep = AgentStep | GatesStep | ParallelStep;
export const isGates = (s: WorkflowStep): s is GatesStep => "gates" in s;
export const isParallel = (s: WorkflowStep): s is ParallelStep => "parallel" in s;

export const WorkflowSchema = z
  .object({
    id: z.string().regex(/^tier-[a-z]+$/),
    tier: z.enum(TIERS),
    version: z.number().int().positive(),
    description: z.string().min(1),
    steps: z.array(z.union([AgentStepSchema, GatesStepSchema, ParallelStepSchema])).min(1),
  })
  .strict()
  .superRefine((w, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message: `${w.id}/${message}` });
    const ids = w.steps.flatMap((s) => (isParallel(s) ? [s.id, ...s.parallel.map((m) => m.id)] : [s.id]));
    if (new Set(ids).size !== ids.length) issue("step ids must be unique");
    for (const [i, s] of w.steps.entries()) {
      if (isParallel(s)) {
        // Only read steps may run at the same time: two writers would edit the same tree.
        for (const m of s.parallel) {
          if (m.access !== "read" || m.output || m.fix)
            issue(`${m.id}: a parallel step must be read-only, without output or fix`);
        }
        continue;
      }
      if (!isGates(s) && s.output === "review" && s.access !== "read")
        issue(`${s.id}: a review step must be read-only`);
      if (!s.fix) continue;
      const target = w.steps.find((t) => t.id === s.fix?.step);
      if (
        !target ||
        isGates(target) ||
        isParallel(target) ||
        target.access !== "write" ||
        w.steps.indexOf(target) > i
      ) {
        issue(`${s.id}: fix.step must name an earlier write step`);
      }
      if (!isGates(s) && s.output !== "review") issue(`${s.id}: only a review step takes fix`);
    }
  });
export type Workflow = z.infer<typeof WorkflowSchema>;

/**
 * XL (M3-07): not a list of steps. A read-only architect splits the contract into sub-tasks, which run with their own
 * tiers' workflows in worktrees, `maxParallel` at once; the integration gates run on the merged task branch.
 */
export const XlWorkflowSchema = z
  .object({
    id: z.literal("tier-xl"),
    tier: z.literal("XL"),
    version: z.number().int().positive(),
    description: z.string().min(1),
    split: AgentStepSchema,
    maxParallel: z.number().int().min(1).max(4),
    integration: z.object({ gates: z.array(z.enum(GATE_KINDS)).min(1) }).strict(),
  })
  .strict()
  .refine((w) => w.split.access === "read" && !w.split.output && !w.split.fix, {
    message: "tier-xl/split: the split step is read-only, without output or fix",
  });
export type XlWorkflow = z.infer<typeof XlWorkflowSchema>;

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
  xl: XlWorkflowSchema.optional(),
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
  // Keys in the schema's order, so the compiled JSON reads back identical (xl stays out of it when there's none).
  const out: Library = { workflows: {}, xl: undefined, roles: {} };
  for (const [file, text] of Object.entries(workflows)) {
    if (file === "xl.yaml") {
      const xl = XlWorkflowSchema.safeParse(parse(text));
      if (!xl.success) throw new Error(`catalog/workflows/${file} is invalid:\n${z.prettifyError(xl.error)}`);
      out.xl = xl.data;
      continue;
    }
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
  const readSteps = [
    ...Object.values(out.workflows).flatMap((w) =>
      w.steps.flatMap((x) => (isParallel(x) ? x.parallel : isGates(x) ? [] : [x])).map((s) => ({ w: w.id, s })),
    ),
    ...(out.xl ? [{ w: out.xl.id, s: out.xl.split }] : []),
  ];
  for (const { w, s } of readSteps) {
    if (s.access === "read" && out.roles[s.role]?.tools !== "Read, Grep, Glob") {
      throw new Error(`${w}/${s.id}: a read step's role must list tools: Read, Grep, Glob`);
    }
  }
  return out;
}

export const libraryJsonText = (library: Library) => `${JSON.stringify(library, null, 2)}\n`;

/** A role back as its file, as `.claude/agents/` reads it: what "Install roles" writes (M3-05). */
export function renderRoleFile(role: RoleDefinition): string {
  return [
    "---",
    `name: ${role.name}`,
    `description: ${role.description}`,
    ...(role.tools ? [`tools: ${role.tools}`] : []),
    `model: ${role.model}`,
    "---",
    "",
    role.prompt,
    "",
  ].join("\n");
}
