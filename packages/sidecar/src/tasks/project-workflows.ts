import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type ProjectWorkflowProblem, type TaskRun, TIERS, type TierWorkflow } from "@agentchainer/protocol";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { AC_DIR } from "../ac-dir.ts";
import { workflowText } from "../catalog/text.ts";
import { t } from "../i18n/index.ts";
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
      if (!stat.isFile()) throw new Error(t("tasks.projectWorkflows.notRegularFile"));
      if (stat.size > MAX_BYTES) throw new Error(t("tasks.projectWorkflows.tooLarge", { kb: MAX_BYTES / 1024 }));
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
    throw new Error(
      t("tasks.projectWorkflows.invalidYaml", { error: err instanceof Error ? err.message : String(err) }),
    );
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
  if (name !== expected) throw new Error(t("tasks.projectWorkflows.wrongFile", { tier: w.data.tier, file: expected }));
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
      description: workflowText(w).description,
      steps: "split" in w ? 1 : w.steps.length,
      ...(origin ? origin : { source: "app" as const }),
    };
  };
  return TIERS.flatMap((tier) => {
    const w = tier === "XL" ? eff.library.xl : eff.library.workflows[tier];
    return w ? [entry(tier, w)] : [];
  });
}

/* ---------- The canvas (M6-04, design §9) ---------- */

type Tier = TierWorkflow["tier"];
const fileOf = (tier: Tier) => `${tier.toLowerCase()}.yaml`;

/** The tier's workflow as YAML: the project's file as it is, or the app's rendered with a note on where it goes. */
export function workflowSource(
  root: string,
  tier: Tier,
  shipped: Library,
): { yaml: string; source: "app" | "project"; file: string } {
  const file = `${WORKFLOWS_DIR}/${fileOf(tier)}`;
  const abs = path.join(root, file);
  if (existsSync(abs) && lstatSync(abs).isFile() && lstatSync(abs).size <= MAX_BYTES) {
    return { yaml: readFileSync(abs, "utf8"), source: "project", file };
  }
  const app = tier === "XL" ? shipped.xl : shipped.workflows[tier];
  if (!app) throw new Error(t("tasks.projectWorkflows.noAppWorkflow", { tier }));
  const header = [
    `# The app's ${tier} workflow (${app.id} v${app.version}), as a starting point.`,
    `# Saved as ${file}, it replaces the app's ${tier} workflow in this project; share it through git.`,
    "",
  ].join("\n");
  return { yaml: `${header}${stringify(app)}`, source: "app", file };
}

/** Why the YAML can't be used for `tier`, or null: the checks a run makes. */
export function checkWorkflowText(tier: Tier, yaml: string, shipped: Library): string | null {
  try {
    const w = parseProjectWorkflow(fileOf(tier), yaml, shipped);
    if (w.tier !== tier) return t("tasks.projectWorkflows.wrongTier", { found: w.tier, tier });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Saves a valid workflow as the project's file for `tier`, or removes the file (null), so the app's runs again. */
export function saveProjectWorkflow(root: string, tier: Tier, yaml: string | null, shipped: Library): void {
  const abs = path.join(root, WORKFLOWS_DIR, fileOf(tier));
  if (yaml === null) {
    rmSync(abs, { force: true });
    return;
  }
  const error = checkWorkflowText(tier, yaml, shipped);
  if (error) throw new Error(t("tasks.projectWorkflows.cantSave", { error }));
  mkdirSync(path.dirname(abs), { recursive: true });
  if (existsSync(abs) && !lstatSync(abs).isFile())
    throw new Error(t("tasks.projectWorkflows.notRegular", { file: `${WORKFLOWS_DIR}/${fileOf(tier)}` }));
  writeFileSync(abs, yaml.endsWith("\n") ? yaml : `${yaml}\n`);
}

/** Import: a workflow file the person picked; only its text, at most the size a project file may have. */
export function readWorkflowFile(file: string): string {
  if (!/\.ya?ml$/i.test(file)) throw new Error(t("tasks.projectWorkflows.pickYaml"));
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(t("tasks.projectWorkflows.notAFile"));
  if (stat.size > MAX_BYTES) throw new Error(t("tasks.projectWorkflows.fileTooLarge", { kb: MAX_BYTES / 1024 }));
  return readFileSync(file, "utf8");
}

/** Export: writes the YAML where the person picked in the save dialog. */
export function writeWorkflowFile(file: string, yaml: string): void {
  if (!/\.ya?ml$/i.test(file)) throw new Error(t("tasks.projectWorkflows.exportYaml"));
  writeFileSync(file, yaml.endsWith("\n") ? yaml : `${yaml}\n`);
}
