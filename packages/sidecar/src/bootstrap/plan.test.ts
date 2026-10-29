import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { catalog as shipped } from "../catalog/index.ts";
import type { Catalog, Item } from "../catalog/schema.ts";
import { catalogJsonText, catalogSchemaText, readCatalogSource } from "../catalog/source.ts";
import { auditWorkspace } from "../detect/audit.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { copyFixture, FIXTURE_SETUPS, removeFixtureCopies } from "../detect/fixture-copy.ts";
import { buildPlan, gitHost, type PlanEnv } from "./plan.ts";

after(removeFixtureCopies);

const env = (over: Partial<PlanEnv> = {}): PlanEnv => ({
  platform: "linux",
  hasTool: () => true,
  remoteHost: null,
  enabledPlugins: new Set(),
  ...over,
});

const plugin = (id: string, over: Partial<Item> = {}): Item => ({
  id,
  name: id,
  kind: "plugin",
  tier: "official",
  license: "MIT",
  summary: "s",
  why: "w",
  source: { type: "marketplace", marketplace: "m", repo: "o/r", plugin: id, reviewedRef: "a".repeat(40) },
  platforms: ["darwin", "linux", "win32"],
  requires: [],
  risk: "low",
  permissions: ["p"],
  secrets: [],
  install: { scope: "project", steps: [{ run: ["claude", "plugin", "install", `${id}@m`] }] },
  uninstall: { steps: [{ run: ["claude", "plugin", "uninstall", `${id}@m`] }] },
  reviews: [{ by: "maintainer", date: "2026-10-29", ref: "a".repeat(40) }],
  ...over,
});

const catalog = (items: Item[], profiles: Catalog["profiles"]): Catalog => ({ version: "2026.10.29", items, profiles });

function planFor(name: string, cat: Catalog, e: PlanEnv, optIn: string[] = []) {
  const dir = copyFixture(name);
  const profile = detectWorkspace(dir);
  return buildPlan(dir, profile, auditWorkspace(dir, profile), cat, e, optIn);
}

describe("buildPlan: catalog items", () => {
  const cat = catalog(
    [
      plugin("reviewed"),
      plugin("unreviewed", { reviews: [] }),
      plugin("needs-tool", { requires: [{ tool: "gopls", hint: "go install …" }] }),
      plugin("community", {
        tier: "community",
        reviews: [
          { by: "a", date: "2026-10-29", ref: "x" },
          { by: "b", date: "2026-10-29", ref: "x" },
        ],
      }),
      plugin("mac-only", { platforms: ["darwin"] }),
      plugin("extra"),
    ],
    [
      {
        id: "base",
        name: "Base",
        description: "d",
        suggest: { always: true },
        items: ["reviewed", "unreviewed", "needs-tool", "community", "mac-only"],
      },
      { id: "opt", name: "Opt", description: "d", suggest: { optIn: true }, items: ["extra"] },
    ],
  );
  const byId = (plan: ReturnType<typeof buildPlan>) => new Map(plan.actions.map((a) => [a.id, a]));

  it("recommends reviewed items and pre-selects them, except community ones (ADR-0005)", () => {
    const a = byId(planFor("ts-pnpm-vite", cat, env()));
    assert.deepEqual([a.get("item:reviewed")?.state, a.get("item:reviewed")?.selected], ["recommended", true]);
    assert.deepEqual([a.get("item:community")?.state, a.get("item:community")?.selected], ["recommended", false]);
  });

  it("explains why an item can't be applied", () => {
    const a = byId(planFor("ts-pnpm-vite", cat, env({ hasTool: () => false })));
    assert.match(a.get("item:unreviewed")?.reason ?? "", /Not reviewed yet: needs 1 more/);
    assert.match(a.get("item:needs-tool")?.reason ?? "", /Needs `gopls` on PATH \(go install …\)/);
    assert.match(a.get("item:mac-only")?.reason ?? "", /Not available on linux/);
    for (const id of ["item:unreviewed", "item:needs-tool", "item:mac-only"]) assert.equal(a.get(id)?.selected, false);
  });

  it("marks plugins the project already enabled as installed", () => {
    const a = byId(planFor("ts-pnpm-vite", cat, env({ enabledPlugins: new Set(["reviewed@m"]) })));
    assert.deepEqual([a.get("item:reviewed")?.state, a.get("item:reviewed")?.selected], ["installed", false]);
  });

  it("adds opt-in profiles only on request, unselected", () => {
    assert.equal(byId(planFor("ts-pnpm-vite", cat, env())).has("item:extra"), false);
    const a = byId(planFor("ts-pnpm-vite", cat, env(), ["opt"]));
    assert.deepEqual([a.get("item:extra")?.state, a.get("item:extra")?.selected], ["optional", false]);
  });
});

describe("buildPlan: fixes from the audit", () => {
  const none = catalog([], []);

  it("previews the exact .gitignore change and the git commands", () => {
    const legacy = new Map(planFor("legacy-messy", none, env()).actions.map((a) => [a.id, a]));
    const gitignore = legacy.get("fix:fix-gitignore")?.preview;
    assert.ok(gitignore?.type === "diff");
    assert.equal(gitignore.before, "node_modules\n");
    assert.equal(
      gitignore.after,
      "node_modules\n# Env files can hold secrets (keep examples)\n.env\n.env.*\n!.env.example\n",
    );
    assert.deepEqual(legacy.get("fix:untrack-env")?.preview, {
      type: "commands",
      commands: [["git", "rm", "--cached", "--", ".env"]],
    });
    const empty = planFor("empty", none, env()).actions.map((a) => a.id);
    assert.ok(empty.includes("fix:git-init"));
  });

  it("lists generators as not yet available", () => {
    const gen = planFor("empty", none, env()).actions.filter((a) => a.kind === "generator");
    assert.ok(gen.length > 0);
    assert.ok(gen.every((a) => a.state === "unavailable" && !a.selected));
  });
});

describe("gitHost", () => {
  it("reads https and ssh remotes, and SSH aliases of github.com", () => {
    assert.equal(gitHost("https://github.com/o/r.git"), "github.com");
    assert.equal(gitHost("git@github.com:o/r.git"), "github.com");
    assert.equal(gitHost("git@github-personal.com:o/r.git"), "github.com");
    assert.equal(gitHost("ssh://git@gitlab.com/o/r.git"), "gitlab.com");
  });
});

describe("the shipped catalog", () => {
  const dir = fileURLToPath(new URL("../../../../catalog/", import.meta.url));

  it("validates, and catalog.json and catalog/schema.json are up to date (run scripts/build-catalog.ts)", () => {
    const source = readCatalogSource(dir);
    assert.equal(readFileSync(new URL("../catalog/catalog.json", import.meta.url), "utf8"), catalogJsonText(source));
    assert.equal(readFileSync(new URL("schema.json", `file://${dir}`), "utf8"), catalogSchemaText());
    assert.deepEqual(shipped, source);
  });

  it("pins every marketplace item to a reviewed marketplace commit", () => {
    for (const item of shipped.items) {
      if (item.source.type === "marketplace") assert.match(item.source.reviewedRef, /^[0-9a-f]{40}$/, item.id);
    }
  });

  for (const name of Object.keys(FIXTURE_SETUPS)) {
    it(`plan snapshot: ${name}`, () => {
      const plan = planFor(name, shipped, env({ remoteHost: name === "ts-pnpm-vite" ? "github.com" : null }));
      const file = new URL(`../../test/snapshots/${name}.plan.json`, import.meta.url);
      const text = `${JSON.stringify(plan, null, 2)}\n`;
      if (process.env.UPDATE_SNAPSHOTS === "1") writeFileSync(file, text);
      assert.equal(readFileSync(file, "utf8"), text);
    });
  }
});
