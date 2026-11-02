import type { MetricsSummary, MetricsTask, TierWorkflow } from "@agentchainer/protocol";
import { BarChart3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { request } from "../sidecar.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pct = (r: number | null) => (r === null ? "—" : `${Math.round(r * 100)}%`);
const usd = (n: number | null) => (n === null ? "—" : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "", label: "All time" },
];
const TIERS: { value: "" | TierWorkflow["tier"]; label: string }[] = [
  { value: "", label: "All tiers" },
  { value: "S", label: "S" },
  { value: "M", label: "M" },
  { value: "L", label: "L" },
  { value: "XL", label: "XL" },
];

/** Which tasks a tile lists when it's selected. */
type Focus = "all" | "gates" | "success" | "retried" | "person";
const FOCUS: Record<Focus, { title: string; keep: (t: MetricsTask) => boolean }> = {
  all: { title: "All tasks in range", keep: () => true },
  gates: { title: "Tasks whose latest run didn't pass its gates", keep: (t) => t.gatesPassed === false },
  success: { title: "Successful tasks", keep: (t) => t.success },
  retried: { title: "Tasks with retries or fix rounds", keep: (t) => t.runs > 1 || t.fixRounds > 0 || t.ciFixes > 0 },
  person: { title: "Tasks that needed a person", keep: (t) => t.neededPerson },
};

function Tile({
  label,
  value,
  detail,
  focus,
  current,
  onFocus,
}: {
  label: string;
  value: string;
  detail: string;
  focus: Focus;
  current: Focus;
  onFocus: (f: Focus) => void;
}) {
  return (
    <button
      type="button"
      className={`metric-tile${current === focus ? " active" : ""}`}
      aria-pressed={current === focus}
      onClick={() => onFocus(current === focus ? "all" : focus)}
    >
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      <span className="metric-detail muted">{detail}</span>
    </button>
  );
}

/**
 * The workspace's task metrics (M7-01; docs/design/evals.md §4), computed on this computer from its task records.
 * Each tile lists the tasks behind it, so a number can be checked against them.
 */
export function Metrics({ cwd }: { cwd: string }) {
  const [range, setRange] = useState("30");
  const [tier, setTier] = useState<"" | TierWorkflow["tier"]>("");
  const [m, setM] = useState<MetricsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>("all");

  const load = useCallback(async () => {
    try {
      const since = range ? new Date(Date.now() - Number(range) * 86_400_000).toISOString() : undefined;
      setM(await request("metrics.summary", { cwd, ...(since ? { since } : {}), ...(tier ? { tier } : {}) }));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, [cwd, range, tier]);

  useEffect(() => {
    void load();
  }, [load]);

  const listed = useMemo(() => m?.taskList.filter(FOCUS[focus].keep) ?? [], [m, focus]);

  return (
    <div className="setup-scroll">
      <div className="metrics-filters">
        <p className="muted grow">How this workspace's tasks went, from their records on this computer.</p>
        <Select compact label="Time range" value={range} options={RANGES} onChange={setRange} />
        <Select compact label="Tier" value={tier} options={TIERS} onChange={(v) => setTier(v as typeof tier)} />
        <IconButton label="Refresh" onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {error && <p className="warn">{error}</p>}
      {!m && !error && <p className="muted">Adding up the tasks…</p>}
      {m && m.tasks === 0 && (
        <p className="empty-state">
          <BarChart3 size={14} /> No task has run in this range yet.
        </p>
      )}
      {m && m.tasks > 0 && (
        <>
          <div className="metric-tiles">
            <Tile
              label="Gate pass rate"
              value={pct(m.gatePass.rate)}
              detail={`${plural(m.gatePass.judged, "run", "runs")}${m.gatePass.unjudged ? `, ${m.gatePass.unjudged} ran no gate` : ""}`}
              focus="gates"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label="Cost per task"
              value={usd(m.costUsd.perTask)}
              detail={`${usd(m.costUsd.total)} over ${plural(m.tasks, "task", "tasks")}`}
              focus="all"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label="Cost per successful task"
              value={usd(m.costUsd.perSuccess)}
              detail={`${m.costUsd.successes} of ${m.tasks} succeeded; failures' cost counts`}
              focus="success"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label="Run time"
              value={m.durationMs ? duration(m.durationMs.p50) : "—"}
              detail={m.durationMs ? `median; 90% under ${duration(m.durationMs.p90)}` : "no finished run"}
              focus="all"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label="Retries"
              value={String(m.retries.extraRuns + m.retries.fixRounds + m.retries.ciFixes)}
              detail={`${plural(m.retries.extraRuns, "run", "runs")} again, ${plural(m.retries.fixRounds, "fix round", "fix rounds")}, ${m.retries.ciFixes} Fix CI`}
              focus="retried"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label="Needed a person"
              value={pct(m.humanFix.rate)}
              detail={`${plural(m.humanFix.tasks, "task", "tasks")}; hand edits after Done aren't measured`}
              focus="person"
              current={focus}
              onFocus={setFocus}
            />
          </div>

          <div className="metrics-tables">
            <table className="metrics-table">
              <caption>By tier</caption>
              <thead>
                <tr>
                  <th scope="col">Tier</th>
                  <th scope="col">Tasks</th>
                  <th scope="col">Succeeded</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {m.byTier.map((t) => (
                  <tr key={t.tier}>
                    <th scope="row">{t.tier}</th>
                    <td>{t.tasks}</td>
                    <td>{pct(t.tasks ? t.successes / t.tasks : null)}</td>
                    <td>{usd(t.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="metrics-table">
              <caption>By workflow</caption>
              <thead>
                <tr>
                  <th scope="col">Workflow</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Gates passed</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {m.byWorkflow.map((w) => (
                  <tr key={w.key}>
                    <th scope="row">
                      <code>{w.label}</code>
                    </th>
                    <td>{w.runs}</td>
                    <td>{pct(w.gatePassRate)}</td>
                    <td>{usd(w.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="card deploy-card">
            <div className="card-title">
              <h2>{FOCUS[focus].title}</h2>
              <span className="muted">{listed.length}</span>
            </div>
            <ul className="deploy-list metrics-tasks">
              {listed.map((t) => (
                <li key={t.id}>
                  <span className="chip">{t.tier ?? "—"}</span>
                  <span className="grow deploy-detail" title={t.request}>
                    {t.request}
                  </span>
                  <span className="muted">{t.state}</span>
                  <span className="muted">
                    {t.runs} {t.runs === 1 ? "run" : "runs"}
                  </span>
                  <span>{usd(t.costUsd)}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
