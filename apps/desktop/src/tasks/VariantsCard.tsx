import type { Task, VariantSummary } from "@agentchainer/protocol";
import { Check, Layers, Loader2, Play, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Confirm } from "../Dialog.tsx";
import { approxUsd, seconds } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { localized } from "../i18n/shown.ts";
import { request, subscribe } from "../sidecar.ts";
import { variantLabel } from "./bestOf.ts";
import { stateLabel } from "./run.ts";

const usd = (n: number) => approxUsd(n, n < 0.1 ? 4 : 2);
/** States a variant can be kept from: its run ended (the sidecar checks the same). */
const KEEPABLE = new Set<Task["state"]>(["done", "accepted", "failed", "unverified", "cancelled"]);

function gatesText(v: VariantSummary): string {
  const { passed, failed } = v.gates;
  if (!passed.length && !failed.length) return t("tasks.variants.noGates");
  return failed.length
    ? t("tasks.variants.gatesFailed", { failed: failed.join(", "), passed: passed.length })
    : t("tasks.variants.gatesPassed", { count: passed.length });
}

function reviewText(v: VariantSummary): string {
  if (!v.review) return t("tasks.variants.noReview");
  return v.review.verdict === "approve"
    ? t("tasks.variants.approved")
    : t("tasks.variants.changesRequested", { count: v.review.mustFix });
}

/**
 * Best-of-N's comparison (CP-06): one column per variant, with its implementer, how it ended, its gates, the review's
 * verdict, what it changed, what it cost and how long it took. Each variant opens on its own page; one is kept, and
 * the task takes it.
 */
export function VariantsCard({
  task,
  cwd,
  confirm,
  onOpen,
  onChanged,
  onError,
}: {
  task: Task;
  cwd: string;
  confirm: Confirm;
  onOpen: (id: string) => void;
  onChanged: (task: Task) => void;
  onError: (message: string) => void;
}) {
  const [variants, setVariants] = useState<VariantSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    request("task.variants", { cwd, id: task.id }).then(
      (r) => setVariants(r.variants),
      (err: unknown) => onError(String(err)),
    );
  }, [cwd, task.id, onError]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the task changes.
  useEffect(load, [load, task.updatedAt]);

  // A variant's run reports on the variant: the comparison follows it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = subscribe((n) => {
      if (n.method !== "task.updated" || n.params.task.variantOf?.id !== task.id) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [load, task.id]);

  const running = variants?.some((v) => v.state === "running") ?? false;
  const interrupted = variants?.filter((v) => v.state === "interrupted") ?? [];

  async function act(kind: string, action: () => Promise<unknown>) {
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(null);
      load();
    }
  }

  async function keep(v: VariantSummary) {
    const ok = await confirm({
      title: t("tasks.variants.keepTitle", { n: v.index, agent: variantLabel(v) }),
      body: <p>{t("tasks.variants.keepBody")}</p>,
      confirmLabel: t("tasks.variants.keep"),
    });
    if (ok) {
      await act(`keep-${v.taskId}`, async () =>
        onChanged(await request("task.keepVariant", { cwd, id: task.id, variant: v.taskId })),
      );
    }
  }

  async function discard() {
    const ok = await confirm({
      title: t("tasks.variants.discardTitle"),
      body: <p>{t("tasks.variants.discardBody")}</p>,
      confirmLabel: t("tasks.variants.discard"),
      danger: true,
    });
    if (ok) {
      await act("discard", async () =>
        onChanged(await request("task.keepVariant", { cwd, id: task.id, variant: null })),
      );
    }
  }

  return (
    <section className="card variants-card" aria-labelledby={`variants-${task.id}`}>
      <div className="card-title">
        <Layers size={16} aria-hidden />
        <h2 id={`variants-${task.id}`}>{t("tasks.variants.title")}</h2>
        <span className="muted">{running ? t("tasks.variants.running") : t("tasks.variants.subtitle")}</span>
      </div>
      {!variants ? (
        <p className="muted">
          <Loader2 size={14} className="spin" /> {t("tasks.variants.loading")}
        </p>
      ) : (
        <div className="variants-scroll">
          <table className="metrics-table variants-table">
            <caption className="sr-only">{t("tasks.variants.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{t("tasks.variants.what")}</span>
                </th>
                {variants.map((v) => (
                  <th key={v.taskId} scope="col">
                    <span className="muted">{t("tasks.variants.variantN", { n: v.index })}</span>
                    <span className="variant-agent">{variantLabel(v)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t("tasks.variants.state")}</th>
                {variants.map((v) => {
                  const s = stateLabel(v.state);
                  return (
                    <td key={v.taskId}>
                      <span className={`badge tone-${s.tone}`}>{s.label}</span>
                      {v.outcome && <span className="variant-outcome muted">{localized(v.outcome, v.outcomeRef)}</span>}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <th scope="row">{t("tasks.variants.gates")}</th>
                {variants.map((v) => (
                  <td key={v.taskId}>{gatesText(v)}</td>
                ))}
              </tr>
              <tr>
                <th scope="row">{t("tasks.variants.review")}</th>
                {variants.map((v) => (
                  <td key={v.taskId}>{reviewText(v)}</td>
                ))}
              </tr>
              <tr>
                <th scope="row">{t("tasks.variants.changes")}</th>
                {variants.map((v) => (
                  <td key={v.taskId}>
                    {t("tasks.variants.changed", { count: v.files, added: v.added, removed: v.removed })}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">{t("tasks.variants.cost")}</th>
                {variants.map((v) => (
                  <td key={v.taskId} className="num">
                    {v.estimate ? t("tasks.variants.estimate", { cost: usd(v.costUsd) }) : usd(v.costUsd)}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">{t("tasks.variants.time")}</th>
                {variants.map((v) => (
                  <td key={v.taskId} className="num">
                    {v.durationMs === undefined ? "—" : seconds(Math.round(v.durationMs / 1000))}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">
                  <span className="sr-only">{t("tasks.variants.actions")}</span>
                </th>
                {variants.map((v) => (
                  <td key={v.taskId}>
                    <div className="variant-actions">
                      <button type="button" className="secondary small" onClick={() => onOpen(v.taskId)}>
                        {t("tasks.variants.open")}
                      </button>
                      <button
                        type="button"
                        className="small"
                        disabled={busy !== null || running || !KEEPABLE.has(v.state)}
                        onClick={() => void keep(v)}
                      >
                        {busy === `keep-${v.taskId}` ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                        {t("tasks.variants.keepThis")}
                      </button>
                    </div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="card-footer">
        <span className="muted">{running ? t("tasks.variants.keepAfter") : t("tasks.variants.pickOne")}</span>
        <span className="grow" />
        {running && (
          <button
            type="button"
            className="danger"
            disabled={busy !== null}
            onClick={() => void act("stop", () => request("task.cancel", { cwd, id: task.id }))}
          >
            <Square size={14} />
            {t("tasks.variants.stopAll")}
          </button>
        )}
        {!running && interrupted.length > 0 && (
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            onClick={() =>
              void act("resume", () =>
                Promise.all(interrupted.map((v) => request("task.resume", { cwd, id: v.taskId }))),
              )
            }
          >
            <Play size={14} />
            {t("tasks.variants.resumeAll")}
          </button>
        )}
        {!running && (
          <button type="button" className="secondary" disabled={busy !== null} onClick={() => void discard()}>
            <Trash2 size={14} />
            {t("tasks.variants.discardAll")}
          </button>
        )}
      </div>
    </section>
  );
}
