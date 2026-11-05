import type { BootstrapPlan, BootstrapRun, Methods, PlanAction } from "@agentchainer/protocol";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { approxUsd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
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
      const params = {
        title: action.title,
        files: r.files.join(", "),
        attempts: t("setup.bootstrap.attempts", { count: r.attempts }),
        cost: approxUsd(r.costUsd, 4),
      };
      setGenerated(
        failing
          ? t("setup.bootstrap.generatedFailing", { ...params, failing })
          : t("setup.bootstrap.generated", params),
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
      title: t("setup.bootstrap.applyTitle", { count: chosen.length }),
      body: (
        <>
          <ul className="file-list">
            {chosen.map((a) => (
              <li key={a.id}>
                {a.title}{" "}
                <span className="muted">
                  {t("setup.bootstrap.actionMeta", { kind: a.tier ?? a.kind, scope: a.scope })}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">
            <Rich
              k="setup.bootstrap.applyBody"
              params={{ file: ".agentchainer/lock.json" }}
              tags={{ code: (s) => <code>{s}</code> }}
            />
          </p>
        </>
      ),
      confirmLabel: t("setup.bootstrap.apply"),
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
      title: force
        ? t("setup.bootstrap.forceTitle")
        : actionId
          ? t("setup.bootstrap.rollbackActionTitle")
          : t("setup.bootstrap.rollbackRunTitle"),
      body: force ? (
        <p>{t("setup.bootstrap.forceBody")}</p>
      ) : (
        <p>{actionId ? t("setup.bootstrap.rollbackActionBody") : t("setup.bootstrap.rollbackRunBody")}</p>
      ),
      confirmLabel: force ? t("setup.bootstrap.overwriteAndRollBack") : t("setup.bootstrap.rollBack"),
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
