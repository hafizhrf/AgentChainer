import type { MetricsSummary, MetricsTask, TierWorkflow } from "@agentchainer/protocol";
import { BarChart3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { compactDuration, percent, usd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { request } from "../sidecar.ts";
import { stateLabel } from "../tasks/run.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pct = (r: number | null) => (r === null ? "—" : percent(r));
const money = (n: number | null) => (n === null ? "—" : usd(n, n < 1 ? 3 : 2));
const duration = (ms: number) => compactDuration(Math.round(ms / 1000));

const ranges = () => [
  { value: "7", label: t("setup.metrics.last7Days") },
  { value: "30", label: t("setup.metrics.last30Days") },
  { value: "", label: t("setup.metrics.allTime") },
];
const tiers = (): { value: "" | TierWorkflow["tier"]; label: string }[] => [
  { value: "", label: t("setup.metrics.allTiers") },
  { value: "S", label: "S" },
  { value: "M", label: "M" },
  { value: "L", label: "L" },
  { value: "XL", label: "XL" },
];

/** Which tasks a tile lists when it's selected. */
type Focus = "all" | "gates" | "success" | "retried" | "person";
const FOCUS: Record<Focus, { title: string; keep: (task: MetricsTask) => boolean }> = {
  all: {
    get title() {
      return t("setup.metrics.focusAll");
    },
    keep: () => true,
  },
  gates: {
    get title() {
      return t("setup.metrics.focusGates");
    },
    keep: (task) => task.gatesPassed === false,
  },
  success: {
    get title() {
      return t("setup.metrics.focusSuccess");
    },
    keep: (task) => task.success,
  },
  retried: {
    get title() {
      return t("setup.metrics.focusRetried");
    },
    keep: (task) => task.runs > 1 || task.fixRounds > 0 || task.ciFixes > 0,
  },
  person: {
    get title() {
      return t("setup.metrics.focusPerson");
    },
    keep: (task) => task.neededPerson,
  },
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
        <p className="muted grow">{t("setup.metrics.intro")}</p>
        <Select compact label={t("setup.metrics.timeRange")} value={range} options={ranges()} onChange={setRange} />
        <Select
          compact
          label={t("setup.metrics.tier")}
          value={tier}
          options={tiers()}
          onChange={(v) => setTier(v as typeof tier)}
        />
        <IconButton label={t("setup.metrics.refresh")} onClick={() => void load()}>
          <RefreshCw size={14} />
        </IconButton>
      </div>
      {error && <p className="warn">{error}</p>}
      {!m && !error && <p className="muted">{t("setup.metrics.adding")}</p>}
      {m && m.tasks === 0 && (
        <p className="empty-state">
          <BarChart3 size={14} /> {t("setup.metrics.noTasks")}
        </p>
      )}
      {m && m.tasks > 0 && (
        <>
          <div className="metric-tiles">
            <Tile
              label={t("setup.metrics.gatePassRate")}
              value={pct(m.gatePass.rate)}
              detail={
                m.gatePass.unjudged
                  ? t("setup.metrics.gateDetailUnjudged", {
                      runs: t("setup.metrics.runs", { count: m.gatePass.judged }),
                      unjudged: m.gatePass.unjudged,
                    })
                  : t("setup.metrics.runs", { count: m.gatePass.judged })
              }
              focus="gates"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label={t("setup.metrics.costPerTask")}
              value={money(m.costUsd.perTask)}
              detail={t("setup.metrics.costDetail", {
                total: money(m.costUsd.total),
                tasks: t("setup.metrics.tasks", { count: m.tasks }),
              })}
              focus="all"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label={t("setup.metrics.costPerSuccess")}
              value={money(m.costUsd.perSuccess)}
              detail={t("setup.metrics.successDetail", { successes: m.costUsd.successes, tasks: m.tasks })}
              focus="success"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label={t("setup.metrics.runTime")}
              value={m.durationMs ? duration(m.durationMs.p50) : "—"}
              detail={
                m.durationMs
                  ? t("setup.metrics.runTimeDetail", { p90: duration(m.durationMs.p90) })
                  : t("setup.metrics.noFinishedRun")
              }
              focus="all"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label={t("setup.metrics.retries")}
              value={String(m.retries.extraRuns + m.retries.fixRounds + m.retries.ciFixes)}
              detail={t("setup.metrics.retriesDetail", {
                runs: t("setup.metrics.runs", { count: m.retries.extraRuns }),
                fixRounds: t("setup.metrics.fixRounds", { count: m.retries.fixRounds }),
                ciFixes: m.retries.ciFixes,
              })}
              focus="retried"
              current={focus}
              onFocus={setFocus}
            />
            <Tile
              label={t("setup.metrics.neededPerson")}
              value={pct(m.humanFix.rate)}
              detail={t("setup.metrics.personDetail", { tasks: t("setup.metrics.tasks", { count: m.humanFix.tasks }) })}
              focus="person"
              current={focus}
              onFocus={setFocus}
            />
          </div>

          <div className="metrics-tables">
            <table className="metrics-table">
              <caption>{t("setup.metrics.byTier")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("setup.metrics.tier")}</th>
                  <th scope="col">{t("setup.metrics.colTasks")}</th>
                  <th scope="col">{t("setup.metrics.colSucceeded")}</th>
                  <th scope="col">{t("setup.metrics.colCost")}</th>
                </tr>
              </thead>
              <tbody>
                {m.byTier.map((row) => (
                  <tr key={row.tier}>
                    <th scope="row">{row.tier}</th>
                    <td>{row.tasks}</td>
                    <td>{pct(row.tasks ? row.successes / row.tasks : null)}</td>
                    <td>{money(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="metrics-table">
              <caption>{t("setup.metrics.byWorkflow")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("setup.metrics.colWorkflow")}</th>
                  <th scope="col">{t("setup.metrics.colRuns")}</th>
                  <th scope="col">{t("setup.metrics.colGatesPassed")}</th>
                  <th scope="col">{t("setup.metrics.colCost")}</th>
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
                    <td>{money(w.costUsd)}</td>
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
              {listed.map((task) => (
                <li key={task.id}>
                  <span className="chip">{task.tier ?? "—"}</span>
                  <span className="grow deploy-detail" title={task.request}>
                    {task.request}
                  </span>
                  <span className="muted">{stateLabel(task.state).label}</span>
                  <span className="muted">{t("setup.metrics.runs", { count: task.runs })}</span>
                  <span>{money(task.costUsd)}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
