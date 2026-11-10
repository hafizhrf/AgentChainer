import type { AgentRoles, MethodResult, StepAgent } from "@agentchainer/protocol";
import { t } from "../i18n/index.ts";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";

/** What `agents.available` says about Codex and the Antigravity CLI (M9-06). */
export type AgentClis = MethodResult<"agents.available">;

export type AgentRole = keyof AgentRoles;
export const ALL_ROLES: AgentRole[] = ["plan", "implement", "review"];

/** Whether there's more than Claude to choose from on this computer. */
export const otherAgents = (clis: AgentClis | null) => !!clis && (clis.codex.installed || clis.agy.installed);

/**
 * Which agent runs each kind of step (M9-06, ADR-0012 §5): any role on any agent installed and signed in on this
 * computer. A task's triage card and the workspace's defaults both use it; shown only when there's more than Claude.
 */
export function AgentPickers({
  roles,
  agents,
  onAgents,
  clis,
  help,
  titled = true,
}: {
  roles: AgentRole[];
  agents: AgentRoles;
  onAgents: (a: AgentRoles) => void;
  clis: AgentClis;
  help: string;
  /** Its own "Agents" heading; off inside a card that has a title of its own. */
  titled?: boolean;
}) {
  if (!roles.length || !otherAgents(clis)) return null;
  const option = (agent: "codex" | "agy") => {
    const cli = clis[agent];
    const name = agent === "codex" ? t("tasks.agents.codex") : t("tasks.agents.agy");
    return cli.installed
      ? [
          {
            value: agent,
            label: cli.signedIn ? name : t("tasks.agents.notSignedIn", { agent: name }),
            disabled: !cli.signedIn,
          },
        ]
      : [];
  };
  const options = [{ value: "claude", label: t("tasks.agents.claude") }, ...option("codex"), ...option("agy")];
  const roleLabel = (role: AgentRole) =>
    role === "plan"
      ? t("tasks.agents.plan")
      : role === "implement"
        ? t("tasks.agents.implement")
        : t("tasks.agents.review");
  return (
    <fieldset className="task-agents">
      <legend className={titled ? "field-label" : "sr-only"}>{t("tasks.agents.title")}</legend>
      <div className="task-agents-row">
        {roles.map((role) => (
          <Field key={role} label={roleLabel(role)}>
            <Select
              label={roleLabel(role)}
              value={agents[role] ?? "claude"}
              options={options}
              onChange={(v) => onAgents({ ...agents, [role]: v as StepAgent })}
            />
          </Field>
        ))}
      </div>
      <span className="field-help">{help}</span>
    </fieldset>
  );
}
