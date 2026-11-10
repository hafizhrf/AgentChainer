import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { commandRisk } from "./approval.ts";
import { catalog, currentLocale, inEnglish, setLanguage, translationProblems } from "./i18n.ts";
import { cadenceText, RESULTS, RESULTS_INDONESIAN } from "./index.ts";
import en from "./locales/en.json" with { type: "json" };
import id from "./locales/id.json" with { type: "json" };

afterEach(() => setLanguage("en"));

test("the protocol's Indonesian has every English key, with the same values and tags", () => {
  assert.deepEqual(translationProblems(en, id), { missing: [], extra: [], empty: [], differs: [] });
});

test("one setLanguage switches every catalog, and a key the language lacks falls back to English", async () => {
  const demo = catalog(
    { "demo.files_one": "{{count}} file", "demo.files_other": "{{count}} files", "demo.only": "Only English" },
    { id: () => ({ "demo.files_other": "{{count}} file" }) },
  );
  await setLanguage("id");
  assert.equal(currentLocale(), "id-ID");
  assert.equal(demo.t("demo.files", { count: 1 }), "1 file");
  assert.equal(demo.t("demo.only"), "Only English");
  assert.equal(commandRisk("git push").reasons[0], "Menerbitkan commit ke remote");
  assert.equal(cadenceText({ kind: "weekly", days: [1, 3], at: "09:30" }), "Sen, Rab pukul 09:30");
  // English stays English, with English plurals, for files, commits and pull requests.
  assert.equal(demo.english("demo.files", { count: 1 }), "1 file");
  assert.equal(demo.english("demo.files", { count: 2 }), "2 files");
  await setLanguage("en");
  assert.equal(commandRisk("git push").reasons[0], "Publishes commits to a remote");
  assert.equal(cadenceText({ kind: "weekly", days: [1, 3], at: "09:30" }), "Mon, Wed at 09:30");
});

test("a translation that drops a value or a tag, misses a key, or adds one is caught", () => {
  const english = { "a.x": "Run <code>{{cmd}}</code>", "a.n_one": "{{count}} item", "a.n_other": "{{count}} items" };
  assert.deepEqual(translationProblems(english, { "a.x": "Jalankan {{cmd}}", "a.y": "?" }), {
    missing: ["a.n_other"],
    extra: ["a.y"],
    empty: [],
    differs: ["a.x"],
  });
});

test("the results catalog's Indonesian has every English key, and every key lives in its area's file", () => {
  const english: Record<string, string> = Object.assign({}, ...Object.values(RESULTS));
  const indonesian: Record<string, string> = Object.assign({}, ...Object.values(RESULTS_INDONESIAN));
  assert.deepEqual(translationProblems(english, indonesian), { missing: [], extra: [], empty: [], differs: [] });
  for (const [name, areas] of Object.entries({ en: RESULTS, id: RESULTS_INDONESIAN })) {
    for (const [area, catalog] of Object.entries(areas)) {
      for (const key of Object.keys(catalog)) assert.ok(key.startsWith(`${area}.`), `${name}/${area}.json: ${key}`);
    }
  }
});

test("a value that ends a sentence swallows the full stop after it", () => {
  const demo = catalog({ "stop.why": "It ended: {{why}}. Open it.", "stop.at": "Saved {{at}}" });
  assert.equal(demo.t("stop.why", { why: "The run failed." }), "It ended: The run failed. Open it.");
  assert.equal(demo.t("stop.why", { why: "Stopped?" }), "It ended: Stopped? Open it.");
  assert.equal(demo.t("stop.why", { why: "exit 1" }), "It ended: exit 1. Open it.");
  assert.equal(demo.english("stop.why", { why: "Done." }), "It ended: Done. Open it.");
  assert.equal(demo.t("stop.at", { at: "v1." }), "Saved v1.");
});

test("a message shown in another language can be had in English, and so can one quoted inside another", async () => {
  const demo = catalog(
    { "mem.failed": "Couldn't read {{file}}.", "mem.outcome": "Stopped on an error: {{error}}" },
    { id: () => ({ "mem.failed": "Tidak bisa membaca {{file}}.", "mem.outcome": "Berhenti karena error: {{error}}" }) },
  );
  await setLanguage("id");
  const error = demo.t("mem.failed", { file: "a.ts" });
  assert.equal(error, "Tidak bisa membaca a.ts.");
  assert.equal(inEnglish(error), "Couldn't read a.ts.");
  // An English result quoting the Indonesian error reads in English throughout.
  assert.equal(demo.english("mem.outcome", { error }), "Stopped on an error: Couldn't read a.ts.");
  // Text no catalog made stays as it is.
  assert.equal(inEnglish("fatal: not a git repository"), "fatal: not a git repository");
});
