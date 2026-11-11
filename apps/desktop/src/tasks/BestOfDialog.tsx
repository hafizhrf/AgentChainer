import type { AgentRoles, PermissionMode, StepAgent, Task } from "@agentchainer/protocol";
import { Layers, Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Modal } from "../Dialog.tsx";
import { approxUsd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { knownModels, modelChoices } from "../options.ts";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";
import type { AgentClis } from "./AgentPickers.tsx";
import { AGENT_NAMES, type VariantRow, variantAgents, variantRows } from "./bestOf.ts";

/** How many variants one Best-of-N runs (the sidecar checks the same). */
const MAX_VARIANTS = 3;

const usd = (n: number) => approxUsd(n, n < 0.1 ? 4 : 2);

/**
 * Best-of-N (CP-06): runs the approved task on 2–3 implementers at once, each in its own worktree with the task's
 * budget; plan and review stay the task's own. Each row is an implementer: an agent this computer has, and a model.
 */
export function BestOfDialog({
  open,
  task,
  cwd,
  clis,
  agents,
  model,
  runMode,
  onOpenChange,
  onStarted,
  onError,
}: {
  open: boolean;
  task: Task;
  cwd: string;
  clis: AgentClis | null;
  /** The plan and review picks, the same for every variant. */
  agents: AgentRoles;
  model: string;
  runMode: PermissionMode;
  onOpenChange: (open: boolean) => void;
  onStarted: (task: Task) => void;
  onError: (message: string) => void;
}) {
  const available = variantAgents(clis);
  const [rows, setRows] = useState<VariantRow[]>(() => variantRows(available, agents.implement));
  const [busy, setBusy] = useState(false);
  const budget = task.triage?.budgetUsd;
  const same = new Set(rows.map((r) => `${r.agent}|${r.model}`)).size < rows.length;
  const set = (i: number, row: VariantRow) => setRows((all) => all.map((r, j) => (j === i ? row : r)));

  async function start() {
    setBusy(true);
    try {
      const started = await request("task.runVariants", {
        cwd,
        id: task.id,
        permissionMode: runMode === "plan" ? "default" : runMode,
        ...(model ? { model } : {}),
        ...(Object.keys(agents).length ? { agents } : {}),
        variants: rows.map((r) => ({ agent: r.agent, ...(r.model ? { model: r.model } : {}) })),
      });
      onOpenChange(false);
      onStarted(started);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("tasks.bestOf.title")}
      description={t("tasks.bestOf.intro")}
      actions={
        <>
          <button type="button" className="secondary" onClick={() => onOpenChange(false)}>
            {t("tasks.bestOf.cancel")}
          </button>
          <button type="button" disabled={busy || same || budget == null} onClick={() => void start()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Layers size={14} />}
            {t("tasks.bestOf.start", { count: rows.length })}
          </button>
        </>
      }
    >
      <fieldset className="best-of-rows">
        <legend className="field-label best-of-legend">{t("tasks.bestOf.implementers")}</legend>
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions, edited in place.
          <div key={i} className="best-of-row">
            <span className="best-of-n">{t("tasks.bestOf.variantN", { n: i + 1 })}</span>
            <Select
              label={t("tasks.bestOf.agentOf", { n: i + 1 })}
              value={row.agent}
              options={available.map((a) => ({ value: a, label: AGENT_NAMES[a] }))}
              onChange={(v) => set(i, { agent: v as StepAgent, model: "" })}
            />
            <Select
              label={t("tasks.bestOf.modelOf", { n: i + 1 })}
              value={row.model}
              options={modelChoices(knownModels(row.agent), row.model, AGENT_NAMES[row.agent])}
              onChange={(v) => set(i, { ...row, model: v })}
            />
            <IconButton
              label={t("tasks.bestOf.remove", { n: i + 1 })}
              disabled={rows.length <= 2}
              onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
        {rows.length < MAX_VARIANTS && (
          <button
            type="button"
            className="ghost small"
            onClick={() => setRows((all) => [...all, { agent: available[0] ?? "claude", model: "" }])}
          >
            <Plus size={14} />
            {t("tasks.bestOf.add")}
          </button>
        )}
      </fieldset>
      {same && <p className="warn">{t("tasks.bestOf.same")}</p>}
      <ul className="task-fix-facts">
        <li>
          {budget == null
            ? t("tasks.bestOf.noBudget")
            : t("tasks.bestOf.budget", { each: usd(budget), total: usd(budget * rows.length), count: rows.length })}
        </li>
        <li>{t("tasks.bestOf.shared")}</li>
        <li>{t("tasks.bestOf.worktrees")}</li>
        <li>{t("tasks.bestOf.secrets")}</li>
        {task.triage?.chosen !== "S" && <li>{t("tasks.bestOf.plansOwn")}</li>}
      </ul>
    </Modal>
  );
}
