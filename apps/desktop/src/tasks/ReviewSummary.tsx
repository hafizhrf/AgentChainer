import type { AcceptanceCriterion, Review } from "@agentchainer/protocol";
import { CircleAlert, CircleCheck } from "lucide-react";
import { t } from "../i18n/index.ts";

const MET = {
  yes: { tone: "ok", word: () => t("tasks.review.metYes") },
  no: { tone: "err", word: () => t("tasks.review.metNo") },
  unclear: { tone: "warn", word: () => t("tasks.review.metUnclear") },
} as const;

const SEVERITY = {
  "must-fix": { tone: "err", word: () => t("tasks.review.mustFix") },
  "should-fix": { tone: "warn", word: () => t("tasks.review.shouldFix") },
  note: { tone: "none", word: () => t("tasks.review.note") },
} as const;

/**
 * A reviewer's verdict as the review step shows it (M9-05): the verdict, each acceptance criterion by its text with
 * met or not, and the findings. In place of the JSON the reviewer handed in, whichever agent it was.
 */
export function ReviewSummary({ review, criteria }: { review: Review; criteria: readonly AcceptanceCriterion[] }) {
  const approves = review.verdict === "approve";
  const textOf = (id: string) => criteria.find((c) => c.id === id)?.text ?? id;
  return (
    <section className="review-summary" aria-label={t("tasks.review.label")}>
      <p className={`review-verdict tone-${approves ? "ok" : "warn"}`}>
        {approves ? <CircleCheck size={16} aria-hidden /> : <CircleAlert size={16} aria-hidden />}
        {approves ? t("tasks.review.approves") : t("tasks.review.asksChanges")}
      </p>
      {review.criteria.length > 0 && (
        <>
          <h4 className="review-heading">{t("tasks.review.criteria")}</h4>
          <ul className="review-list">
            {review.criteria.map((c) => (
              <li key={c.id} className="review-item">
                <span className={`badge tone-${MET[c.met].tone}`}>{MET[c.met].word()}</span>
                <div>
                  <strong>{textOf(c.id)}</strong>
                  <p className="review-why muted">{c.why}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4 className="review-heading">{t("tasks.review.findings")}</h4>
      {review.findings.length ? (
        <ul className="review-list">
          {review.findings.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id, and the list never reorders.
            <li key={i} className="review-item">
              <span className={`badge tone-${SEVERITY[f.severity].tone}`}>{SEVERITY[f.severity].word()}</span>
              <div>
                {f.file && <code>{f.file}</code>}
                <p className="review-why">{f.text}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("tasks.review.noFindings")}</p>
      )}
    </section>
  );
}
