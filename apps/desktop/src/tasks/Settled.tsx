import type { Task } from "@agentchainer/protocol";
import { t } from "../i18n/index.ts";

/**
 * What the drafter asked before drafting and the person answered (UX-24), as the contract shows it: each question
 * with its answer. Under a card's heading while drafting, or as a field of the approved contract.
 */
export function Settled({ items, as }: { items: Task["clarifications"]; as: "heading" | "field" }) {
  if (!items?.length) return null;
  const list = (
    <dl className="settled-list">
      {items.map((c) => (
        <div key={`${c.at}-${c.question}`} className="settled-item">
          <dt className="muted">{c.question}</dt>
          <dd>{c.answer}</dd>
        </div>
      ))}
    </dl>
  );
  return as === "heading" ? (
    <div>
      <h3 className="contract-heading">{t("tasks.contract.settled")}</h3>
      {list}
    </div>
  ) : (
    <div className="task-field">
      <span className="field-label">{t("tasks.contract.settled")}</span>
      {list}
    </div>
  );
}
