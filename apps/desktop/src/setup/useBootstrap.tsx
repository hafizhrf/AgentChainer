import type { BootstrapPlan, BootstrapRun, Methods, PlanAction } from "@agentchainer/protocol";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { request } from "../sidecar.ts";

type ApplyResult = Methods["bootstrap.apply"]["result"]["results"][number];
type RollbackResult = Methods["bootstrap.rollback"]["result"]["results"][number];
export type Outcome = ApplyResult | RollbackResult;

/**
 * State and calls of the bootstrap plan (M2-12…M2-17), shared by the Plan and History views of the setup page: the
 * plan with its opt-in profiles and selection, apply after a confirmation, rollback whole or per action, and
 * generators that propose files from a read-only Claude session.
 */
export function useBootstrap(cwd: string, model: string, confirm: Confirm, onChanged: () => void) {
  const [plan, setPlan] = useState<BootstrapPlan | null>(null);
  const [optIn, setOptIn] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<BootstrapRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome[] | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);
  /** Actions whose install command the user allowed to run before verification (M2-23). */
  const [install, setInstall] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** Runs a generator: a read-only Claude session proposes files, which then show up in the plan for review. */
  async function generate(action: PlanAction): Promise<boolean> {
    setGenerating(action.id);
    setGenerated(null);
    setError(null);
    try {
      const r = await request("bootstrap.generate", { cwd, action: action.id, ...(model ? { model } : {}) });
      const failing = r.checks.filter((c) => c.status === "fail").length;
      setGenerated(
        `${action.title}: proposed ${r.files.join(", ")} in ${r.attempts} attempt${r.attempts > 1 ? "s" : ""} (≈$${r.costUsd.toFixed(4)})${
          failing ? `; ${failing} check(s) still fail` : ""
        }.`,
      );
      await load();
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setGenerating(null);
    }
  }

  async function run(action: () => Promise<Outcome[]>) {
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
            run back from History.
          </p>
        </>
      ),
      confirmLabel: "Apply",
    });
    if (!ok) return;
    const allowed = [...install].filter((id) => selected.has(id));
    await run(() =>
      request("bootstrap.apply", {
        cwd,
        actions: [...selected],
        profiles: optIn,
        ...(allowed.length ? { install: allowed } : {}),
      }).then((r) => r.results),
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

  const toggleInstall = (id: string) =>
    setInstall((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return {
    plan,
    runs,
    install,
    toggleInstall,
    optIn,
    setOptIn,
    selected,
    toggle,
    error,
    busy,
    outcome,
    clearOutcome: () => setOutcome(null),
    generating,
    generated,
    generate,
    apply,
    undo,
    load,
  };
}

export type Bootstrap = ReturnType<typeof useBootstrap>;
