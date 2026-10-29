import type { BootstrapPlan, BootstrapRun, Methods, PlanAction, PlanPreview } from "@agentchainer/protocol";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "./Dialog.tsx";
import { request } from "./sidecar.ts";
import { lineDiff } from "./textdiff.ts";

const STATE_LABEL: Record<PlanAction["state"], string> = {
  recommended: "recommended",
  optional: "optional",
  installed: "installed",
  unavailable: "unavailable",
};

type ApplyResult = Methods["bootstrap.apply"]["result"]["results"][number];
type RollbackResult = Methods["bootstrap.rollback"]["result"]["results"][number];

/**
 * Review and apply the bootstrap plan (M2-12…M2-17): each action with why, trust tier, license, risk, the permissions
 * and secrets it needs, and an exact preview. Selected actions apply after a confirmation; every run can be rolled
 * back, whole or per action, from the history below.
 */
export function BootstrapPlanView({
  cwd,
  model,
  confirm,
  onChanged,
}: {
  cwd: string;
  /** Model alias for generators ("" = the CLI's default). */
  model: string;
  confirm: Confirm;
  /** The workspace changed (applied or rolled back): the readiness report should rescan. */
  onChanged: () => void;
}) {
  const [plan, setPlan] = useState<BootstrapPlan | null>(null);
  const [optIn, setOptIn] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<BootstrapRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<(ApplyResult | RollbackResult)[] | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);

  /** Runs a generator: a read-only Claude session proposes files, which then show up in the plan for review. */
  async function generateProposal(action: PlanAction) {
    setGenerating(action.id);
    setGenerated(null);
    setError(null);
    try {
      const r = await request("bootstrap.generate", { cwd, action: action.id, ...(model ? { model } : {}) });
      const failing = r.checks.filter((c) => c.status === "fail").length;
      setGenerated(
        `${action.title}: proposed ${r.files.join(", ")} in ${r.attempts} attempt${r.attempts > 1 ? "s" : ""} (≈$${r.costUsd.toFixed(4)})${
          failing ? `; ${failing} check(s) still fail, see below` : ""
        }.`,
      );
      setOpen(action.id);
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(null);
    }
  }

  const load = useCallback(async () => {
    try {
      const [next, history] = await Promise.all([
        request("bootstrap.plan", { cwd, profiles: optIn }),
        request("bootstrap.runs", { cwd }),
      ]);
      setPlan(next);
      setRuns(history.runs);
      setSelected(new Set(next.actions.filter((a) => a.selected).map((a) => a.id)));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [cwd, optIn]);

  async function apply() {
    if (!plan) return;
    const chosen = plan.actions.filter((a) => selected.has(a.id));
    const ok = await confirm({
      title: `Apply ${chosen.length} action${chosen.length > 1 ? "s" : ""}?`,
      body: (
        <>
          <ul className="file-list">
            {chosen.map((a) => (
              <li key={a.id}>
                {a.title}{" "}
                <span className="muted">
                  ({a.tier ?? a.kind}, {a.scope} scope)
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            Files are backed up first and the run is recorded in <code>.agentchainer/lock.json</code>. You can roll the
            run back from the history below.
          </p>
        </>
      ),
      confirmLabel: "Apply",
    });
    if (!ok) return;
    await run(() =>
      request("bootstrap.apply", { cwd, actions: [...selected], profiles: optIn }).then((r) => r.results),
    );
  }

  async function undo(runId: string, actionId?: string, force = false) {
    const ok = await confirm({
      title: force ? "Force the rollback?" : actionId ? "Roll back this action?" : "Roll back the whole run?",
      body: force ? (
        <p>Files you edited after the run are overwritten with their contents from before it.</p>
      ) : (
        <p>
          Undoes what the {actionId ? "action" : "run"} installed and restores the files it changed, byte for byte.
          Files you edited since are left alone.
        </p>
      ),
      confirmLabel: force ? "Overwrite and roll back" : "Roll back",
      danger: force,
    });
    if (!ok) return;
    await run(() =>
      request("bootstrap.rollback", {
        cwd,
        runId,
        ...(actionId ? { actionId } : {}),
        ...(force ? { force } : {}),
      }).then((r) => r.results),
    );
  }

  async function run(action: () => Promise<(ApplyResult | RollbackResult)[]>) {
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await action());
      onChanged();
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

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
                      {a.generatable && (
                        <button
                          type="button"
                          className="link"
                          disabled={generating !== null || busy}
                          title="Claude reads the project (read-only) and proposes files; costs a model call"
                          onClick={() => void generateProposal(a)}
                        >
                          {generating === a.id ? "Generating…" : a.preview.type === "files" ? "Regenerate" : "Generate"}
                        </button>
                      )}
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
        <button type="button" disabled={selected.size === 0 || busy} onClick={() => void apply()}>
          {busy ? "Working…" : `Apply selected (${selected.size})`}
        </button>
        <button type="button" className="link" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {generated && <p className="muted">{generated}</p>}
      {outcome && (
        <ul className="plan-outcome">
          {outcome.map((r) => (
            <li key={r.id} className={`outcome ${r.status}`}>
              <strong>{r.status}</strong> {r.id}
              {r.message && <span className="muted"> — {r.message}</span>}
              {"warnings" in r &&
                r.warnings.map((w) => (
                  <div key={w} className="warn">
                    {w}
                  </div>
                ))}
              {"checks" in r && r.checks && <Checks checks={r.checks} />}
            </li>
          ))}
        </ul>
      )}

      {runs.length > 0 && (
        <>
          <h4>History</h4>
          <ul className="runs">
            {runs.map((r) => {
              const live = r.actions.filter((a) => a.status === "applied");
              const conflict = outcome?.some((o) => o.status === "conflict");
              return (
                <li key={r.runId}>
                  <div className="plan-head">
                    <span>{new Date(r.startedAt).toLocaleString()}</span>
                    <span className="muted">catalog {r.catalogVersion}</span>
                    {live.length > 0 && (
                      <button type="button" className="link" disabled={busy} onClick={() => void undo(r.runId)}>
                        Roll back run
                      </button>
                    )}
                    {live.length > 0 && conflict && (
                      <button
                        type="button"
                        className="link"
                        disabled={busy}
                        onClick={() => void undo(r.runId, undefined, true)}
                      >
                        Force
                      </button>
                    )}
                  </div>
                  <ul className="run-actions">
                    {r.actions.map((a) => (
                      <li key={a.id} className="plan-head">
                        <span className={`outcome ${a.status}`}>{a.status}</span> {a.title}
                        {a.status === "applied" && (
                          <button
                            type="button"
                            className="link"
                            disabled={busy}
                            onClick={() => void undo(r.runId, a.id)}
                          >
                            Roll back
                          </button>
                        )}
                        {a.error && <span className="muted"> — {a.error}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </>
      )}
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
      {a.notes && <p className={a.kind === "generator" ? "muted" : "warn"}>{a.notes}</p>}
      {a.checks && <Checks checks={a.checks} />}
      <Preview preview={a.preview} />
    </div>
  );
}

function Checks({ checks }: { checks: NonNullable<PlanAction["checks"]> }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.name} className={`check-${c.status}`}>
          {c.status === "pass" ? "✓" : c.status === "fail" ? "✕" : "–"} {c.name}
          <span className="muted"> {c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function FileDiff({ path, before, after }: { path: string; before: string; after: string }) {
  return (
    <>
      <code>
        {path}
        {before ? "" : " (new)"}
      </code>
      <pre className="plan-preview inline-diff">
        {lineDiff(before, after).map((l, i) => (
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

function Preview({ preview }: { preview: PlanPreview }) {
  if (preview.type === "note") return <p className="muted">{preview.text}</p>;
  if (preview.type === "files") {
    return (
      <>
        {preview.files.map((f) => (
          <FileDiff key={f.path} {...f} />
        ))}
      </>
    );
  }
  if (preview.type === "commands") {
    return (
      <pre className="plan-preview">
        {preview.commands
          .map((argv) => argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "))
          .join("\n")}
      </pre>
    );
  }
  return <FileDiff path={preview.path} before={preview.before} after={preview.after} />;
}
