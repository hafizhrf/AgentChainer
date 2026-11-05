import { type Cadence, cadenceText, type Schedule } from "@agentchainer/protocol";
import { useState } from "react";
import { Modal } from "../Dialog.tsx";
import { usd } from "../i18n/format.ts";
import { t } from "../i18n/index.ts";
import { Rich } from "../i18n/Rich.tsx";
import { askToNotify, nextTimes, whenText } from "../schedules.ts";
import { request } from "../sidecar.ts";
import { Field } from "../ui/Field.tsx";
import { Select } from "../ui/Select.tsx";

/** What the dialog schedules: an approved task, or an existing schedule to edit. */
export type ScheduleTarget = {
  cwd: string;
  taskId: string;
  title: string;
  /** The task's budget cap per run; null for no cap. */
  budgetUsd: number | null;
  /** The model its last run used, which a scheduled run keeps. */
  model?: string;
  schedule?: Schedule;
};

const hourOptions = () =>
  [1, 2, 3, 4, 6, 8, 12, 24].map((h) => ({
    value: String(h),
    label: t("tasks.schedule.everyHour", { count: h }),
  }));

/** A day's short name, Sunday as 0 as `Date.getDay` counts. */
function dayName(day: number): string {
  switch (day) {
    case 0:
      return t("tasks.schedule.sun");
    case 1:
      return t("tasks.schedule.mon");
    case 2:
      return t("tasks.schedule.tue");
    case 3:
      return t("tasks.schedule.wed");
    case 4:
      return t("tasks.schedule.thu");
    case 5:
      return t("tasks.schedule.fri");
    default:
      return t("tasks.schedule.sat");
  }
}
/** Monday first, as most calendars here show a week. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** A run's spend cap: "up to $2.00", or none. */
const budgetCap = (budgetUsd: number | null) =>
  budgetUsd === null ? t("tasks.schedule.noBudgetCap") : t("tasks.schedule.upTo", { amount: usd(budgetUsd) });

/**
 * Scheduling a task (M8-05): a preset cadence, the next runs, and what a run may do on its own. Saving asks the OS
 * for notifications the first time, so a scheduled run that needs the person can say so.
 */
export function ScheduleDialog({
  target,
  onClose,
  onSaved,
}: {
  target: ScheduleTarget;
  onClose: () => void;
  onSaved: (schedule: Schedule) => void;
}) {
  const old = target.schedule?.cadence;
  const [kind, setKind] = useState<Cadence["kind"]>(old?.kind ?? "daily");
  const [every, setEvery] = useState(old?.kind === "hourly" ? old.every : 6);
  const [at, setAt] = useState(old && old.kind !== "hourly" ? old.at : "02:00");
  const [days, setDays] = useState<number[]>(old?.kind === "weekly" ? old.days : [1]);
  const [enabled, setEnabled] = useState(target.schedule?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cadence: Cadence | null =
    kind === "hourly"
      ? { kind, every }
      : !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)
        ? null
        : kind === "daily"
          ? { kind, at }
          : days.length
            ? { kind, days, at }
            : null;
  const preview = cadence ? nextTimes(cadence, 3) : [];

  async function save() {
    if (!cadence) return;
    setSaving(true);
    try {
      const { schedule } = await request("schedule.save", {
        cwd: target.cwd,
        taskId: target.taskId,
        cadence,
        enabled,
        ...(target.schedule ? { id: target.schedule.id } : {}),
      });
      await askToNotify();
      onSaved(schedule);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={
        target.schedule
          ? t("tasks.schedule.editTitle", { title: target.title })
          : t("tasks.schedule.newTitle", { title: target.title })
      }
      description={t("tasks.schedule.description")}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            {t("tasks.schedule.cancel")}
          </button>
          <button type="button" disabled={!cadence || saving} onClick={() => void save()}>
            {saving ? t("tasks.schedule.saving") : t("tasks.schedule.save")}
          </button>
        </>
      }
    >
      <div className="schedule-form">
        <fieldset className="segmented">
          <legend className="sr-only">{t("tasks.schedule.howOften")}</legend>
          {(["hourly", "daily", "weekly"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "hourly"
                ? t("tasks.schedule.hourly")
                : k === "daily"
                  ? t("tasks.schedule.daily")
                  : t("tasks.schedule.weekly")}
            </button>
          ))}
        </fieldset>
        {kind === "hourly" ? (
          <Field label={t("tasks.schedule.howOften")} help={t("tasks.schedule.hourlyHelp")}>
            <Select
              label={t("tasks.schedule.howOften")}
              value={String(every)}
              options={hourOptions()}
              onChange={(v) => setEvery(Number(v))}
            />
          </Field>
        ) : (
          <div className="schedule-row">
            {kind === "weekly" && (
              <fieldset className="schedule-days">
                <legend className="field-label">{t("tasks.schedule.on")}</legend>
                {WEEK.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="chip"
                    aria-pressed={days.includes(d)}
                    onClick={() => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]))}
                  >
                    {dayName(d)}
                  </button>
                ))}
              </fieldset>
            )}
            <Field label={t("tasks.schedule.at")} help={t("tasks.schedule.atHelp")}>
              <input type="time" value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
          </div>
        )}
        {cadence ? (
          <p className="field-help">
            <Rich
              k="tasks.schedule.next"
              params={{ cadence: cadenceText(cadence), times: preview.map((when) => whenText(when)).join(" · ") }}
              tags={{ strong: (s) => <strong>{s}</strong> }}
            />
          </p>
        ) : (
          <p className="warn">
            {kind === "weekly" && !days.length ? t("tasks.schedule.pickDay") : t("tasks.schedule.enterTime")}
          </p>
        )}
        <ul className="schedule-facts">
          <li>
            {target.model
              ? t("tasks.schedule.eachRunModel", { budget: budgetCap(target.budgetUsd), model: target.model })
              : t("tasks.schedule.eachRun", { budget: budgetCap(target.budgetUsd) })}
          </li>
          <li>{t("tasks.schedule.edits")}</li>
          <li>{t("tasks.schedule.onlyOpen")}</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{t("tasks.schedule.enabled")}</span>
        </label>
        {error && <p className="warn">{error}</p>}
      </div>
    </Modal>
  );
}
