import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { translationProblems } from "@agentchainer/protocol";
import { CATALOGS, INDONESIAN } from "./index.ts";

// X-13: the sidecar's catalogs stay complete and used, and errors that reach a person don't grow literal text again.

/** Code that never runs in the app, so its errors only reach developers. */
const DEV_ONLY: Record<string, string> = {
  "evals/": "the eval benchmark (scripts/benchmark.ts)",
  "catalog/source.ts": "reads the catalog's YAML for build-catalog.ts and the source check",
  "detect/fixture-copy.ts": "copies fixtures for tests, evals and live-task.ts",
};

const src = path.resolve(import.meta.dirname, "..");
const sources = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("i18n"))
  .filter((f) => !Object.keys(DEV_ONLY).some((d) => f.replaceAll("\\", "/").startsWith(d)))
  .map((f) => ({ file: f.replaceAll("\\", "/"), text: readFileSync(path.join(src, f), "utf8") }));

/**
 * Errors with literal text that never reach a person, each with why. Everything else a handler throws ends up on
 * screen, so it goes through `t()`.
 */
const INTERNAL: Record<string, string> = {};

test("every message is a string, in its area's file, in both languages", () => {
  for (const [name, catalogs] of Object.entries({ en: CATALOGS, id: INDONESIAN })) {
    for (const [area, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        assert.equal(typeof value, "string", `${name}/${area}: ${key}`);
        assert.ok(key.startsWith(`${area}.`), `${name}/${area}.json: ${key}`);
      }
    }
  }
});

test("Bahasa Indonesia has every English key, with the same values and tags, and nothing extra", () => {
  const english: Record<string, string> = Object.assign({}, ...Object.values(CATALOGS));
  const indonesian: Record<string, string> = Object.assign({}, ...Object.values(INDONESIAN));
  assert.deepEqual(translationProblems(english, indonesian), { missing: [], extra: [], empty: [], differs: [] });
});

test("every key is used somewhere (a plural by its name without the suffix)", () => {
  const all = sources.map((s) => s.text).join("\n");
  const unused = Object.values(CATALOGS)
    .flatMap((c) => Object.keys(c))
    .map((k) => k.replace(/_(zero|one|two|few|many|other)$/, ""))
    .filter((k, i, keys) => keys.indexOf(k) === i && !all.includes(`"${k}"`));
  assert.deepEqual(unused, []);
});

test("errors that reach a person aren't literal text", () => {
  const LITERAL =
    /(?:new RpcFailure\([^,()]+,\s*|\binvalid\(\s*|throw new Error\(\s*|new AlreadyRunning\(\s*)(["'`])((?:\\.|(?!\1).)*)\1/g;
  const found = sources.flatMap((s) =>
    [...s.text.matchAll(LITERAL)]
      .filter((m) => /[A-Za-z]{2}/.test(m[2] ?? "") && !((m[2] ?? "") in INTERNAL))
      .map((m) => `${s.file}: ${m[2]?.slice(0, 70)}`),
  );
  assert.deepEqual(found, []);
});
