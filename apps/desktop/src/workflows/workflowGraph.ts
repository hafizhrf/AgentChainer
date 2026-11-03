import type { Path } from "./workflowDoc.ts";

/**
 * A workflow as a graph for the canvas (M6-04): its steps top to bottom, a parallel group's members side by side, and
 * each fix as a back edge to the step that gets the failures. A workflow is a line, so the layout is computed here
 * rather than by dagre. Nodes are keyed by their path in the YAML, which is what the form edits.
 */

export type StepKind = "agent" | "gates" | "group" | "member" | "split" | "subtasks" | "integration";

export type WorkflowNode = {
  id: string;
  path: Path;
  /** The step's `id` in the workflow, which a run's timeline names (UX-14); unset for groups and XL's boxes. */
  stepId?: string;
  kind: StepKind;
  label: string;
  detail: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  kind: "next" | "fix";
  label?: string;
  /** A fix edge's round limit, and the step it sends work back to. */
  maxRounds?: number;
  targetStep?: string;
};

export const STEP_W = 240;
/** Room for the status line, the name and a detail of up to two lines (UX-17). */
export const STEP_H = 92;
const GAP_Y = 48;
const GAP_X = 16;
/** Room around a group's members for its own label. */
const GROUP_PAD = 16;
const GROUP_HEAD = 28;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const keyOf = (path: Path) => path.join(".");

function agentDetail(s: Obj): string {
  const limits = obj(s.limits);
  const parts = [str(s.role, "?"), str(s.access, "?")];
  if (typeof s.output === "string") parts.push(`→ ${s.output}`);
  if (typeof limits.maxBudgetUsd === "number") parts.push(`$${limits.maxBudgetUsd}`);
  return parts.join(" · ");
}

/** The nodes and edges of `data` (a parsed workflow); whatever doesn't parse yet is drawn as far as it goes. */
export function workflowGraph(data: Obj | null): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  if (!data) return { nodes, edges };
  const next = (from: string[], to: string[]) => {
    for (const s of from) for (const t of to) edges.push({ id: `${s}->${t}`, source: s, target: t, kind: "next" });
  };
  const box = (path: Path, kind: StepKind, label: string, detail: string, x: number, y: number, stepId?: unknown) => {
    const node: WorkflowNode = {
      id: keyOf(path),
      path,
      kind,
      label,
      detail,
      x,
      y,
      width: STEP_W,
      height: STEP_H,
      ...(typeof stepId === "string" ? { stepId } : {}),
    };
    nodes.push(node);
    return node;
  };

  if (data.split !== undefined) {
    // XL: the split, the sub-tasks with their own tiers' workflows, then the integration gates.
    const split = obj(data.split);
    box(["split"], "split", str(split.label, "Split"), agentDetail(split), 0, 0);
    box(
      ["maxParallel"],
      "subtasks",
      "Sub-tasks",
      `each with its tier's workflow · ${data.maxParallel ?? "?"} at once`,
      0,
      STEP_H + GAP_Y,
    );
    const gates = list(obj(data.integration).gates).map(String);
    box(["integration"], "integration", "Integration gates", gates.join(", ") || "none", 0, 2 * (STEP_H + GAP_Y));
    next(["split"], ["maxParallel"]);
    next(["maxParallel"], ["integration"]);
    return { nodes, edges };
  }

  let y = 0;
  let previous: string[] = [];
  const byId = new Map<string, string>();
  const fixes: { from: string; step: string; rounds: unknown }[] = [];
  for (const [i, raw] of list(data.steps).entries()) {
    const s = obj(raw);
    const path: Path = ["steps", i];
    if (Array.isArray(s.parallel)) {
      const members = s.parallel.map(obj);
      const width = members.length * STEP_W + (members.length - 1) * GAP_X;
      const left = (STEP_W - width) / 2;
      nodes.push({
        id: keyOf(path),
        path,
        kind: "group",
        label: str(s.label, "Parallel"),
        detail: `${members.length} at once, read-only`,
        x: left - GROUP_PAD,
        y,
        width: width + 2 * GROUP_PAD,
        height: GROUP_HEAD + STEP_H + GROUP_PAD,
      });
      const ids = members.map((m, j) => {
        const node = box(
          [...path, "parallel", j],
          "member",
          str(m.label, str(m.id)),
          agentDetail(m),
          left + j * (STEP_W + GAP_X),
          y + GROUP_HEAD,
          m.id,
        );
        if (typeof m.id === "string") byId.set(m.id, node.id);
        return node.id;
      });
      next(previous, ids);
      previous = ids;
      y += GROUP_HEAD + STEP_H + GROUP_PAD + GAP_Y;
      continue;
    }
    const gates = Array.isArray(s.gates);
    const node = box(
      path,
      gates ? "gates" : "agent",
      str(s.label, str(s.id, `Step ${i + 1}`)),
      gates ? list(s.gates).map(String).join(", ") : agentDetail(s),
      0,
      y,
      s.id,
    );
    if (typeof s.id === "string") byId.set(s.id, node.id);
    const fix = obj(s.fix);
    if (typeof fix.step === "string") fixes.push({ from: node.id, step: fix.step, rounds: fix.maxRounds });
    next(previous, [node.id]);
    previous = [node.id];
    y += STEP_H + GAP_Y;
  }
  for (const f of fixes) {
    const target = byId.get(f.step);
    if (!target) continue;
    edges.push({
      id: `${f.from}~fix`,
      source: f.from,
      target,
      kind: "fix",
      label: `fix ×${f.rounds ?? "?"}`,
      ...(typeof f.rounds === "number" ? { maxRounds: f.rounds } : {}),
      targetStep: f.step,
    });
  }
  return { nodes, edges };
}
