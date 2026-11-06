import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { translationProblems } from "@agentchainer/protocol";
import { CATALOGS } from "./index.ts";
import { CATALOGS as INDONESIAN } from "./locales/id/index.ts";

// X-13: the catalogs stay complete and used, and the UI doesn't grow literal text again. Biome's noJsxLiterals covers
// text between tags; the props a person reads are checked here.

const src = path.resolve(import.meta.dirname, "..");
const rust = path.resolve(src, "../src-tauri/src");

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => pattern.test(f) && !f.endsWith(".test.ts") && !f.startsWith("i18n/locales"))
    .map((f) => path.join(dir, f));
}

const sources = [...files(src, /\.tsx?$/), ...files(rust, /\.rs$/)].map((f) => ({
  file: path.relative(src, f),
  text: readFileSync(f, "utf8"),
}));

test("every message is a string, and no key is in two catalogs", () => {
  const seen = new Map<string, string>();
  for (const [area, catalog] of Object.entries(CATALOGS)) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, "string", `${area}: ${key}`);
      assert.ok(!seen.has(key), `${key} is in both ${seen.get(key)} and ${area}`);
      assert.ok(key.startsWith(`${area}.`), `${key} belongs in ${area}.json under "${area}."`);
      seen.set(key, area);
    }
  }
});

test("every key is used somewhere (a plural by its name without the suffix)", () => {
  const all = sources.map((s) => s.text).join("\n");
  const unused = Object.values(CATALOGS)
    .flatMap((c) => Object.keys(c))
    .map((k) => k.replace(/_(zero|one|two|few|many|other)$/, ""))
    .filter((k, i, keys) => keys.indexOf(k) === i)
    // Menu items are looked up by their id, in menu.rs and TitleBar.tsx.
    .filter((k) => !k.startsWith("menu.") && !all.includes(`"${k}"`));
  assert.deepEqual(unused, []);
});

test("the props a person reads are never literal text in a component", () => {
  const PROPS = /\b(label|title|placeholder|aria-label|aria-description|description|confirmLabel|alt|hint)="([^"]*)"/g;
  const found = sources
    .filter((s) => s.file.endsWith(".tsx"))
    .flatMap((s) =>
      [...s.text.matchAll(PROPS)].filter((m) => /[A-Za-z]/.test(m[2] ?? "")).map((m) => `${s.file}: ${m[0]}`),
    );
  assert.deepEqual(found, []);
});

for (const [name, translated] of Object.entries({ id: INDONESIAN })) {
  test(`${name}: every English key is translated, with the same values and tags, and nothing extra`, () => {
    const english: Record<string, string> = Object.assign({}, ...Object.values(CATALOGS));
    const ours: Record<string, string> = Object.assign({}, ...Object.values(translated));
    assert.deepEqual(translationProblems(english, ours), { missing: [], extra: [], empty: [], differs: [] });
  });

  test(`${name}: every key lives in its area's file`, () => {
    for (const [area, catalog] of Object.entries(translated)) {
      for (const key of Object.keys(catalog)) assert.ok(key.startsWith(`${area}.`), `${name}/${area}.json: ${key}`);
    }
  });
}
