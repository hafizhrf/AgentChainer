import type { Finding, Methods, PlanAction } from "@agentchainer/protocol";
import { ArrowRight, CircleAlert, CircleCheck, CircleX, Info, type LucideIcon } from "lucide-react";
import { Section } from "../ui/Section.tsx";

type Scan = Methods["workspace.scan"]["result"];

export const STATUS_ICON: Record<Finding["status"], LucideIcon> = {
  ok: CircleCheck,
  info: Info,
  warn: CircleAlert,
  missing: CircleX,
};

const AREA: Record<Finding["area"], string> = {
  agent: "Agent setup",
  quality: "Project checks",
  hygiene: "Secrets hygiene",
  git: "Git",
};

/** Fixes worth doing: anything short of ok that names its fix. */
export const gapsOf = (findings: Finding[]) => findings.filter((f) => f.fix && f.status !== "ok");

/** The plan action that resolves a finding, if the plan has one. */
export function actionFor(finding: Finding, actions: PlanAction[] | undefined): PlanAction | undefined {
  const fix = finding.fix?.action;
  return fix ? actions?.find((a) => a.id === `fix:${fix}` || a.id === `gen:${fix}`) : undefined;
}

/**
 * The readiness report (M2-08/M2-09) as an inspection list: a summary, then findings grouped by area with their
 * severity. Each gap links to the plan action that fixes it.
 */
export function Overview({
  scan,
  actions,
  onFix,
}: {
  scan: Scan;
  actions: PlanAction[] | undefined;
  onFix: (actionId: string) => void;
}) {
  const { findings } = scan;
  const gaps = gapsOf(findings);
  const count = (s: Finding["status"]) => findings.filter((f) => f.status === s).length;
  return (
    <div className="setup-scroll">
      <div className="overview-summary">
        <div className={`summary-main${gaps.length ? " has-gaps" : ""}`}>
          {gaps.length ? <CircleAlert size={20} /> : <CircleCheck size={20} />}
          <div>
            <strong>
              {gaps.length === 0 ? "Ready for agent work" : `${gaps.length} thing${gaps.length > 1 ? "s" : ""} to fix`}
            </strong>
            <span className="muted">
              {gaps.length ? "Each one has a fix in the plan." : "Nothing in the readiness checks needs attention."}
            </span>
          </div>
        </div>
        <div className="summary-counts">
          {(["ok", "info", "warn", "missing"] as const).map((s) => {
            const Icon = STATUS_ICON[s];
            return (
              <span key={s} className={`finding-${s}`} title={`${count(s)} ${s}`}>
                <Icon size={14} />
                {count(s)}
              </span>
            );
          })}
        </div>
      </div>

      {(Object.keys(AREA) as Finding["area"][]).map((area) => {
        const items = findings.filter((f) => f.area === area);
        if (items.length === 0) return null;
        return (
          <Section
            key={area}
            id={`overview.${area}`}
            title={AREA[area]}
            count={items.filter((f) => f.status !== "ok").length}
          >
            <ul className="findings">
              {items.map((f) => {
                const Icon = STATUS_ICON[f.status];
                const action = f.status === "ok" ? undefined : actionFor(f, actions);
                return (
                  <li key={f.id} className={`finding finding-${f.status}`}>
                    <Icon size={16} className="finding-icon" />
                    <div className="finding-text">
                      <span>{f.title}</span>
                      <span className="muted">{f.detail}</span>
                    </div>
                    {action && (
                      <button type="button" className="ghost small" onClick={() => onFix(action.id)}>
                        {f.fix?.label ?? "Fix"}
                        <ArrowRight size={13} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        );
      })}
    </div>
  );
}
