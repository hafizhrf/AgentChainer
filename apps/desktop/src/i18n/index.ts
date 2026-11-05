import app from "./locales/en/app.json" with { type: "json" };
import common from "./locales/en/common.json" with { type: "json" };
import graph from "./locales/en/graph.json" with { type: "json" };
import home from "./locales/en/home.json" with { type: "json" };
import menu from "./locales/en/menu.json" with { type: "json" };
import panel from "./locales/en/panel.json" with { type: "json" };
import session from "./locales/en/session.json" with { type: "json" };
import setup from "./locales/en/setup.json" with { type: "json" };
import shell from "./locales/en/shell.json" with { type: "json" };
import tasks from "./locales/en/tasks.json" with { type: "json" };
import workflows from "./locales/en/workflows.json" with { type: "json" };

/**
 * The UI's text (X-13, ADR-0011). Every string a person reads lives in `locales/<language>/<area>.json`, as flat keys
 * in the i18next JSON v4 conventions: `{{name}}` for values, `_one` / `_other` suffixes for plurals. English is the
 * only language so far. Dates and numbers keep the system's regional format (`format.ts`).
 */
export const CATALOGS = { common, menu, app, session, panel, shell, home, graph, tasks, setup, workflows };

type Catalog = typeof common &
  typeof menu &
  typeof app &
  typeof session &
  typeof panel &
  typeof shell &
  typeof home &
  typeof graph &
  typeof tasks &
  typeof setup &
  typeof workflows;
type RawKey = keyof Catalog & string;
type PluralBase<K> = K extends `${infer B}_one` | `${infer B}_other` ? B : never;
/** A key in the English catalogs; a plural is named without its suffix. */
export type MessageKey = RawKey | PluralBase<RawKey>;
export type Params = Record<string, string | number>;

const english: Record<string, string> = Object.assign({}, ...Object.values(CATALOGS));
let locale = "en";
let messages = english;
let rules = new Intl.PluralRules(locale);
let pseudo = false;

/** Switches the language. Only English exists; a second language registers its catalogs here. */
export function setLocale(next: string) {
  locale = next;
  messages = english;
  rules = new Intl.PluralRules(locale);
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
  if (doc) doc.documentElement.lang = locale;
}

/**
 * Debug builds only (`AGENTCHAINER_PSEUDO_LOCALE=1`): every message renders accented and in ⟦brackets⟧, so text that
 * bypasses the catalogs stands out, and a second locale is shown to load.
 */
export function setPseudo(on: boolean) {
  pseudo = on;
}

/** The message for `key` with `params` filled in. A `count` picks the plural form. */
export function t(key: MessageKey, params?: Params): string {
  const text = interpolate(template(key, params), params);
  return pseudo ? `⟦${text}⟧` : text;
}

function template(key: string, params?: Params): string {
  let found: string | undefined;
  if (typeof params?.count === "number") {
    found = messages[`${key}_${rules.select(params.count)}`] ?? messages[`${key}_other`];
  }
  found ??= messages[key] ?? key;
  return pseudo ? accent(found) : found;
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

export type RichPart = { text: string; tag?: string };

/**
 * A message with markup, e.g. "Press <kbd>{{keys}}</kbd> to search", split into plain text and tagged parts for
 * `<Rich>` to render. Tags don't nest.
 */
export function richParts(key: MessageKey, params?: Params): RichPart[] {
  // Tags come from the message, values are filled in afterwards: a value is never read as markup.
  const text = template(key, params);
  const fill = (part: string) => interpolate(part, params);
  const parts: RichPart[] = [];
  let at = 0;
  for (const m of text.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
    if (m.index > at) parts.push({ text: fill(text.slice(at, m.index)) });
    parts.push({ text: fill(m[2] ?? ""), tag: m[1] ?? "" });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: fill(text.slice(at)) });
  if (pseudo) {
    parts.unshift({ text: "⟦" });
    parts.push({ text: "⟧" });
  }
  return parts;
}

const ACCENTS: Record<string, string> = {
  a: "å",
  c: "ç",
  e: "é",
  g: "ĝ",
  i: "î",
  k: "ķ",
  n: "ñ",
  o: "ö",
  r: "ŕ",
  s: "š",
  t: "ţ",
  u: "ü",
  y: "ý",
  A: "Å",
  C: "Ç",
  E: "É",
  I: "Î",
  N: "Ñ",
  O: "Ö",
  S: "Š",
  U: "Ü",
};

/** Accents letters outside `{{values}}` and `<tags>`. */
function accent(text: string): string {
  return text.replace(/(\{\{\w+\}\}|<\/?\w+>)|[A-Za-z]/g, (m, kept: string | undefined) =>
    kept ? kept : (ACCENTS[m] ?? m),
  );
}
