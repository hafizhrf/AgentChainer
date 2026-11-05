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
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { InlineDiff } from "../InlineDiff.tsx";
import { approxUsd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { lineDiff } from "../textdiff.ts";
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
  /** Generate with AI (UX-14): the person's description, and what came back, to keep or discard. */
  const [gen, setGen] = useState<{
    description: string;
    result: { yaml: string; summary: string; costUsd: number } | null;
  } | null>(null);

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

  function apply(change: (yaml: string) => string, select?: string | null) {
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
    // Written into the workflow's YAML, like the app's own workflows' labels: stays English (X-13).
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
    apply((yaml) => insertAt(yaml, ["steps"], index, step), keyOf(["steps", index]));
  }

  function move(delta: number) {
    const place = node && placeOf(node.path);
    if (!place) return;
    apply((yaml) => moveAt(yaml, place.list, place.index, delta), keyOf([...place.list, place.index + delta]));
  }

  async function remove() {
    const place = node && placeOf(node.path);
    if (!place || !node) return;
    const ok = await confirm({
      title: t("workflows.editor.removeTitle", { label: node.label }),
      body: t("workflows.editor.removeBody"),
      confirmLabel: t("workflows.editor.remove"),
      danger: true,
    });
    if (ok) apply((yaml) => removeAt(yaml, place.list, place.index), null);
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

  const generate = () =>
    act("generate", async () => {
      if (!gen || text === null || tier === "XL") return;
      const r = await request("workflow.generate", { cwd, tier, description: gen.description.trim(), current: text });
      if (!r.yaml) {
        throw new Error(
          t("workflows.editor.generateFailed", {
            error: r.error ?? t("workflows.editor.nothingCameBack"),
            cost: approxUsd(r.costUsd, 3),
          }),
        );
      }
      setGen({ ...gen, result: { yaml: r.yaml, summary: r.summary, costUsd: r.costUsd } });
    });

  const saveFile = () =>
    act("save", async () => {
      if (text === null) return;
      await request("workflow.save", { cwd, tier, yaml: text });
      setChanged(true);
      await load();
    });

  const reset = async () => {
    const ok = await confirm({
      title: t("workflows.editor.resetTitle", { tier }),
      body: t("workflows.editor.resetBody", { file: String(loaded?.file), tier }),
      confirmLabel: t("workflows.editor.reset"),
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
      const file = await open({
        multiple: false,
        filters: [{ name: t("workflows.editor.fileFilter"), extensions: ["yaml", "yml"] }],
      });
      if (typeof file !== "string") return;
      setText((await request("workflow.import", { path: file })).yaml);
      setSelected(null);
    });

  const exportFile = () =>
    act("export", async () => {
      if (text === null) return;
      const file = await save({
        defaultPath: `${tier.toLowerCase()}.yaml`,
        filters: [{ name: t("workflows.editor.fileFilter"), extensions: ["yaml"] }],
      });
      if (file) await request("workflow.export", { path: file, yaml: text });
    });

  async function close() {
    if (dirty) {
      const ok = await confirm({
        title: t("workflows.editor.leaveTitle"),
        body: t("workflows.editor.leaveBody"),
        confirmLabel: t("workflows.editor.leave"),
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
          {t("workflows.editor.back")}
        </button>
        <strong>{t("workflows.editor.title", { tier })}</strong>
        {loaded && (
          <span className={`chip${loaded.source === "project" ? " on" : ""}`}>
            {loaded.source === "project" ? loaded.file : t("workflows.editor.appsCopy")}
          </span>
        )}
        {dirty && <span className="muted">{t("workflows.editor.edited")}</span>}
        <span className="grow" />
        <fieldset className="segmented" aria-label={t("workflows.editor.view")}>
          <button type="button" aria-pressed={view === "canvas"} onClick={() => setView("canvas")}>
            <Network size={13} /> {t("workflows.editor.canvas")}
          </button>
          <button type="button" aria-pressed={view === "yaml"} onClick={() => setView("yaml")}>
            <Code size={13} /> {t("workflows.editor.yaml")}
          </button>
        </fieldset>
        {tier !== "XL" && (
          <button
            type="button"
            className="secondary small"
            disabled={busy !== null || text === null}
            onClick={() => setGen(gen ? null : { description: "", result: null })}
            aria-expanded={gen !== null}
          >
            <Sparkles size={13} />
            {t("workflows.editor.generateWithAi")}
          </button>
        )}
        <IconButton label={t("workflows.editor.import")} disabled={busy !== null} onClick={() => void importFile()}>
          <Upload size={15} />
        </IconButton>
        <IconButton
          label={t("workflows.editor.export")}
          disabled={busy !== null || text === null}
          onClick={() => void exportFile()}
        >
          <Download size={15} />
        </IconButton>
        {loaded?.source === "project" && (
          <button type="button" className="secondary small" disabled={busy !== null} onClick={() => void reset()}>
            <RotateCcw size={13} />
            {t("workflows.editor.resetToApps")}
          </button>
        )}
        <button type="button" className="small" disabled={!canSave || busy !== null} onClick={() => void saveFile()}>
          {busy === "save" ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
          {t("workflows.editor.save")}
        </button>
      </header>

      <div className={`workflow-status${problem ? " bad" : ""}`} role="status">
        {problem === undefined ? (
          <span className="muted">
            <Loader2 size={13} className="spin" /> {t("workflows.editor.checking")}
          </span>
        ) : problem === null ? (
          <span>
            <CircleCheck size={13} className="ok" /> {t("workflows.editor.valid", { tier })}
          </span>
        ) : (
          <pre>{parsed.yamlError ? t("workflows.editor.yamlError", { error: parsed.yamlError }) : problem}</pre>
        )}
      </div>
      {error && <p className="warn workflow-error">{error}</p>}
      {gen && (
        <section className="workflow-generate" aria-label={t("workflows.editor.generateWithAi")}>
          {!gen.result ? (
            <>
              <Field label={t("workflows.editor.describeLabel")} help={t("workflows.editor.describeHelp")}>
                <textarea
                  rows={3}
                  value={gen.description}
                  placeholder={t("workflows.editor.describePlaceholder")}
                  onChange={(e) => setGen({ ...gen, description: e.target.value })}
                />
              </Field>
              <div className="workflow-generate-actions">
                <span className="grow" />
                <button type="button" className="secondary small" onClick={() => setGen(null)}>
                  {t("workflows.editor.cancel")}
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={!gen.description.trim() || busy !== null}
                  onClick={() => void generate()}
                >
                  {busy === "generate" ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                  {busy === "generate" ? t("workflows.editor.generating") : t("workflows.editor.generate")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="flow-text">
                <strong>{t("workflows.editor.generatedFlow")}</strong> {gen.result.summary}{" "}
                <span className="muted">
                  {t("workflows.editor.generatedCost", { cost: approxUsd(gen.result.costUsd, 3) })}
                </span>
              </p>
              <div className="workflow-generate-diff">
                <InlineDiff diffs={[lineDiff(text ?? "", gen.result.yaml)]} />
              </div>
              <div className="workflow-generate-actions">
                <span className="grow" />
                <button type="button" className="secondary small" onClick={() => setGen(null)}>
                  {t("workflows.editor.discard")}
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={() => {
                    setText(gen.result?.yaml ?? text);
                    setSelected(null);
                    setGen(null);
                  }}
                >
                  {t("workflows.editor.keep")}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {text === null ? (
        <p className="muted setup-pad">{t("workflows.editor.loading")}</p>
      ) : view === "yaml" ? (
        <textarea
          className="workflow-yaml"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label={t("workflows.editor.yamlLabel", { tier })}
        />
      ) : (
        <div className="workflow-body">
          <WorkflowCanvas nodes={graph.nodes} edges={graph.edges} selected={selected} onSelect={setSelected} />
          <aside className="workflow-side" aria-label={t("workflows.editor.step")}>
            <Field label={t("workflows.editor.step")}>
              <Select
                label={t("workflows.editor.stepToEdit")}
                value={selected ?? ""}
                options={[
                  { value: "", label: t("workflows.editor.selectStep") },
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
                  <Plus size={13} /> {t("workflows.editor.addAgent")}
                </button>
                <button
                  type="button"
                  className="secondary small"
                  disabled={parsed.data === null}
                  onClick={() => add("gates")}
                >
                  <Plus size={13} /> {t("workflows.editor.addGates")}
                </button>
                <span className="grow" />
                <IconButton label={t("workflows.editor.moveUp")} disabled={!movable} onClick={() => move(-1)}>
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton label={t("workflows.editor.moveDown")} disabled={!movable} onClick={() => move(1)}>
                  <ArrowDown size={14} />
                </IconButton>
                <IconButton
                  label={t("workflows.editor.removeStep")}
                  disabled={!node || placeOf(node.path) === null}
                  onClick={() => void remove()}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            )}
            {node ? (
              <div className="workflow-form">
                <StepForm
                  node={node}
                  data={parsed.data}
                  onSet={(path, value) => apply((yaml) => setAt(yaml, path, value))}
                />
              </div>
            ) : (
              <p className="muted">
                {t("workflows.editor.selectHint")}{" "}
                {isXl ? t("workflows.editor.xlFixed") : t("workflows.editor.newStepsAfter")}
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
