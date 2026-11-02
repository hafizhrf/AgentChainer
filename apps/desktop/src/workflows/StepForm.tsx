import { GATE_KINDS, STEP_INPUTS, WORKFLOW_ROLES } from "@agentchainer/protocol";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";
import type { Path } from "./workflowDoc.ts";
import type { WorkflowNode } from "./workflowGraph.ts";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
/** A number field's value: a number when it reads as one, else the text, which the check then reports. */
const num = (v: string): number | string => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v);

/** The value at `path` in the parsed workflow. */
export function valueAt(data: Obj | null, path: Path): unknown {
  let v: unknown = data;
  for (const k of path) v = Array.isArray(v) ? v[k as number] : obj(v)[k as string];
  return v;
}

/** The write steps before `index`, the ones a fix can go to. */
function fixTargets(data: Obj | null, index: number): string[] {
  const steps = Array.isArray(data?.steps) ? (data?.steps as unknown[]) : [];
  return steps
    .slice(0, index)
    .map(obj)
    .filter((s) => s.access === "write" && typeof s.id === "string")
    .map((s) => s.id as string);
}

function Checks({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="workflow-checks">
      <legend className="field-label">{label}</legend>
      {options.map((o) => (
        <label key={o} className="check">
          <input
            type="checkbox"
            checked={value.includes(o)}
            onChange={(e) =>
              onChange(
                e.target.checked ? options.filter((x) => x === o || value.includes(x)) : value.filter((x) => x !== o),
              )
            }
          />
          {o}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The fields of the selected step (M6-04). Every change is one `onSet(path, value)`, which edits the YAML in place;
 * the sidecar's check then says whether the workflow can run.
 */
export function StepForm({
  node,
  data,
  onSet,
}: {
  node: WorkflowNode;
  data: Obj | null;
  onSet: (path: Path, value: unknown) => void;
}) {
  const p = node.path;
  const step = obj(valueAt(data, p));
  const at = (...rest: Path) => [...p, ...rest];

  if (node.kind === "subtasks") {
    return (
      <Field label="Sub-tasks at once" help="Each sub-task runs its own tier's workflow in its own worktree (1–4).">
        <input
          type="number"
          min={1}
          max={4}
          value={text(data?.maxParallel)}
          onChange={(e) => onSet(["maxParallel"], num(e.target.value))}
        />
      </Field>
    );
  }
  if (node.kind === "integration") {
    return (
      <Checks
        label="Integration gates, on the merged task branch"
        options={GATE_KINDS}
        value={strings(obj(data?.integration).gates)}
        onChange={(v) => onSet(["integration", "gates"], v)}
      />
    );
  }

  const fix = obj(step.fix);
  const index = typeof p[1] === "number" ? p[1] : 0;
  const targets = fixTargets(data, index);
  const fixFields = (required: boolean) => (
    <fieldset className="workflow-fix">
      <legend className="field-label">Fix rounds</legend>
      {!required && (
        <label className="check">
          <input
            type="checkbox"
            checked={step.fix !== undefined}
            onChange={(e) =>
              onSet(
                at("fix"),
                e.target.checked ? { step: targets.at(-1) ?? "implement", maxRounds: 1, maxBudgetUsd: 0.5 } : undefined,
              )
            }
          />
          Send must-fix findings back to a write step
        </label>
      )}
      {step.fix !== undefined && (
        <>
          <Field label="Back to">
            <Select
              label="The write step that gets the failures"
              value={text(fix.step)}
              options={[...new Set([...targets, text(fix.step)])].filter(Boolean).map((t) => ({ value: t, label: t }))}
              onChange={(v) => onSet(at("fix", "step"), v)}
            />
          </Field>
          <div className="workflow-row">
            <Field label="Rounds (0–5)">
              <input
                type="number"
                min={0}
                max={5}
                value={text(fix.maxRounds)}
                onChange={(e) => onSet(at("fix", "maxRounds"), num(e.target.value))}
              />
            </Field>
            <Field label="Budget for the fixes ($)">
              <input
                type="number"
                min={0}
                step={0.1}
                value={text(fix.maxBudgetUsd)}
                onChange={(e) => onSet(at("fix", "maxBudgetUsd"), num(e.target.value))}
              />
            </Field>
          </div>
        </>
      )}
    </fieldset>
  );

  const idLabel = (
    <div className="workflow-row">
      <Field label="Id" help="Lowercase letters, digits and dashes; fix rounds name steps by it.">
        <input value={text(step.id)} onChange={(e) => onSet(at("id"), e.target.value)} spellCheck={false} />
      </Field>
      <Field label="Label">
        <input value={text(step.label)} onChange={(e) => onSet(at("label"), e.target.value)} />
      </Field>
    </div>
  );

  if (node.kind === "group") {
    return (
      <>
        {idLabel}
        <p className="muted">
          Its members run at the same time, read-only, and their answers merge into the plan. Select a member to edit
          it.
        </p>
      </>
    );
  }
  if (node.kind === "gates") {
    return (
      <>
        {idLabel}
        <Checks
          label="Gates, in order"
          options={GATE_KINDS}
          value={strings(step.gates)}
          onChange={(v) => onSet(at("gates"), v)}
        />
        {fixFields(true)}
      </>
    );
  }

  // An agent step: a tier's step, a parallel member or XL's split.
  const readOnly = node.kind === "member" || node.kind === "split";
  const limits = obj(step.limits);
  return (
    <>
      {idLabel}
      <Field label="Role">
        <Select
          label="Role"
          value={text(step.role)}
          options={WORKFLOW_ROLES.map((r) => ({ value: r, label: r }))}
          onChange={(v) => onSet(at("role"), v)}
        />
      </Field>
      <Field
        label="Access"
        help={
          readOnly
            ? "Parallel members and the split are read-only."
            : "Read: Read, Grep and Glob only. Write: the normal tools, with approvals."
        }
      >
        <Select
          label="Access"
          value={text(step.access)}
          disabled={readOnly}
          options={[
            { value: "read", label: "read" },
            { value: "write", label: "write" },
          ]}
          onChange={(v) => onSet(at("access"), v)}
        />
      </Field>
      <Checks
        label="Inputs"
        options={STEP_INPUTS}
        value={strings(step.inputs)}
        onChange={(v) => onSet(at("inputs"), v)}
      />
      {node.kind === "agent" && (
        <>
          <Field label="Output" help="plan: kept as plan.md for later steps. review: findings, read-only steps only.">
            <Select
              label="Output"
              value={text(step.output)}
              options={[
                { value: "", label: "none" },
                { value: "plan", label: "plan" },
                { value: "review", label: "review" },
              ]}
              onChange={(v) => onSet(at("output"), v || undefined)}
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={step.fresh === true}
              onChange={(e) => onSet(at("fresh"), e.target.checked || undefined)}
            />
            A fresh session that sees only its inputs
          </label>
        </>
      )}
      <div className="workflow-row">
        <Field label="Max turns">
          <input
            type="number"
            min={1}
            max={500}
            value={text(limits.maxTurns)}
            onChange={(e) => onSet(at("limits", "maxTurns"), num(e.target.value))}
          />
        </Field>
        <Field label="Budget ($)">
          <input
            type="number"
            min={0}
            step={0.1}
            value={text(limits.maxBudgetUsd)}
            onChange={(e) => onSet(at("limits", "maxBudgetUsd"), num(e.target.value))}
          />
        </Field>
      </div>
      {node.kind === "agent" && step.output === "review" && fixFields(false)}
    </>
  );
}
