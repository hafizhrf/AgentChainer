import type { StepAgent, TaskDefaults, Tier } from "@agentchainer/protocol";
import { t } from "../i18n/index.ts";
import { MODE_NAMES, modelChoices } from "../options.ts";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";
import { type AgentClis, type AgentRole, ALL_ROLES } from "./AgentPickers.tsx";
import { DEFAULT_BUDGET_USD } from "./taskForm.ts";

const TIERS: Tier[] = ["S", "M", "L", "XL"];
const MODES = ["default", "acceptEdits", "auto"] as const;
/** The select value for "not set here": the level below decides. */
const INHERIT = "";

const agentName = (a: StepAgent) =>
  a === "codex" ? t("tasks.agents.codex") : a === "agy" ? t("tasks.agents.agy") : t("tasks.agents.claude");
const roleLabel = (role: AgentRole) =>
  role === "plan"
    ? t("tasks.agents.plan")
    : role === "implement"
      ? t("tasks.agents.implement")
      : t("tasks.agents.review");

/**
 * How tasks run unless they choose otherwise (owner request, 2026-11-10): the agent per role, the model, the
 * permission profile and the budget per tier. The same fields edit the app's defaults (Settings) and a workspace's
 * (`fallback` set): there, each field's first option follows the app, naming what that comes to.
 */
export function TaskDefaultsFields({
  value,
  onChange,
  clis,
  fallback,
}: {
  value: TaskDefaults;
  onChange: (next: TaskDefaults) => void;
  clis: AgentClis | null;
  /** The app's defaults, when these are a workspace's. */
  fallback?: TaskDefaults;
}) {
  const inheritLabel = (shown: string) =>
    fallback ? t("tasks.defaults.appDefault", { value: shown }) : t("tasks.defaults.builtIn", { value: shown });
  const agentOptions = (role: AgentRole) => {
    const below = fallback?.agents?.[role] ?? "claude";
    const offered: StepAgent[] = ["claude", ...(["codex", "agy"] as const).filter((a) => clis?.[a].installed)];
    const current = value.agents?.[role];
    if (current && !offered.includes(current)) offered.push(current);
    return [
      { value: INHERIT, label: inheritLabel(agentName(below)) },
      ...offered.map((a) => ({
        value: a,
        label:
          a !== "claude" && clis && !clis[a].signedIn
            ? t("tasks.agents.notSignedIn", { agent: agentName(a) })
            : agentName(a),
      })),
    ];
  };
  const setAgent = (role: AgentRole, v: string) => {
    const agents = { ...value.agents };
    if (v === INHERIT) delete agents[role];
    else agents[role] = v as StepAgent;
    const { agents: _drop, ...rest } = value;
    onChange(Object.keys(agents).length ? { ...rest, agents } : rest);
  };
  const setField = <K extends "model" | "permissionMode">(key: K, v: string) => {
    const { [key]: _drop, ...rest } = value;
    onChange(v === INHERIT ? rest : { ...rest, [key]: v });
  };
  const setBudget = (tier: Tier, raw: string) => {
    const budgetUsd = { ...value.budgetUsd };
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0) delete budgetUsd[tier];
    else budgetUsd[tier] = n;
    const { budgetUsd: _drop, ...rest } = value;
    onChange(Object.keys(budgetUsd).length ? { ...rest, budgetUsd } : rest);
  };
  const models = modelChoices(undefined, value.model ?? "").filter((o) => o.value !== "");
  const belowModel = fallback?.model ?? null;
  const belowMode = fallback?.permissionMode ?? null;
  const budgetBelow = (tier: Tier) => {
    const b = fallback?.budgetUsd?.[tier];
    return b === undefined ? DEFAULT_BUDGET_USD[tier] : b;
  };

  return (
    <div className="task-defaults">
      {clis && (clis.codex.installed || clis.agy.installed) && (
        <fieldset className="task-agents">
          <legend className="field-label task-defaults-legend">{t("tasks.agents.title")}</legend>
          <div className="task-agents-row">
            {ALL_ROLES.map((role) => (
              <Field key={role} label={roleLabel(role)}>
                <Select
                  label={roleLabel(role)}
                  value={value.agents?.[role] ?? INHERIT}
                  options={agentOptions(role)}
                  onChange={(v) => setAgent(role, v)}
                />
              </Field>
            ))}
          </div>
        </fieldset>
      )}
      <div className="task-agents-row">
        <Field label={t("tasks.defaults.model")} help={t("tasks.defaults.modelHelp")}>
          <Select
            label={t("tasks.defaults.model")}
            value={value.model ?? INHERIT}
            options={[{ value: INHERIT, label: inheritLabel(belowModel ?? t("tasks.defaults.chatModel")) }, ...models]}
            onChange={(v) => setField("model", v)}
          />
        </Field>
        <Field label={t("tasks.defaults.mode")} help={t("tasks.defaults.modeHelp")}>
          <Select
            label={t("tasks.defaults.mode")}
            value={value.permissionMode ?? INHERIT}
            options={[
              {
                value: INHERIT,
                label: inheritLabel(belowMode ? MODE_NAMES[belowMode] : t("tasks.defaults.chatMode")),
              },
              ...MODES.map((m) => ({ value: m, label: MODE_NAMES[m] })),
            ]}
            onChange={(v) => setField("permissionMode", v)}
          />
        </Field>
      </div>
      <fieldset className="task-agents">
        <legend className="field-label task-defaults-legend">{t("tasks.defaults.budgets")}</legend>
        <div className="task-defaults-budgets">
          {TIERS.map((tier) => {
            const below = budgetBelow(tier);
            const own = value.budgetUsd?.[tier];
            return (
              <Field key={tier} label={tier}>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  inputMode="decimal"
                  aria-label={t("tasks.defaults.budgetFor", { tier })}
                  value={own === undefined || own === null ? "" : String(own)}
                  placeholder={below === null ? t("tasks.defaults.noBudget") : `$${below}`}
                  onChange={(e) => setBudget(tier, e.target.value)}
                />
              </Field>
            );
          })}
        </div>
        <span className="field-help">
          {fallback ? t("tasks.defaults.budgetsHelpWorkspace") : t("tasks.defaults.budgetsHelpApp")}
        </span>
      </fieldset>
    </div>
  );
}
