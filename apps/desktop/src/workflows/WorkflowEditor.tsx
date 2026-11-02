import type { TierWorkflow } from "@agentchainer/protocol";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CircleCheck,
  Code,
  Download,
  Loader2,
  Network,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";
import { StepForm } from "./StepForm.tsx";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";
import { freshId, insertAt, moveAt, type Path, readWorkflow, removeAt, setAt } from "./workflowDoc.ts";
import { keyOf, workflowGraph } from "./workflowGraph.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
type Tier = TierWorkflow["tier"];

/** The list a step sits in and its index there: a tier's steps, or a group's members. */
function placeOf(path: Path): { list: Path; index: number } | null {
  const index = path.at(-1);
  return typeof index === "number" ? { list: path.slice(0, -1), index } : null;
}

/**
 * The workflow canvas (M6-04, design §9): a tier's workflow as a graph with a form for the selected step, or as YAML.
 * Every edit changes the YAML in place, so comments survive; the sidecar checks it as you go, the same way a run
 * will. Save writes the project's `.agentchainer/workflows/<tier>.yaml`; Reset removes it, so the app's runs again.
 */
export function WorkflowEditor({
  cwd,
  tier,
  confirm,
  onClose,
}: {
  cwd: string;
  tier: Tier;
  confirm: Confirm;
  onClose: (changed: boolean) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ yaml: string; source: "app" | "project"; file: string } | null>(null);
  /** null: it can run; a string: why not; undefined: checking. */
  const [problem, setProblem] = useState<string | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"canvas" | "yaml">("canvas");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await request("workflow.get", { cwd, tier });
      setLoaded(r);
      setText(r.yaml);
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [cwd, tier]);

  useEffect(() => {
    void load();
  }, [load]);

  // The sidecar checks the text as a run would, a moment after the last edit.
  useEffect(() => {
    if (text === null) return;
    setProblem(undefined);
    let live = true;
    const timer = setTimeout(() => {
      request("workflow.check", { cwd, tier, yaml: text })
        .then((r) => live && setProblem(r.error))
        .catch((err) => live && setProblem(message(err)));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cwd, tier, text]);

  const parsed = useMemo(() => readWorkflow(text ?? ""), [text]);
  const graph = useMemo(() => workflowGraph(parsed.data), [parsed.data]);
  const node = graph.nodes.find((n) => n.id === selected) ?? null;
  const isXl = tier === "XL";
  const dirty = text !== null && loaded !== null && text !== loaded.yaml;
  // The app's workflow is saved as the project's even unchanged: that's how a project starts its own.
  const canSave = text !== null && problem === null && (dirty || loaded?.source === "app");

  function apply(change: (t: string) => string, select?: string | null) {
    if (text === null) return;
    try {
      setText(change(text));
      setError(null);
      if (select !== undefined) setSelected(select);
    } catch (err) {
      setError(message(err));
    }
  }

  function add(kind: "agent" | "gates") {
    const steps = Array.isArray(parsed.data?.steps) ? (parsed.data?.steps as Record<string, unknown>[]) : [];
    const place = node ? placeOf(node.path.slice(0, 2)) : null;
    const index = place ? place.index + 1 : steps.length;
    const writers = steps.slice(0, index).filter((s) => s.access === "write" && typeof s.id === "string");
    const step =
      kind === "agent"
        ? {
            id: freshId(parsed.data, "step"),
            label: "New step",
            role: "implementer",
            access: "write",
            inputs: ["contract"],
            limits: { maxTurns: 40, maxBudgetUsd: 1 },
          }
        : {
            id: freshId(parsed.data, "gates"),
            label: "Gates",
            gates: ["test"],
            fix: { step: (writers.at(-1)?.id as string | undefined) ?? "implement", maxRounds: 1, maxBudgetUsd: 0.5 },
          };
    apply((t) => insertAt(t, ["steps"], index, step), keyOf(["steps", index]));
  }

  function move(delta: number) {
    const place = node && placeOf(node.path);
    if (!place) return;
    apply((t) => moveAt(t, place.list, place.index, delta), keyOf([...place.list, place.index + delta]));
  }

  async function remove() {
    const place = node && placeOf(node.path);
    if (!place || !node) return;
    const ok = await confirm({
      title: `Remove ${node.label}?`,
      body: "The step goes from the YAML, with any comment above it. Steps whose fix rounds name it will need another.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) apply((t) => removeAt(t, place.list, place.index), null);
  }

  async function act(name: string, work: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const saveFile = () =>
    act("save", async () => {
      if (text === null) return;
      await request("workflow.save", { cwd, tier, yaml: text });
      setChanged(true);
      await load();
    });

  const reset = async () => {
    const ok = await confirm({
      title: `Use the app's ${tier} workflow again?`,
      body: `${loaded?.file} is removed from the workspace, and ${tier} tasks run the app's workflow. Runs under way keep the copy they started with.`,
      confirmLabel: "Reset",
      danger: true,
    });
    if (ok)
      await act("reset", async () => {
        await request("workflow.save", { cwd, tier, yaml: null });
        setChanged(true);
        setSelected(null);
        await load();
      });
  };

  const importFile = () =>
    act("import", async () => {
      const file = await open({ multiple: false, filters: [{ name: "Workflow", extensions: ["yaml", "yml"] }] });
      if (typeof file !== "string") return;
      setText((await request("workflow.import", { path: file })).yaml);
      setSelected(null);
    });

  const exportFile = () =>
    act("export", async () => {
      if (text === null) return;
      const file = await save({
        defaultPath: `${tier.toLowerCase()}.yaml`,
        filters: [{ name: "Workflow", extensions: ["yaml"] }],
      });
      if (file) await request("workflow.export", { path: file, yaml: text });
    });

  async function close() {
    if (dirty) {
      const ok = await confirm({
        title: "Leave without saving?",
        body: "The changes to this workflow are lost.",
        confirmLabel: "Leave",
        danger: true,
      });
      if (!ok) return;
    }
    onClose(changed);
  }

  const movable = node ? placeOf(node.path) !== null && node.kind !== "group" : false;
  return (
    <div className="workflow-editor">
      <header className="workflow-toolbar">
        <button type="button" className="ghost small" onClick={() => void close()}>
          <ArrowLeft size={14} />
          Workflows
        </button>
        <strong>{tier} workflow</strong>
        {loaded && (
          <span className={`chip${loaded.source === "project" ? " on" : ""}`}>
            {loaded.source === "project" ? loaded.file : "the app's (not saved in the project)"}
          </span>
        )}
        {dirty && <span className="muted">· edited</span>}
        <span className="grow" />
        <fieldset className="segmented" aria-label="View">
          <button type="button" aria-pressed={view === "canvas"} onClick={() => setView("canvas")}>
            <Network size={13} /> Canvas
          </button>
          <button type="button" aria-pressed={view === "yaml"} onClick={() => setView("yaml")}>
            <Code size={13} /> YAML
          </button>
        </fieldset>
        <IconButton label="Import a workflow file" disabled={busy !== null} onClick={() => void importFile()}>
          <Upload size={15} />
        </IconButton>
        <IconButton
          label="Export as a file"
          disabled={busy !== null || text === null}
          onClick={() => void exportFile()}
        >
          <Download size={15} />
        </IconButton>
        {loaded?.source === "project" && (
          <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void reset()}>
            <RotateCcw size={13} />
            Reset to the app's
          </button>
        )}
        <button type="button" className="small" disabled={!canSave || busy !== null} onClick={() => void saveFile()}>
          {busy === "save" ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
          Save
        </button>
      </header>

      <div className={`workflow-status${problem ? " bad" : ""}`} role="status">
        {problem === undefined ? (
          <span className="muted">
            <Loader2 size={13} className="spin" /> Checking…
          </span>
        ) : problem === null ? (
          <span>
            <CircleCheck size={13} className="ok" /> Valid: a {tier} run can use it as written.
          </span>
        ) : (
          <pre>{parsed.yamlError ? `YAML: ${parsed.yamlError}` : problem}</pre>
        )}
      </div>
      {error && <p className="warn workflow-error">{error}</p>}

      {text === null ? (
        <p className="muted setup-pad">Loading the workflow…</p>
      ) : view === "yaml" ? (
        <textarea
          className="workflow-yaml"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label={`${tier} workflow YAML`}
        />
      ) : (
        <div className="workflow-body">
          <WorkflowCanvas nodes={graph.nodes} edges={graph.edges} selected={selected} onSelect={setSelected} />
          <aside className="workflow-side" aria-label="Step">
            <Field label="Step">
              <Select
                label="Step to edit"
                value={selected ?? ""}
                options={[
                  { value: "", label: "Select a step…" },
                  ...graph.nodes.map((n) => ({
                    value: n.id,
                    label: n.kind === "member" ? `  ↳ ${n.label}` : n.label,
                  })),
                ]}
                onChange={(v) => setSelected(v || null)}
              />
            </Field>
            {!isXl && (
              <div className="workflow-actions">
                <button
                  type="button"
                  className="secondary small"
                  disabled={parsed.data === null}
                  onClick={() => add("agent")}
                >
                  <Plus size={13} /> Agent step
                </button>
                <button
                  type="button"
                  className="secondary small"
                  disabled={parsed.data === null}
                  onClick={() => add("gates")}
                >
                  <Plus size={13} /> Gates
                </button>
                <span className="grow" />
                <IconButton label="Move up" disabled={!movable} onClick={() => move(-1)}>
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton label="Move down" disabled={!movable} onClick={() => move(1)}>
                  <ArrowDown size={14} />
                </IconButton>
                <IconButton
                  label="Remove the step"
                  disabled={!node || placeOf(node.path) === null}
                  onClick={() => void remove()}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            )}
            {node ? (
              <div className="workflow-form">
                <StepForm node={node} data={parsed.data} onSet={(path, value) => apply((t) => setAt(t, path, value))} />
              </div>
            ) : (
              <p className="muted">
                Select a step on the canvas or in the list to edit it.{" "}
                {isXl
                  ? "XL's split, sub-tasks and integration gates are fixed in shape."
                  : "New steps go after the selected one."}
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
