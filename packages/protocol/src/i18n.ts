/**
 * The engine behind every catalog of text (X-13, ADR-0011): the UI's, the protocol's and the sidecar's. One language
 * per process. Each catalog registers itself when its module loads, so `setLanguage` switches them all.
 *
 * Messages follow the i18next JSON v4 conventions: flat keys, `{{name}}` for values, `_one` / `_other` suffixes for
 * plurals (chosen with `Intl.PluralRules`). A key a language lacks falls back to English.
 */

/** The languages the app speaks, each named in itself (Settings → Language). */
export const LANGUAGES = { en: "English", id: "Bahasa Indonesia" } as const;
export type Language = keyof typeof LANGUAGES;
export const asLanguage = (value: unknown): Language => (value === "id" ? "id" : "en");
const TAGS: Record<Language, string> = { en: "en-US", id: "id-ID" };

export type Params = Record<string, string | number>;
export type RichPart = { text: string; tag?: string };
type PluralBase<K> = K extends `${infer B}_one` | `${infer B}_other` ? B : never;
/** A key of a catalog whose English messages are `E`; a plural is named without its suffix. */
export type KeyOf<E> = (keyof E & string) | PluralBase<keyof E & string>;

type Messages = Record<string, string>;
type Loader = () => Messages | Promise<Messages>;
type Registered = { english: Messages; translations: Partial<Record<Language, Loader>>; messages: Messages };

const registered: Registered[] = [];
let language: Language = "en";
const ENGLISH_RULES = new Intl.PluralRules(TAGS.en);
let rules = ENGLISH_RULES;
let pseudo = false;

/**
 * Switches every catalog to `next`, before anything is shown in it: in the UI before the first render (a change in
 * Settings restarts the app), in the sidecar before it serves a request. When every catalog's translation is at hand
 * (the sidecar bundles its own), it applies at once; otherwise once the translations have loaded.
 */
export function setLanguage(next: Language): Promise<void> {
  const pending = registered.map((c) => c.translations[next]?.() ?? {});
  const apply = (loaded: Messages[]) => {
    registered.forEach((c, i) => {
      c.messages = { ...c.english, ...loaded[i] };
    });
    language = next;
    rules = next === "en" ? ENGLISH_RULES : new Intl.PluralRules(TAGS[next]);
    const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
    if (doc) doc.documentElement.lang = next;
  };
  if (pending.some((p) => p instanceof Promise)) return Promise.all(pending).then(apply);
  apply(pending as Messages[]);
  return Promise.resolve();
}

export const currentLanguage = () => language;

/** The language's BCP 47 tag, for `Intl` words such as weekday names: "en-US" or "id-ID". */
export const currentLocale = () => TAGS[language];

/**
 * Debug builds only (`AGENTCHAINER_PSEUDO_LOCALE=1`): every message renders accented and in ⟦brackets⟧, so text that
 * bypasses the catalogs stands out.
 */
export function setPseudo(on: boolean) {
  pseudo = on;
}

/**
 * A catalog over `english` (its keys type `t`), with `translations` loaded by `setLanguage`. Create it at module
 * level, before `setLanguage` runs, and never call `t` at module level: it must run after the language is set.
 */
export function catalog<E extends Messages>(english: E, translations: Partial<Record<Language, Loader>> = {}) {
  const entry: Registered = { english, translations, messages: english };
  registered.push(entry);
  type Key = KeyOf<E>;

  const template = (from: Messages, key: string, params?: Params, accented = pseudo, plurals = rules) => {
    let found: string | undefined;
    if (typeof params?.count === "number") {
      found = from[`${key}_${plurals.select(params.count)}`] ?? from[`${key}_other`];
    }
    found ??= from[key] ?? key;
    return accented ? accent(found) : found;
  };
  /** The English message; a value that is a translated message in turn goes in as its English. */
  const englishOf = (key: string, params?: Params) =>
    interpolate(
      template(english, key, params, false, ENGLISH_RULES),
      params &&
        Object.fromEntries(Object.entries(params).map(([n, v]) => [n, typeof v === "string" ? inEnglish(v) : v])),
    );

  return {
    /** The message for `key` in the current language, with `params` filled in. A `count` picks the plural form. */
    t(key: Key, params?: Params): string {
      const text = interpolate(template(entry.messages, key, params), params);
      const shown = pseudo ? `⟦${text}⟧` : text;
      if (language !== "en" || pseudo) remember(shown, englishOf(key, params));
      return shown;
    },
    /** The English message, whatever the language: for text that goes into files, commits and pull requests. */
    english(key: Key, params?: Params): string {
      return englishOf(key, params);
    },
    /**
     * A message with markup, e.g. "Press <kbd>{{keys}}</kbd> to search", split into plain text and tagged parts.
     * Tags come from the message, values are filled in afterwards: a value is never read as markup. Tags don't nest.
     */
    richParts(key: Key, params?: Params): RichPart[] {
      const text = template(entry.messages, key, params);
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
    },
  };
}

/**
 * Fills `{{name}}` with its value. A value that already ends a sentence swallows the full stop the message puts right
 * after it, so quoting "The run failed." in "…: {{why}}." doesn't end in "..".
 */
function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{\{(\w+)\}\}(\.)?/g, (whole, name: string, stop: string | undefined) => {
    if (!(name in params)) return whole;
    const value = String(params[name]);
    return stop && /[.!?…]$/.test(value) ? value : value + (stop ?? "");
  });
}

/**
 * The English of the messages this process showed in another language (X-15): an error raised in Indonesian that a
 * result quotes, say, has to read in English in a pull request. Recent ones only; nothing branches on them.
 */
const ENGLISH_OF = new Map<string, string>();
const REMEMBERED = 2000;

function remember(shown: string, english: string) {
  if (shown === english) return;
  ENGLISH_OF.delete(shown);
  ENGLISH_OF.set(shown, english);
  if (ENGLISH_OF.size > REMEMBERED) ENGLISH_OF.delete(ENGLISH_OF.keys().next().value as string);
}

/** A text this process showed, in English: a message from a catalog as its English, anything else as it is. */
export function inEnglish(text: string): string {
  return ENGLISH_OF.get(text) ?? text;
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

/**
 * What's wrong with a translation of `english` (for tests): keys it misses (a plural by its `_other` form) or adds,
 * empty values, and messages whose `{{values}}` or `<tags>` differ from English.
 */
export function translationProblems(english: Messages, translated: Messages) {
  const plural = /_(zero|one|two|few|many|other)$/;
  const values = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  const tags = (s: string) => [...s.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort();
  const wanted = (k: string) => (plural.test(k) ? k.replace(plural, "_other") : k);
  return {
    missing: [...new Set(Object.keys(english).map(wanted))].filter((k) => !(k in translated)),
    extra: Object.keys(translated).filter((k) => !(k in english)),
    empty: Object.keys(translated).filter((k) => !translated[k]?.trim()),
    differs: Object.keys(translated)
      .filter((k) => k in english)
      .filter((k) => {
        const [a, b] = [english[k] ?? "", translated[k] ?? ""];
        return values(a).join() !== values(b).join() || tags(a).join() !== tags(b).join();
      }),
  };
}
