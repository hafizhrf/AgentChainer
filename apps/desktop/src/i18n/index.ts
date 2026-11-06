import {
  asLanguage,
  catalog,
  currentLocale,
  type KeyOf,
  LANGUAGES,
  type Language,
  type Params,
  type RichPart,
  setLanguage,
  setPseudo,
} from "@agentchainer/protocol";
import app from "./locales/en/app.json" with { type: "json" };
import common from "./locales/en/common.json" with { type: "json" };
import graph from "./locales/en/graph.json" with { type: "json" };
import home from "./locales/en/home.json" with { type: "json" };
import menu from "./locales/en/menu.json" with { type: "json" };
import native from "./locales/en/native.json" with { type: "json" };
import panel from "./locales/en/panel.json" with { type: "json" };
import session from "./locales/en/session.json" with { type: "json" };
import setup from "./locales/en/setup.json" with { type: "json" };
import shell from "./locales/en/shell.json" with { type: "json" };
import tasks from "./locales/en/tasks.json" with { type: "json" };
import workflows from "./locales/en/workflows.json" with { type: "json" };

/**
 * The UI's text (X-13, ADR-0011). Every string a person reads lives in `locales/<language>/<area>.json`, as flat keys
 * in the i18next JSON v4 conventions: `{{name}}` for values, `_one` / `_other` suffixes for plurals. English is built
 * in; Bahasa Indonesia loads in its own chunk. The engine, and the one language per process, are the protocol
 * package's, so switching here also switches the protocol's own text. Dates and numbers keep the system's regional
 * format (`format.ts`).
 */
export const CATALOGS = { common, menu, native, app, session, panel, shell, home, graph, tasks, setup, workflows };

const english = Object.assign({}, ...Object.values(CATALOGS)) as typeof common &
  typeof menu &
  typeof native &
  typeof app &
  typeof session &
  typeof panel &
  typeof shell &
  typeof home &
  typeof graph &
  typeof tasks &
  typeof setup &
  typeof workflows;

const ui = catalog(english, { id: async () => (await import("./locales/id/index.ts")).default });

/** A key in the English catalogs; a plural is named without its suffix. */
export type MessageKey = KeyOf<typeof english>;
export type { Language, Params, RichPart };
export { asLanguage, currentLocale, LANGUAGES, setPseudo };

/** The message for `key` with `params` filled in. A `count` picks the plural form. */
export const t = (key: MessageKey, params?: Params) => ui.t(key, params);

/**
 * A message with markup, e.g. "Press <kbd>{{keys}}</kbd> to search", split into plain text and tagged parts for
 * `<Rich>` to render.
 */
export const richParts = (key: MessageKey, params?: Params) => ui.richParts(key, params);

/** Switches the language, before the UI is drawn: a change in Settings restarts the app (ADR-0011). */
export const setLocale = (next: Language) => setLanguage(next);
