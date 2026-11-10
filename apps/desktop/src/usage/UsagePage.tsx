import { USAGE_FAMILIES, type UsageFamily, type UsageReport } from "@agentchainer/protocol";
import { save } from "@tauri-apps/plugin-dialog";
import { BarChart3, Download, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { approxUsd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { modelName } from "../modelName.ts";
import { request } from "../sidecar.ts";
import { folderName } from "../tabs.ts";
import { Select } from "../ui/Select.tsx";
import { type DayBar, dailySeries, FAMILY_NAMES } from "./usage.ts";

/**
 * Usage (CP-01): what agents spent across sessions, by model, project and day. Claude sessions come from the SDK's
 * history and Codex/agy steps from the known workspaces' tasks; every cost is an estimate at API prices.
 */
export function UsagePage({ workspaces }: { workspaces: string[] }) {
  const [period, setPeriod] = useState("30");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sinceDays = period ? Number(period) : null;
  const key = workspaces.join("\n");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    request("usage.report", { sinceDays, workspaces: key ? key.split("\n") : [] }).then(
      (r) => {
        setReport(r);
        setLoading(false);
      },
      (err: unknown) => {
        setError(String(err instanceof Error ? err.message : err));
        setLoading(false);
      },
    );
  }, [sinceDays, key]);
  useEffect(load, [load]);

  const exportAs = async (format: "csv" | "json") => {
    setNotice(null);
    const path = await save({
      defaultPath: `agentchainer-usage.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    try {
      const { rows } = await request("usage.export", {
        sinceDays,
        workspaces: key ? key.split("\n") : [],
        path,
        format,
      });
      setNotice(t("graph.usage.exported", { count: rows, path }));
    } catch (err) {
      setNotice(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <div className="usage">
      <header className="usage-header">
        <BarChart3 size={18} aria-hidden />
        <h1>{t("graph.usage.title")}</h1>
        <span className="grow" />
        <Select
          compact
          label={t("graph.usage.period")}
          value={period}
          onChange={setPeriod}
          options={[
            { value: "7", label: t("graph.usage.last7") },
            { value: "30", label: t("graph.usage.last30") },
            { value: "90", label: t("graph.usage.last90") },
            { value: "", label: t("graph.usage.allTime") },
          ]}
        />
        <button type="button" className="secondary small" onClick={() => void exportAs("csv")} disabled={!report}>
          <Download size={13} aria-hidden />
          {t("graph.usage.exportCsv")}
        </button>
        <button type="button" className="secondary small" onClick={() => void exportAs("json")} disabled={!report}>
          <Download size={13} aria-hidden />
          {t("graph.usage.exportJson")}
        </button>
        <button
          type="button"
          className="ghost small"
          onClick={load}
          disabled={loading}
          aria-label={t("graph.usage.refresh")}
        >
          {loading ? <Loader2 size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
        </button>
      </header>
      <p className="muted usage-note">{t("graph.usage.note")}</p>
      {notice && (
        <p className="muted usage-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="usage-note error" role="alert">
          {t("graph.usage.failed", { error })}
        </p>
      )}
      {!report && loading && <p className="muted usage-note">{t("graph.usage.loading")}</p>}
      {report && report.totals.sessions === 0 && <p className="muted usage-note">{t("graph.usage.empty")}</p>}
      {report && report.totals.sessions > 0 && <UsageBody report={report} />}
    </div>
  );
}

const usd = (n: number) => approxUsd(n, n < 1 ? 3 : 2);
const count = (n: number) => n.toLocaleString("en-US");
/** "502M", "1.2K": token counts where space is short; the exact count is in the title. */
function short(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(n);
}

function UsageBody({ report }: { report: UsageReport }) {
  const totals = report.totals;
  const bars = useMemo(() => dailySeries(report), [report]);
  const present = USAGE_FAMILIES.filter((f) => report.byModel.some((m) => m.family === f));
  return (
    <>
      <section className="usage-tiles" aria-label={t("graph.usage.totals")}>
        <Tile label={t("graph.usage.cost")} value={usd(totals.costUsd)} hint={t("graph.usage.costHint")} />
        <Tile label={t("graph.usage.tokens")} value={short(totals.tokens)} hint={count(totals.tokens)} />
        <Tile label={t("graph.usage.sessions")} value={count(totals.sessions)} />
        {totals.unpricedTokens > 0 && (
          <Tile
            label={t("graph.usage.unpriced")}
            value={short(totals.unpricedTokens)}
            hint={t("graph.usage.unpricedHint", { tokens: count(totals.unpricedTokens) })}
          />
        )}
      </section>

      <section className="card usage-chart-card" aria-labelledby="usage-daily">
        <div className="card-title">
          <h2 id="usage-daily">{t("graph.usage.daily")}</h2>
        </div>
        <ul className="usage-legend" aria-label={t("graph.usage.legend")}>
          {present.map((f) => (
            <li key={f}>
              <span className={`usage-swatch series-${f}`} aria-hidden />
              {FAMILY_NAMES[f]}
            </li>
          ))}
        </ul>
        <DailyChart bars={bars} families={present} />
      </section>

      <section className="card" aria-labelledby="usage-models">
        <div className="card-title">
          <h2 id="usage-models">{t("graph.usage.byModel")}</h2>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>{t("graph.usage.model")}</th>
              <th className="num">{t("graph.usage.sessions")}</th>
              <th className="num">{t("graph.usage.tokens")}</th>
              <th className="num">{t("graph.usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {report.byModel.map((m) => (
              <tr key={m.model}>
                <td>
                  <span className={`usage-swatch series-${m.family}`} aria-hidden />
                  <span title={m.model}>{modelName(m.model)}</span>
                  <span className="muted"> · {FAMILY_NAMES[m.family]}</span>
                </td>
                <td className="num">{count(m.sessions)}</td>
                <td className="num" title={count(m.tokens)}>
                  {short(m.tokens)}
                </td>
                <td className="num">{m.unpricedTokens && !m.costUsd ? t("graph.usage.noPrice") : usd(m.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" aria-labelledby="usage-projects">
        <div className="card-title">
          <h2 id="usage-projects">{t("graph.usage.byProject")}</h2>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>{t("graph.usage.project")}</th>
              <th className="num">{t("graph.usage.sessions")}</th>
              <th className="num">{t("graph.usage.tokens")}</th>
              <th className="num">{t("graph.usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {report.byProject.slice(0, 15).map((p) => (
              <tr key={p.project}>
                <td title={p.project}>{p.project ? folderName(p.project) : t("graph.usage.unknownProject")}</td>
                <td className="num">{count(p.sessions)}</td>
                <td className="num" title={count(p.tokens)}>
                  {short(p.tokens)}
                </td>
                <td className="num">{usd(p.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.byProject.length > 15 && (
          <p className="muted usage-more">{t("graph.usage.moreProjects", { count: report.byProject.length - 15 })}</p>
        )}
      </section>

      <section className="card" aria-labelledby="usage-top">
        <div className="card-title">
          <h2 id="usage-top">{t("graph.usage.topSessions")}</h2>
        </div>
        <table className="usage-table">
          <thead>
            <tr>
              <th>{t("graph.usage.session")}</th>
              <th>{t("graph.usage.day")}</th>
              <th className="num">{t("graph.usage.tokens")}</th>
              <th className="num">{t("graph.usage.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {report.sessions.slice(0, 20).map((s) => (
              <tr key={s.id}>
                <td>
                  <span className="usage-title" title={s.title}>
                    {s.title}
                  </span>
                  <span className="muted usage-sub" title={s.project}>
                    {[s.project ? folderName(s.project) : null, ...s.models.map((m) => modelName(m))]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </td>
                <td>{s.day}</td>
                <td className="num" title={count(s.tokens)}>
                  {short(s.tokens)}
                </td>
                <td className="num">{usd(s.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card usage-tile" title={hint}>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const H = 200;
const PAD = { top: 8, right: 8, bottom: 22, left: 52 };

/** Estimated cost per day, stacked by family. Each bar answers on hover; the tables hold the numbers too. */
function DailyChart({ bars, families }: { bars: DayBar[]; families: readonly UsageFamily[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const max = Math.max(...bars.map((b) => b.total), 0);
  const top = niceMax(max);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / Math.max(bars.length, 1);
  const barW = Math.max(2, Math.min(28, slot * 0.7));
  const y = (v: number) => PAD.top + plotH - (top ? (v / top) * plotH : 0);
  const ticks = [0, top / 2, top];
  const labelEvery = Math.ceil(bars.length / 8);
  const shown = hover === null ? null : bars[hover];
  return (
    <div className="usage-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("graph.usage.chartLabel")}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line className="usage-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="usage-axis" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
              {`$${v < 1 && v > 0 ? v.toFixed(2) : Math.round(v)}`}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          let acc = 0;
          const clip = `usage-bar-${i}`;
          return (
            <g key={b.day}>
              {b.total > 0 && (
                <>
                  <clipPath id={clip}>
                    <rect x={x} y={y(b.total)} width={barW} height={y(0) - y(b.total) + 4} rx={Math.min(4, barW / 2)} />
                  </clipPath>
                  <g clipPath={`url(#${clip})`}>
                    {families.map((f) => {
                      const v = b.byFamily[f] ?? 0;
                      if (!v) return null;
                      const y0 = y(acc);
                      acc += v;
                      return (
                        <rect
                          key={f}
                          className={`usage-seg series-${f}`}
                          x={x}
                          y={y(acc)}
                          width={barW}
                          height={Math.max(0, y0 - y(acc))}
                        />
                      );
                    })}
                  </g>
                </>
              )}
              {(i % labelEvery === 0 || i === bars.length - 1) && (
                <text className="usage-axis" x={x + barW / 2} y={H - 6} textAnchor="middle">
                  {b.day.slice(5)}
                </text>
              )}
              {/* A hit area the whole slot wide and tall, bigger than the bar. Hover is a pointer convenience: each bar
                  has its <title>, and the tables below hold every number for the keyboard and screen readers. */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: see above; the tables are the accessible view */}
              <rect
                className="usage-hit"
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={plotH}
                onMouseEnter={() => setHover(i)}
              >
                <title>{`${b.day}: ${usd(b.total)}`}</title>
              </rect>
            </g>
          );
        })}
        <line className="usage-baseline" x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} />
      </svg>
      {shown && hover !== null && (
        <div
          className="usage-tooltip"
          style={{ left: `${((PAD.left + (hover + 0.5) * slot) / W) * 100}%` }}
          role="status"
        >
          <strong>{shown.day}</strong>
          <span>{usd(shown.total)}</span>
          {families
            .filter((f) => shown.byFamily[f])
            .map((f) => (
              <span key={f} className="usage-tooltip-row">
                <span className={`usage-swatch series-${f}`} aria-hidden />
                {FAMILY_NAMES[f]} <span className="grow" /> {usd(shown.byFamily[f] ?? 0)}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

/** A round top for the y axis: 1, 2 or 5 times a power of ten, at or above the largest bar. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
