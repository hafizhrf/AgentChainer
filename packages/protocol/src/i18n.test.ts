import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { commandRisk } from "./approval.ts";
import { catalog, currentLocale, setLanguage, translationProblems } from "./i18n.ts";
import { cadenceText } from "./index.ts";
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
