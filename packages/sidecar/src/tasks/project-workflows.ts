import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ProjectWorkflowProblem, type TaskRun, TIERS, type TierWorkflow } from "@agentchainer/protocol";
import { parse } from "yaml";
import { z } from "zod";
import { AC_DIR } from "../ac-dir.ts";
import {
  checkReadRoles,
  type Library,
  readStepsOf,
  type Workflow,
  WorkflowSchema,
  type XlWorkflow,
  XlWorkflowSchema,
} from "./library.ts";

/**
 * A project's own workflows (M6-04, docs/design/deploy-and-canvas.md §9): `.agentchainer/workflows/<tier>.yaml`, in
 * the repository and shared through git. Each one replaces the app's workflow for its tier only when it passes the
 * same checks the shipped library does; otherwise the app's runs, and the problem is reported. Roles stay the app's:
 * a workflow names them, it can't define them. The file is repository content (THREAT_MODEL T-03), so it can't do
 * more than the schema allows, and the task's own budget still caps the run.
 */

export const WORKFLOWS_DIR = `${AC_DIR}/workflows`;
/** Far beyond any real workflow; a bigger file isn't read. */
const MAX_BYTES = 64 * 1024;

/** Where a workflow comes from: the project's file, with its hash so a run can name the exact one. */
export type ProjectOrigin = { source: "project"; file: string; hash: string };
/** What a run records about its workflow. */
export type WorkflowRef = TaskRun["workflow"];

export type EffectiveLibrary = {
  library: Library;
  /** By workflow id, the project's that replaced the app's. */
  origins: Record<string, ProjectOrigin>;
  problems: ProjectWorkflowProblem[];
};

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The app's library with the project's valid workflows in place of the app's, and why the others weren't used. */
export function effectiveLibrary(root: string, shipped: Library): EffectiveLibrary {
  const out: EffectiveLibrary = {
    library: { ...shipped, workflows: { ...shipped.workflows } },
    origins: {},
    problems: [],
  };
  const dir = path.join(root, WORKFLOWS_DIR);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return out;
  for (const name of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const file = `${WORKFLOWS_DIR}/${name}`;
    try {
      const stat = lstatSync(path.join(dir, name));
      if (!stat.isFile()) throw new Error("not a regular file (links aren't followed)");
      if (stat.size > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES / 1024} KB`);
      const text = readFileSync(path.join(dir, name), "utf8");
      const origin: ProjectOrigin = { source: "project", file, hash: hashOf(text) };
      const workflow = parseProjectWorkflow(name, text, shipped);
      if ("split" in workflow) out.library.xl = workflow;
      else out.library.workflows[workflow.tier] = workflow;
      out.origins[workflow.id] = origin;
    } catch (err) {
      out.problems.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** One project workflow file, checked like the shipped library's (`buildLibrary`); throws why it can't be used. */
export function parseProjectWorkflow(name: string, text: string, shipped: Library): Workflow | XlWorkflow {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    throw new Error(`not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (name === "xl.yaml") {
    const xl = XlWorkflowSchema.safeParse(data);
    if (!xl.success) throw new Error(z.prettifyError(xl.error));
    checkReadRoles([{ w: xl.data.id, s: xl.data.split }], shipped.roles);
    return xl.data;
  }
  const w = WorkflowSchema.safeParse(data);
  if (!w.success) throw new Error(z.prettifyError(w.error));
  const expected = `${w.data.tier.toLowerCase()}.yaml`;
  if (name !== expected) throw new Error(`a ${w.data.tier} workflow goes in ${expected}`);
  checkReadRoles(readStepsOf(w.data), shipped.roles);
  return w.data;
}

/** What a new run records about `workflow`: its id and version, and the project's file when it's the project's. */
export function workflowRef(workflow: Pick<Workflow, "id" | "version">, eff: EffectiveLibrary): WorkflowRef {
  const origin = eff.origins[workflow.id];
  return { id: workflow.id, version: workflow.version, ...(origin ? origin : {}) };
}

/** The workflow each tier runs, the app's or the project's, for the Workflows page. */
export function tierWorkflows(eff: EffectiveLibrary): TierWorkflow[] {
  const entry = (tier: TierWorkflow["tier"], w: Workflow | XlWorkflow): TierWorkflow => {
    const origin = eff.origins[w.id];
    return {
      tier,
      id: w.id,
      version: w.version,
      description: w.description,
      steps: "split" in w ? 1 : w.steps.length,
      ...(origin ? origin : { source: "app" as const }),
    };
  };
  return TIERS.flatMap((tier) => {
    const w = tier === "XL" ? eff.library.xl : eff.library.workflows[tier];
    return w ? [entry(tier, w)] : [];
  });
}
