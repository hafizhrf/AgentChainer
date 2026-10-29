import type { BootstrapPlan, PlanAction, PlanPreview } from "@agentchainer/protocol";
import { useCallback, useEffect, useState } from "react";
import { request } from "./sidecar.ts";
import { lineDiff } from "./textdiff.ts";

const STATE_LABEL: Record<PlanAction["state"], string> = {
  recommended: "recommended",
  optional: "optional",
  installed: "installed",
  unavailable: "unavailable",
};

/**
 * Review of the bootstrap plan (M2-12): each action with why, trust tier, license, risk, the permissions and secrets
 * it needs, and an exact preview. Toggle actions, opt into extra profiles. Applying arrives with the installers
 * (M2-13…M2-17); until then nothing here changes the workspace.
 */
export function BootstrapPlanView({ cwd }: { cwd: string }) {
  const [plan, setPlan] = useState<BootstrapPlan | null>(null);
  const [optIn, setOptIn] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await request("bootstrap.plan", { cwd, profiles: optIn });
      setPlan(next);
      setSelected(new Set(next.actions.filter((a) => a.selected).map((a) => a.id)));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd, optIn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="warn">{error}</p>;
  if (!plan) return <p className="muted">Building the plan…</p>;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const groups: [PlanAction["kind"], string][] = [
    ["fix", "Fixes"],
    ["catalog", `Catalog (${plan.catalogVersion})`],
    ["generator", "Generated with Claude"],
  ];
  const optional = plan.profiles.filter((p) => !p.suggested);

  return (
    <div className="bootstrap-plan">
      <h3>Bootstrap plan</h3>
      <p className="muted">
        Profiles:{" "}
        {plan.profiles
          .filter((p) => p.suggested)
          .map((p) => p.name)
          .join(", ") || "none"}
        .{optional.length > 0 && " Add:"}
      </p>
      {optional.length > 0 && (
        <div className="opt-in">
          {optional.map((p) => (
            <label key={p.id} className="check" title={p.description}>
              <input
                type="checkbox"
                checked={optIn.includes(p.id)}
                onChange={(e) => setOptIn((o) => (e.target.checked ? [...o, p.id] : o.filter((x) => x !== p.id)))}
              />
              {p.name}
            </label>
          ))}
        </div>
      )}

      {groups.map(([kind, label]) => {
        const actions = plan.actions.filter((a) => a.kind === kind);
        if (actions.length === 0) return null;
        return (
          <div key={kind}>
            <h4>{label}</h4>
            <ul className="plan-actions">
              {actions.map((a) => {
                const selectable = a.state === "recommended" || a.state === "optional";
                return (
                  <li key={a.id} className={`plan-action ${a.state}`}>
                    <div className="plan-head">
                      <input
                        type="checkbox"
                        aria-label={`Include ${a.title}`}
                        checked={selected.has(a.id)}
                        disabled={!selectable}
                        onChange={() => toggle(a.id)}
                      />
                      <button type="button" className="link" onClick={() => setOpen(open === a.id ? null : a.id)}>
                        {a.title}
                      </button>
                      {a.tier && <span className={`badge tier-${a.tier}`}>{a.tier}</span>}
                      <span className={`badge risk-${a.risk}`}>{a.risk} risk</span>
                      {a.state !== "recommended" && <span className="muted">{STATE_LABEL[a.state]}</span>}
                    </div>
                    {a.reason && <div className="muted plan-reason">{a.reason}</div>}
                    {open === a.id && <ActionDetails action={a} />}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}

      <div className="row">
        <button type="button" disabled title="Applying arrives with the installers (M2-13…M2-17)">
          Apply selected ({selected.size})
        </button>
        <button type="button" className="link" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="muted">Applying comes with the installers; nothing here changes the workspace yet.</p>
    </div>
  );
}

function ActionDetails({ action: a }: { action: PlanAction }) {
  return (
    <div className="plan-details">
      <p>{a.why}</p>
      <dl>
        {a.source && (
          <>
            <dt>Source</dt>
            <dd>
              <code>{a.source}</code>
            </dd>
          </>
        )}
        {a.license && (
          <>
            <dt>License</dt>
            <dd>{a.license}</dd>
          </>
        )}
        <dt>Scope</dt>
        <dd>{a.scope}</dd>
        {a.permissions.length > 0 && (
          <>
            <dt>What it can do</dt>
            <dd>
              <ul>
                {a.permissions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {a.secrets.length > 0 && (
          <>
            <dt>Needs from you</dt>
            <dd>
              {a.secrets.map((s) => (
                <code key={s}>{s}</code>
              ))}{" "}
              in your environment. AgentChainer never stores it.
            </dd>
          </>
        )}
      </dl>
      {a.notes && <p className="warn">{a.notes}</p>}
      <Preview preview={a.preview} />
    </div>
  );
}

function Preview({ preview }: { preview: PlanPreview }) {
  if (preview.type === "note") return <p className="muted">{preview.text}</p>;
  if (preview.type === "commands") {
    return (
      <pre className="plan-preview">
        {preview.commands
          .map((argv) => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "))
          .join("\n")}
      </pre>
    );
  }
  return (
    <>
      <code>{preview.path}</code>
      <pre className="plan-preview inline-diff">
        {lineDiff(preview.before, preview.after).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff.
          <span key={i} className={l.op === "+" ? "add" : l.op === "-" ? "del" : ""}>
            {l.op} {l.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </>
  );
}
