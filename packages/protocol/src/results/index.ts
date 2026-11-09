import { catalog, type KeyOf, type Params } from "../i18n.ts";
import type { MessageRef } from "../index.ts";
import evidence from "./en/evidence.json" with { type: "json" };
import lessons from "./en/lessons.json" with { type: "json" };
import run from "./en/run.json" with { type: "json" };
import triage from "./en/triage.json" with { type: "json" };
import xl from "./en/xl.json" with { type: "json" };
import evidenceId from "./id/evidence.json" with { type: "json" };
import lessonsId from "./id/lessons.json" with { type: "json" };
import runId from "./id/run.json" with { type: "json" };
import triageId from "./id/triage.json" with { type: "json" };
import xlId from "./id/xl.json" with { type: "json" };

/**
 * Task results (X-13 part 2b): the outcomes, step labels and notes, triage details, lesson sources and evidence
 * report lines the sidecar writes. They're stored as English text plus a `MessageRef`, so the app shows them in its
 * language while pull requests, `evidence.md` and Claude get English. Shared by the UI and the sidecar, so both render
 * the same templates. Both languages are bundled.
 */
export const RESULTS = { run, xl, triage, lessons, evidence };
export const RESULTS_INDONESIAN = { run: runId, xl: xlId, triage: triageId, lessons: lessonsId, evidence: evidenceId };

const english = Object.assign({}, ...Object.values(RESULTS)) as typeof run &
  typeof xl &
  typeof triage &
  typeof lessons &
  typeof evidence;
const results = catalog(english, { id: () => Object.assign({}, ...Object.values(RESULTS_INDONESIAN)) });

export type ResultKey = KeyOf<typeof english>;
type ResultParams = Record<string, string | number | MessageRef>;

/** A result's ref, with its key checked against the catalog. */
export const resultRef = (key: ResultKey, params?: ResultParams): MessageRef => (params ? { key, params } : { key });

/** Values for a template: a value that is a text in turn is rendered the same way first. */
function resolve(params: MessageRef["params"], render: (ref: MessageRef) => string): Params | undefined {
  if (!params) return undefined;
  return Object.fromEntries(
    Object.entries(params).map(([name, value]) => [name, typeof value === "object" ? render(value) : value]),
  );
}

/** A result in the app's language. */
export function resultText(ref: MessageRef): string {
  return results.t(ref.key as ResultKey, resolve(ref.params, resultText));
}

/** A result in English, whatever the app's language: for records, pull requests, evidence and Claude. */
export function resultEnglish(ref: MessageRef): string {
  return results.english(ref.key as ResultKey, resolve(ref.params, resultEnglish));
}
