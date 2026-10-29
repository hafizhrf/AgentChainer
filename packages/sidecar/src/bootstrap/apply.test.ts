import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Catalog, Item } from "../catalog/schema.ts";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import type { CliResult } from "../installer.ts";
import { type ApplyContext, applyActions, type Cli, listRuns, pluginVersion, rollback } from "./apply.ts";
import { type FetchTree, treeHash } from "./git-source.ts";
import type { PlanEnv } from "./plan.ts";

/** Installer and rollback runs on temp copies of the fixture repos (M2-28). No network, no real CLI. */
after(removeFixtureCopies);

const env: PlanEnv = { platform: "linux", hasTool: () => true, remoteHost: null, enabledPlugins: new Set() };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");
const review = [{ by: "maintainer", date: "2026-10-29", ref: "test" }];

const pluginItem: Item = {
  id: "demo",
  name: "Demo plugin",
  kind: "plugin",
  tier: "official",
  license: "MIT",
  summary: "s",
  why: "w",
  source: {
    type: "marketplace",
    marketplace: "mkt",
    repo: "o/mkt",
    plugin: "demo",
    reviewedVersion: "1.0.1",
    reviewedRef: "a".repeat(40),
  },
  platforms: ["darwin", "linux", "win32"],
  requires: [],
  risk: "low",
  permissions: [],
  secrets: [],
  install: { scope: "project", steps: [{ run: ["claude", "plugin", "install", "demo@mkt"] }] },
  uninstall: { steps: [{ run: ["claude", "plugin", "uninstall", "demo@mkt"] }] },
  reviews: review,
};

const catalogOf = (items: Item[]): Catalog => ({
  version: "2026.10.29",
  items,
  profiles: [{ id: "base", name: "Base", description: "d", suggest: { always: true }, items: items.map((i) => i.id) }],
});

const ok = (json: unknown = null): CliResult => ({ ok: true, status: 0, json, stdout: "", stderr: "" });

/** A CLI stand-in that edits .claude/settings.json the way `claude plugin install/uninstall` does. */
function fakeCli(root: string, opts: { marketplaces?: string[]; version?: string } = {}): Cli & { calls: string[] } {
  const settings = join(root, ".claude", "settings.json");
  const calls: string[] = [];
  const edit = (fn: (s: { enabledPlugins?: Record<string, boolean> }) => void) => {
    const s = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
    fn(s);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settings, JSON.stringify(s));
  };
  return {
    calls,
    installPlugin: (id) => {
      calls.push(`install ${id}`);
      edit((s) => {
        s.enabledPlugins = { ...s.enabledPlugins, [id]: true };
      });
      return ok({ outcome: "ok" });
    },
    uninstallPlugin: (id) => {
      calls.push(`uninstall ${id}`);
      edit((s) => {
        delete s.enabledPlugins?.[id];
      });
      return ok();
    },
    listPlugins: () => ok([{ id: "demo@mkt", version: opts.version ?? "1.0.1", scope: "project" }]),
    listMarketplaces: () => ok((opts.marketplaces ?? ["mkt"]).map((name) => ({ name }))),
  };
}

const ctx = (root: string, over: Partial<ApplyContext> = {}): ApplyContext => ({
  catalog: catalogOf([]),
  env,
  cli: fakeCli(root),
  now: () => new Date("2026-10-29T08:00:00Z"),
  ...over,
});

describe("apply and roll back fixes", () => {
  it("applies the .gitignore and .env fixes, then a full rollback leaves git status clean and files byte-identical", async () => {
    const dir = copyFixture("legacy-messy");
    const gitignore = read(dir, ".gitignore");
    const { runId, results } = await applyActions(dir, ["fix:fix-gitignore", "fix:untrack-env"], ctx(dir));
    assert.deepEqual(
      results.map((r) => [r.id, r.status]),
      [
        ["fix:untrack-env", "applied"],
        ["fix:fix-gitignore", "applied"],
      ],
    );
    assert.match(read(dir, ".gitignore"), /^\.env$/m);
    assert.equal(git(dir, "ls-files", ".env").trim(), "", ".env is no longer tracked");
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.deepEqual(
      lock.fixes.map((f: { id: string }) => f.id),
      ["untrack-env", "fix-gitignore"],
    );
    assert.equal(read(dir, ".agentchainer/.gitignore"), "backups/\nprofile.json\n");

    // Idempotent: the fixed findings are gone, so a re-run applies nothing.
    const again = await applyActions(dir, ["fix:fix-gitignore"], ctx(dir));
    assert.equal(again.results[0]?.status, "skipped");

    assert.deepEqual(
      rollback(dir, runId, ctx(dir)).map((r) => r.status),
      ["rolled-back", "rolled-back"],
    );
    assert.equal(read(dir, ".gitignore"), gitignore);
    assert.equal(git(dir, "ls-files", ".env").trim(), ".env");
    assert.equal(git(dir, "status", "--porcelain"), "", "no trace of the run");
    assert.equal(existsSync(join(dir, ".agentchainer")), false);
  });

  it("won't overwrite a file edited after the run, unless forced", async () => {
    const dir = copyFixture("legacy-messy");
    const original = read(dir, ".gitignore");
    const { runId } = await applyActions(dir, ["fix:fix-gitignore"], ctx(dir));
    writeFileSync(join(dir, ".gitignore"), `${read(dir, ".gitignore")}my-own-line\n`);
    const [res] = rollback(dir, runId, ctx(dir));
    assert.equal(res?.status, "conflict");
    assert.match(read(dir, ".gitignore"), /my-own-line/, "the user's edit is kept");
    assert.equal(rollback(dir, runId, ctx(dir), { force: true })[0]?.status, "rolled-back");
    assert.equal(read(dir, ".gitignore"), original);
  });

  it("initializes git in an empty folder, and removes it again while it has no commits", async () => {
    const dir = copyFixture("empty");
    const { runId, results } = await applyActions(dir, ["fix:git-init"], ctx(dir));
    assert.equal(results[0]?.status, "applied");
    assert.ok(existsSync(join(dir, ".git")));
    rollback(dir, runId, ctx(dir));
    assert.equal(existsSync(join(dir, ".git")), false);
  });
});

describe("apply catalog items", () => {
  it("installs a reviewed plugin through the CLI, records its version, warns on drift, and rolls back", async () => {
    const dir = copyFixture("ts-pnpm-vite");
    const cli = fakeCli(dir, { version: "1.0.2" });
    const c = ctx(dir, { catalog: catalogOf([pluginItem]), cli });
    const { runId, results } = await applyActions(dir, ["item:demo"], c);
    assert.equal(results[0]?.status, "applied");
    assert.match(results[0]?.warnings[0] ?? "", /Installed 1\.0\.2, but 1\.0\.1 was reviewed/);
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.deepEqual([lock.items[0].id, lock.items[0].version, lock.items[0].scope], ["demo", "1.0.2", "project"]);
    assert.deepEqual(
      rollback(dir, runId, c).map((r) => r.status),
      ["rolled-back"],
    );
    assert.deepEqual(cli.calls, ["install demo@mkt", "uninstall demo@mkt"]);
    assert.equal(existsSync(join(dir, ".claude", "settings.json")), false, "settings.json didn't exist before");
    assert.equal(git(dir, "status", "--porcelain"), "");
  });

  it("refuses unreviewed items and fails clearly when the marketplace isn't set up", async () => {
    const dir = copyFixture("ts-pnpm-vite");
    const unreviewed = await applyActions(
      dir,
      ["item:demo"],
      ctx(dir, { catalog: catalogOf([{ ...pluginItem, reviews: [] }]) }),
    );
    assert.match(unreviewed.results[0]?.message ?? "", /Not reviewed yet/);
    const noMarket = await applyActions(
      dir,
      ["item:demo"],
      ctx(dir, { catalog: catalogOf([pluginItem]), cli: fakeCli(dir, { marketplaces: [] }) }),
    );
    assert.equal(noMarket.results[0]?.status, "failed");
    assert.match(noMarket.results[0]?.message ?? "", /claude plugin marketplace add o\/mkt/);
    assert.equal(existsSync(join(dir, ".claude")), false, "nothing left behind");
    assert.equal(listRuns(dir).length, 0);
  });

  it("copies a pinned git source only when its tree hash matches", async () => {
    const src = mkdtempSync(join(tmpdir(), "ac-skill-"));
    mkdirSync(join(src, "skill", "refs"), { recursive: true });
    writeFileSync(join(src, "skill", "SKILL.md"), "---\nname: demo\n---\nDo things.\n");
    writeFileSync(join(src, "skill", "refs", "a.md"), "ref\n");
    const fetchTree: FetchTree = async () => {
      const copy = mkdtempSync(join(tmpdir(), "ac-fetched-"));
      cpSync(join(src, "skill"), copy, { recursive: true });
      return { dir: copy, cleanup: () => rmSync(copy, { recursive: true, force: true }) };
    };
    const skill = (sha256: string): Item => ({
      ...pluginItem,
      id: "demo-skill",
      kind: "skill",
      tier: "verified-vendor",
      source: { type: "git", repo: "https://github.com/o/skill", ref: "b".repeat(40), path: "skill", sha256 },
      install: { scope: "project", steps: [{ copy: { from: ".", to: ".claude/skills/demo" } }] },
      uninstall: { steps: [{ remove: ".claude/skills/demo" }] },
    });
    try {
      const dir = copyFixture("go-service");
      const bad = await applyActions(
        dir,
        ["item:demo-skill"],
        ctx(dir, { catalog: catalogOf([skill("0".repeat(64))]), fetchTree }),
      );
      assert.match(bad.results[0]?.message ?? "", /Hash mismatch/);
      assert.equal(existsSync(join(dir, ".claude")), false);

      const good = catalogOf([skill(treeHash(join(src, "skill")))]);
      const { runId, results } = await applyActions(dir, ["item:demo-skill"], ctx(dir, { catalog: good, fetchTree }));
      assert.equal(results[0]?.status, "applied");
      assert.equal(read(dir, ".claude/skills/demo/refs/a.md"), "ref\n");
      assert.deepEqual(JSON.parse(read(dir, ".agentchainer/lock.json")).items[0].files, [
        ".claude/skills/demo/SKILL.md",
        ".claude/skills/demo/refs/a.md",
      ]);
      rollback(dir, runId, ctx(dir));
      assert.equal(existsSync(join(dir, ".claude")), false, "copied files and their folders are gone");
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("rolls back one action and keeps the rest of the run in the lockfile", async () => {
    const dir = copyFixture("legacy-messy");
    const c = ctx(dir, { catalog: catalogOf([pluginItem]) });
    const { runId } = await applyActions(dir, ["fix:fix-gitignore", "item:demo"], c);
    assert.deepEqual(
      rollback(dir, runId, c, { actionId: "item:demo" }).map((r) => r.status),
      ["rolled-back"],
    );
    const lock = JSON.parse(read(dir, ".agentchainer/lock.json"));
    assert.deepEqual([lock.items.length, lock.fixes.map((f: { id: string }) => f.id)], [0, ["fix-gitignore"]]);
    const [run] = listRuns(dir);
    assert.deepEqual(
      run?.actions.map((a) => [a.id, a.status]),
      [
        ["fix:fix-gitignore", "applied"],
        ["item:demo", "rolled-back"],
      ],
    );
  });
});

describe("pluginVersion", () => {
  it("finds the version in the CLI's list output shapes", () => {
    assert.equal(pluginVersion([{ id: "x@m", version: "1.2.3" }], "x@m"), "1.2.3");
    assert.equal(pluginVersion({ plugins: [{ name: "x", marketplace: "m", version: "2.0.0" }] }, "x@m"), "2.0.0");
    assert.equal(pluginVersion(null, "x@m"), undefined);
  });
});
