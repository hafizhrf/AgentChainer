import { type Cadence, cadenceText, type Schedule } from "@agentchainer/protocol";
import { useState } from "react";
import { Modal } from "../Dialog.tsx";
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

const HOURS = [1, 2, 3, 4, 6, 8, 12, 24].map((h) => ({
  value: String(h),
  label: h === 1 ? "Every hour" : `Every ${h} hours`,
}));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Monday first, as most calendars here show a week. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

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
      title={`${target.schedule ? "Edit schedule" : "Schedule"}: ${target.title}`}
      description="Runs this approved task again on a schedule, while AgentChainer is open."
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!cadence || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save schedule"}
          </button>
        </>
      }
    >
      <div className="schedule-form">
        <fieldset className="segmented">
          <legend className="sr-only">How often</legend>
          {(["hourly", "daily", "weekly"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === "hourly" ? "Every few hours" : k === "daily" ? "Daily" : "Weekly"}
            </button>
          ))}
        </fieldset>
        {kind === "hourly" ? (
          <Field label="How often" help="On the hour, counted from midnight.">
            <Select label="How often" value={String(every)} options={HOURS} onChange={(v) => setEvery(Number(v))} />
          </Field>
        ) : (
          <div className="schedule-row">
            {kind === "weekly" && (
              <fieldset className="schedule-days">
                <legend className="field-label">On</legend>
                {WEEK.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="chip"
                    aria-pressed={days.includes(d)}
                    onClick={() => setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]))}
                  >
                    {DAYS[d]}
                  </button>
                ))}
              </fieldset>
            )}
            <Field label="At" help="Your computer's time.">
              <input type="time" value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
          </div>
        )}
        {cadence ? (
          <p className="field-help">
            <strong>{cadenceText(cadence)}.</strong> Next: {preview.map((t) => whenText(t)).join(" · ")}
          </p>
        ) : (
          <p className="warn">
            {kind === "weekly" && !days.length ? "Pick at least one day." : "Enter a time like 02:30."}
          </p>
        )}
        <ul className="schedule-facts">
          <li>
            Each run: {target.budgetUsd === null ? "no budget cap" : `up to $${target.budgetUsd.toFixed(2)}`} (the
            task's)
            {target.model ? `, with ${target.model}` : ""}.
          </li>
          <li>Edits are accepted; any other approval waits for you, and you get a notification.</li>
          <li>Runs only while AgentChainer is open. A time missed while it was closed runs once when it opens.</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
        {error && <p className="warn">{error}</p>}
      </div>
    </Modal>
  );
}
