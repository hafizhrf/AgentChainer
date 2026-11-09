import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RESULTS, translationProblems } from "@agentchainer/protocol";
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
const INTERNAL: Record<string, string> = {
  '${name} must be pinned to an exact version, got "${version}"':
    "sdk-pin's pinFromLockfile runs only in scripts/pin-sdk.ts",
  "${name}@${version} not found in pnpm-lock.yaml": "sdk-pin's pinFromLockfile runs only in scripts/pin-sdk.ts",
  "No sha512 integrity for ${name}@${version} in pnpm-lock.yaml":
    "sdk-pin's pinFromLockfile runs only in scripts/pin-sdk.ts",
  "There is no agent profile named ${name}.":
    "Team's default lookup, used only without a profile loader; its TeamError is a tool result Claude reads",
  "No applier for ${action.id}": "every fix the plan builds has an applier",
  "Unknown catalog item ${action.id}": "the plan is built from the same catalog just before",
  "Only git commands run here: ${cmd}": "every caller passes git",
  "${item.id} has no release binary": "catalog validation ties a download-binary step to a release asset",
  "${item.id} isn't a release binary": "callers check the item's source first",
  "${item.id} doesn't name its binary": "validation requires one download-binary step for a release asset",
  "Can't apply ${action.kind} actions.": "the kinds are fix, catalog and generator, and all three are handled",
  "HTTP ${res.status}": "caught and wrapped in the translated download error",
  "a role file starts with --- frontmatter ---": "the task library is checked by build-catalog.ts, at build time",
  "catalog/workflows/${file} is invalid:\\n${z.prettifyError(xl.error)}":
    "the task library is checked by build-catalog.ts, at build time",
  "catalog/workflows/${file} is invalid:\\n${z.prettifyError(w.error)}":
    "the task library is checked by build-catalog.ts, at build time",
  "catalog/workflows/${file}: name it <tier>.yaml": "the task library is checked by build-catalog.ts, at build time",
  "agents/${file} is invalid:\\n${z.prettifyError(r.error)}":
    "the task library is checked by build-catalog.ts, at build time",
  "agents/${file}: name it <name>.md": "the task library is checked by build-catalog.ts, at build time",
  "agents/ac-${role}.md is missing": "the task library is checked by build-catalog.ts, at build time",
  "The task has no run.": "only built for a task whose run is set",
  "The task has no contract.": "only an approved task runs",
  "No role ${step.role} in the library.": "roles are an enum, and the library holds every role",
  "Not a task file: ${name}": "callers pass constant file names",
};

/**
 * Text that becomes a task's result (its outcome, a step's note), which also goes into pull requests: X-13 part 2b
 * stores it in English and translated, together with the rest of a run's results.
 */
const LATER: Record<string, string> = {
  "Sub-task ${child.id} has no workflow or worktree.": "the XL run's outcome",
  "git merge failed: ${(r.stderr || r.stdout).trim() || ": "a sub-task merge's note and the run's outcome",
};

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

test("every task result key is used by the sidecar (X-13 part 2b)", () => {
  const all = sources.map((s) => s.text).join("\n");
  const unused = Object.values(RESULTS)
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
      .filter((m) => /[A-Za-z]{2}/.test(m[2] ?? "") && !((m[2] ?? "") in INTERNAL) && !((m[2] ?? "") in LATER))
      .map((m) => `${s.file}: ${m[2]?.slice(0, 70)}`),
  );
  assert.deepEqual(found, []);
});
