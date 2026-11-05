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
 * in the i18next JSON v4 conventions: `{{name}}` for values, `_one` / `_other` suffixes for plurals. English is built
 * in; Bahasa Indonesia loads on demand. Dates and numbers keep the system's regional format (`format.ts`).
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

/** The languages the UI speaks, each named in itself (Settings → Language). */
export const LANGUAGES = { en: "English", id: "Bahasa Indonesia" } as const;
export type Language = keyof typeof LANGUAGES;
export const asLanguage = (value: unknown): Language => (value === "id" ? "id" : "en");
const TAGS: Record<Language, string> = { en: "en-US", id: "id-ID" };

const english: Record<string, string> = Object.assign({}, ...Object.values(CATALOGS));
let language: Language = "en";
let messages = english;
let rules = new Intl.PluralRules(TAGS.en);
let pseudo = false;

/**
 * Switches the language, before the UI is drawn: a change in Settings restarts the app (ADR-0011). English is built
 * in; another language loads its own chunk and covers English key by key.
 */
export async function setLocale(next: Language) {
  const extra = next === "id" ? (await import("./locales/id/index.ts")).default : {};
  language = next;
  messages = { ...english, ...extra };
  rules = new Intl.PluralRules(TAGS[next]);
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
  if (doc) doc.documentElement.lang = next;
}

/** The language's BCP 47 tag, for `Intl` words such as weekday names: "en-US" or "id-ID". */
export const currentLocale = () => TAGS[language];

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
