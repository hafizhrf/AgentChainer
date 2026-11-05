# ADR-0011: UI text in JSON catalogs, read by a small in-house module

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** hafizhrf (owner), with Claude as implementer
- **Related:** X-13, [ADR-0008](0008-ui-components-and-styling.md)

## Context

X-13 asks for "i18n-ready strings: English first, Indonesian next". Every UI string was a literal in the code:
- about 1,700 strings across 75 component files, and about 180 more in `.ts` modules;
- the menu labels three times (`menu.rs`, `TitleBar.tsx`, the palette);
- about nine separate cost formatters and three plural helpers.

**Owner decisions (2026-11-05):**
- First round: the whole UI moves to catalogs, still in English.
- No Language setting until a second language exists, and English stays the default.

Text the sidecar produces (findings, plan reasons, run outcomes, errors), the protocol package's shared texts and the
catalog's YAML prose are a later round. They're stored in records and shared across processes.

## Decision

The UI's text lives in JSON catalogs, one file per area: `apps/desktop/src/i18n/locales/<language>/<area>.json`.
A module of about 150 lines in `apps/desktop/src/i18n/` reads them. There is no new dependency.

**The catalogs:**
- **Format:** the i18next JSON v4 conventions, so a translation platform, or i18next itself, could read the files
  without conversion.
  - Keys are flat, `<area>.<component>.<purpose>`, e.g. `setup.plugins.searchPlaceholder`. A key's prefix is its
    file's name.
  - `{{name}}` marks a value.
  - Plurals are keys ending `_one` / `_other`, chosen with `Intl.PluralRules`.
- **Areas:** `common` (units), `menu`, `app`, `session`, `panel`, `shell`, `home`, `graph`, `tasks`, `setup`,
  `workflows`.

**The module:**
- **API:**
  - `t(key, params?)`; a `count` param picks the plural.
  - `<Rich k tags>` renders a sentence with markup (`"Press <kbd>{{keys}}</kbd>"`) without splitting it into
    fragments.
  - `format.ts` holds money, counts, dates and durations. Words and units come from the catalogs. Dates and grouped
    numbers keep the system's regional format, as before.
- **Typing:** the key type is derived from the English JSON, so a wrong key fails `tsc`.
- **No React context:** `t` reads module state. A later language switch saves the setting and reloads the window.
  So `t` must never run at module top level: label maps that other files import are getters.

**The macOS menu:** Rust reads `menu.json` with `include_str!`, the same file the Windows and Linux title bar uses.
Predefined items get their text from it too.

**Guards:**
- Biome's `style/noJsxLiterals` covers text between tags in `apps/desktop/src/**/*.tsx`.
- `i18n/catalog.test.ts` checks:
  - the props a person reads (`label`, `title`, `aria-label`…) are never literal;
  - every key is used and lives in its area's file.
- A debug-only pseudo-locale (`AGENTCHAINER_PSEUDO_LOCALE=1`) renders every message accented and in ⟦brackets⟧. The
  E2E run checks that the app's chrome shows nothing else.

**Stays English, by design:**
- text sent to Claude as instructions (plan revisions, answer formats), as constants commented "sent to Claude";
- files written into the user's repository, and PR text;
- prose the sidecar or the Rust core returns, until their own round.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| i18next + react-i18next | The common choice; namespaces, lazy loading, context, many plugins | A larger runtime and a React provider for features the app doesn't use; typed keys need module augmentation | The catalogs keep its file format, so switching later is a code change, not a migration |
| react-intl (FormatJS) | ICU MessageFormat, rich formatting | Heavier; ICU syntax in every message; a provider around the tree | More than the app needs |
| Lingui | Small runtime, extraction tooling | A compile-time macro step in Vite and in the `node --test` runs | Adds a build step that the node tests don't have |
| Keep literals and translate later | No work now | Every later language means touching every file again | X-13 asks for the strings to be ready |

## Consequences

- **Positive:**
  - Adding a language means copying `locales/en/` and translating it, without touching components.
  - The macOS menu, the title bar and the palette can no longer drift apart.
  - Lint and tests catch new literal text.
- **Negative:**
  - Contributors add a key for every new string.
  - `t()` at module scope is a mistake the type checker doesn't catch; the pseudo-locale E2E does, on the screens it
    visits.
  - Text built when an event arrives (transcript notes) stays in the language it was built in.
- **Revisit when:**
  - a translation platform or community translators need features this format doesn't carry (context, gender);
  - the second language lands: decide then how the Language setting reloads, and whether dates follow the language
    or the system.

## References

- i18next JSON v4 format: https://www.i18next.com/misc/json-format
- `Intl.PluralRules`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules
- Biome `noJsxLiterals`: https://biomejs.dev/linter/rules/no-jsx-literals
