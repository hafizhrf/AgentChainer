import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { listRuns, rollback } from "./bootstrap/apply.ts";
import { fakeCli, ok } from "./bootstrap/fake-cli.ts";
import type { Catalog, Item } from "./catalog/schema.ts";
import type { CliResult, PluginCli } from "./installer.ts";
import {
  confirmOf,
  installListed,
  listPluginsFor,
  parseAvailable,
  parseDetails,
  parseInstalled,
  parseMarketplaces,
  uninstallListed,
  updateListed,
} from "./plugins.ts";

/** The Plugins page (UX-10) against a stand-in CLI: the JSON is shaped like CLI 2.1.293's, with made-up paths. */

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ac-plugins-"));
  roots.push(root);
  return root;
}

const item = (id: string, plugin: string, reviews: number, reviewedVersion = "1.0.1"): Item => ({
  id,
  name: `${id} plugin`,
  kind: "plugin",
  tier: "official",
  license: "Apache-2.0",
  summary: "s",
  why: "w",
  source: {
    type: "marketplace",
    marketplace: "claude-plugins-official",
    repo: "anthropics/claude-plugins-official",
    plugin,
    reviewedVersion,
    reviewedRef: "a".repeat(40),
  },
  platforms: ["darwin", "linux", "win32"],
  requires: [],
  risk: "low",
  permissions: ["Adds three slash commands"],
  secrets: [],
  install: { scope: "project", steps: [{ run: ["claude", "plugin", "install", `${plugin}@claude-plugins-official`] }] },
  reviews: Array.from({ length: reviews }, () => ({ by: "maintainer", date: "2026-10-30", ref: "test" })),
});

const catalog: Catalog = {
  version: "2026.11.04",
  items: [item("commit-commands", "commit-commands", 1), item("security-guidance", "security-guidance", 0, "2.0.17")],
  profiles: [],
} as unknown as Catalog;

const marketplacesJson = [
  {
    name: "claude-plugins-official",
    source: "github",
    repo: "anthropics/claude-plugins-official",
    installLocation: "/home/someone/.claude/plugins/marketplaces/claude-plugins-official",
  },
  { name: "team-tools", source: "github", repo: "acme/team-tools", installLocation: "/home/someone/x" },
];

const availableJson = {
  installed: [],
  available: [
    {
      pluginId: "commit-commands@claude-plugins-official",
      name: "commit-commands",
      description: "Commands for git commit workflows",
      marketplaceName: "claude-plugins-official",
      version: "1.0.2",
      source: "./plugins/commit-commands",
      installCount: 120000,
    },
    {
      pluginId: "security-guidance@claude-plugins-official",
      name: "security-guidance",
      marketplaceName: "claude-plugins-official",
      version: "2.0.17",
      source: "./plugins/security-guidance",
    },
    {
      pluginId: "design@anthropic-plugin-directory",
      name: "design",
      description: "Design workflows",
      marketplaceName: "anthropic-plugin-directory",
      version: "1.2.0",
      source: {
        source: "git-subdir",
        url: "https://github.com/anthropics/knowledge-work-plugins",
        path: "design",
        sha: "2574e29377c7173d0cecffef29a6ecbd7f8ccb5d",
      },
    },
    {
      pluginId: "linter@team-tools",
      name: "linter",
      marketplaceName: "team-tools",
      source: { source: "url", url: "https://github.com/acme/linter.git", sha: "b".repeat(40) },
    },
    { name: "broken" },
  ],
};

const DETAILS = `commit-commands 1.0.1
  Description: Commands for git commit workflows including commit, push, and PR creation
  Source: commit-commands@claude-plugins-official

Component inventory
  Skills (3)  clean_gone, commit, commit-push-pr
  Agents (0)
  Hooks (1)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~1,105 tok   added to every session
`;

/**
 * A stand-in for the user's CLI that edits the settings files like `claude plugin install/uninstall` do, and lists
 * what it installed.
 */
function fakePluginCli(root: string, opts: { confirm?: string; version?: string; fail?: boolean } = {}) {
  const calls: string[] = [];
  const installed: { id: string; version: string; scope: string; projectPath: string; enabled: boolean }[] = [];
  const settings = (scope: string) =>
    join(root, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
  const edit = (scope: string, fn: (s: { enabledPlugins?: Record<string, boolean> }) => void) => {
    const file = settings(scope);
    const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    fn(s);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify(s));
  };
  const cli: PluginCli = {
    available: async () => ok(availableJson),
    marketplaces: async () => ok(marketplacesJson),
    installed: async () => ok(installed),
    details: async () => ({ ...ok(), stdout: DETAILS }),
    install: async (id, scope, accept) => {
      calls.push(`install ${id} ${scope}${accept ? ` accept ${accept}` : ""}`);
      if (opts.fail) return { ok: false, status: 1, json: { message: "network down" }, stdout: "", stderr: "" };
      if (opts.confirm && accept !== opts.confirm) {
        const json = {
          outcome: "refused",
          shownCommand: { kind: "entry_helper", command: "fetch-archive --x", sha256: opts.confirm },
        };
        return { ok: false, status: 1, json, stdout: "", stderr: "" } satisfies CliResult;
      }
      edit(scope, (s) => {
        s.enabledPlugins = { ...s.enabledPlugins, [id]: true };
      });
      const version = opts.version ?? "1.0.2";
      installed.push({ id, version, scope, projectPath: root, enabled: true });
      return ok({ outcome: "ok", pluginId: id, scope, installedVersion: version });
    },
    update: async (id, scope) => {
      calls.push(`update ${id} ${scope}`);
      return ok({ outcome: "ok", installedVersion: "1.0.3" });
    },
    uninstall: async (id, scope) => {
      calls.push(`uninstall ${id} ${scope}`);
      edit(scope, (s) => {
        delete s.enabledPlugins?.[id];
      });
      return ok();
    },
    setEnabled: async (id, scope, enabled) => {
      calls.push(`${enabled ? "enable" : "disable"} ${id} ${scope}`);
      return ok();
    },
  };
  return { cli, calls };
}

describe("the Plugins page's listing (UX-10)", () => {
  const marketplaces = parseMarketplaces(marketplacesJson);

  it("marks Anthropic's marketplaces official, and keeps no local paths", () => {
    assert.deepEqual(marketplaces, [
      { name: "claude-plugins-official", repo: "anthropics/claude-plugins-official", official: true },
      { name: "team-tools", repo: "acme/team-tools", official: false },
    ]);
  });

  it("lists every plugin with its source, and the catalog's review where it has one", () => {
    const list = parseAvailable(availableJson, marketplaces, catalog);
    assert.deepEqual(
      list.map((p) => [p.id, p.official, p.review?.approved ?? null]),
      [
        ["commit-commands@claude-plugins-official", true, true],
        ["security-guidance@claude-plugins-official", true, false],
        ["design@anthropic-plugin-directory", true, null],
        ["linter@team-tools", false, null],
      ],
    );
    assert.deepEqual(list[0]?.source, {
      url: "https://github.com/anthropics/claude-plugins-official",
      path: "plugins/commit-commands",
    });
    assert.equal(list[2]?.source.sha, "2574e29377c7173d0cecffef29a6ecbd7f8ccb5d");
    assert.equal(list[0]?.review?.reviewedVersion, "1.0.1");
    assert.equal(list[0]?.installCount, 120000);
  });

  it("trusts a review only in Anthropic's marketplace, not in one that reuses its name", () => {
    const impostor = parseMarketplaces([{ name: "claude-plugins-official", repo: "someone/claude-plugins-official" }]);
    const [p] = parseAvailable(availableJson, impostor, catalog);
    assert.equal(p?.official, false);
    assert.equal(p?.review, undefined);
  });

  it("shows this workspace's and the user's plugins, with newer listed versions as updates", () => {
    const root = workspace();
    const list = parseAvailable(availableJson, marketplaces, catalog);
    const installed = parseInstalled(
      [
        {
          id: "commit-commands@claude-plugins-official",
          version: "1.0.1",
          scope: "project",
          enabled: true,
          projectPath: root,
        },
        { id: "design@anthropic-plugin-directory", version: "1.1.0", scope: "user", enabled: true },
        {
          id: "security-guidance@claude-plugins-official",
          version: "2.0.16",
          scope: "local",
          projectPath: root,
          enabled: false,
        },
        {
          id: "linter@team-tools",
          version: "1.0.0",
          scope: "project",
          projectPath: "/elsewhere/project",
          enabled: true,
        },
      ],
      root,
      list,
    );
    assert.deepEqual(
      installed.map((p) => [p.id, p.scope, p.here, p.enabled, p.update ?? null]),
      [
        ["commit-commands@claude-plugins-official", "project", true, true, { to: "1.0.2", reviewed: false }],
        ["design@anthropic-plugin-directory", "user", false, true, { to: "1.2.0", reviewed: null }],
        ["security-guidance@claude-plugins-official", "local", true, false, { to: "2.0.17", reviewed: false }],
      ],
    );
  });

  it("reads a local install as on, though the CLI says it's not on in the shared settings file", () => {
    const root = workspace();
    const entry = { id: "x@m", version: "1", scope: "local", projectPath: root, enabled: true, projectEnabled: false };
    assert.equal(parseInstalled([entry], root, [])[0]?.enabled, true);
    assert.equal(parseInstalled([{ ...entry, enabled: false }], root, [])[0]?.enabled, false);
  });

  it("lists through the CLI once per session, until refreshed", async () => {
    const root = workspace();
    const { cli } = fakePluginCli(root);
    let asked = 0;
    const counting = {
      ...cli,
      available: async () => {
        asked++;
        return cli.available();
      },
    };
    await listPluginsFor(root, counting, catalog);
    await listPluginsFor(root, counting, catalog);
    assert.equal(asked, 1);
    const fresh = await listPluginsFor(root, counting, catalog, true);
    assert.equal(asked, 2);
    assert.ok(fresh.marketplaces.some((m) => m.name === "anthropic-plugin-directory" && m.official));
  });
});

describe("a plugin's details", () => {
  it("reads the inventory and the always-on tokens out of the CLI's text", () => {
    const d = parseDetails(DETAILS);
    assert.deepEqual(d.inventory, {
      skills: ["clean_gone", "commit", "commit-push-pr"],
      agents: [],
      hooks: ["Hooks 1"],
      mcpServers: [],
      lspServers: [],
    });
    assert.equal(d.alwaysOnTokens, 1105);
  });

  it("keeps text it doesn't know as it is, with no counts", () => {
    const d = parseDetails("Something new\n  Parts: 3\n");
    assert.equal(d.text, "Something new\n  Parts: 3");
    assert.equal(d.inventory, undefined);
  });
});

describe("a command the marketplace declares", () => {
  it("is shown for a person to confirm, by its sha256", () => {
    const sha = "c".repeat(64);
    const res: CliResult = {
      ok: false,
      status: 1,
      json: { shownCommand: { command: ["helper", "--fetch"], archiveUrl: "https://example.com/p.tgz", sha256: sha } },
      stdout: "",
      stderr: "",
    };
    assert.deepEqual(confirmOf(res), { command: "helper --fetch (fetches https://example.com/p.tgz)", sha256: sha });
    assert.equal(confirmOf({ ...res, json: { shownCommand: { command: "x", sha256: "nope" } } }), null);
    assert.equal(confirmOf(ok({ outcome: "failed" })), null);
  });
});

describe("installing from the Plugins page", () => {
  it("records an unreviewed plugin in local.json with its listed source, and Roll back uninstalls it", async () => {
    const root = workspace();
    const { cli, calls } = fakePluginCli(root);
    const done = await installListed(root, cli, catalog, "design@anthropic-plugin-directory", "local");
    assert.equal(done.status, "done");
    assert.ok(done.status === "done" && done.runId);
    assert.deepEqual(calls, ["install design@anthropic-plugin-directory local"]);
    assert.equal(existsSync(join(root, ".agentchainer", "lock.json")), false);
    const local = JSON.parse(readFileSync(join(root, ".agentchainer", "local.json"), "utf8"));
    assert.deepEqual(
      { ...local.items[0], installedAt: "…" },
      {
        id: "design@anthropic-plugin-directory",
        kind: "plugin",
        tier: "unreviewed",
        source: {
          type: "listed",
          marketplace: "anthropic-plugin-directory",
          plugin: "design",
          url: "https://github.com/anthropics/knowledge-work-plugins",
          path: "design",
          sha: "2574e29377c7173d0cecffef29a6ecbd7f8ccb5d",
        },
        scope: "local",
        installedAt: "…",
        version: "1.0.2",
      },
    );
    const [run] = listRuns(root);
    assert.equal(run?.actions[0]?.title, "Install design (plugin)");

    const sync = fakeCli(root);
    const results = rollback(root, run?.runId ?? "", { cli: sync });
    assert.deepEqual(results, [{ id: "plugin:design@anthropic-plugin-directory", status: "rolled-back" }]);
    assert.deepEqual(sync.calls, ["uninstall design@anthropic-plugin-directory"]);
    assert.equal(existsSync(join(root, ".claude", "settings.local.json")), false);
  });

  it("records an approved catalog plugin like a setup step, warning when the version isn't the reviewed one", async () => {
    const root = workspace();
    const { cli } = fakePluginCli(root);
    const done = await installListed(root, cli, catalog, "commit-commands@claude-plugins-official", "project");
    assert.ok(done.status === "done");
    assert.match(done.warnings[0] ?? "", /Installed 1\.0\.2, but 1\.0\.1 was reviewed/);
    const lock = JSON.parse(readFileSync(join(root, ".agentchainer", "lock.json"), "utf8"));
    assert.equal(lock.items[0].id, "commit-commands");
    assert.equal(lock.items[0].tier, "official");
    assert.equal(lock.items[0].version, "1.0.2");
  });

  it("records a catalog plugin still waiting for reviews as unreviewed", async () => {
    const root = workspace();
    const { cli } = fakePluginCli(root, { version: "2.0.17" });
    await installListed(root, cli, catalog, "security-guidance@claude-plugins-official", "project");
    const lock = JSON.parse(readFileSync(join(root, ".agentchainer", "lock.json"), "utf8"));
    assert.equal(lock.items[0].tier, "unreviewed");
  });

  it("asks a person to confirm a declared command first, and leaves no run until it's confirmed", async () => {
    const root = workspace();
    const sha = "d".repeat(64);
    const { cli, calls } = fakePluginCli(root, { confirm: sha });
    const first = await installListed(root, cli, catalog, "linter@team-tools", "local");
    assert.deepEqual(first, { status: "confirm", command: "fetch-archive --x", sha256: sha });
    assert.equal(listRuns(root).length, 0);
    const second = await installListed(root, cli, catalog, "linter@team-tools", "local", sha);
    assert.equal(second.status, "done");
    assert.equal(calls[1], `install linter@team-tools local accept ${sha}`);
    assert.equal(listRuns(root).length, 1);
  });

  it("leaves nothing behind when the CLI fails", async () => {
    const root = workspace();
    const { cli } = fakePluginCli(root, { fail: true });
    await assert.rejects(
      installListed(root, cli, catalog, "design@anthropic-plugin-directory", "local"),
      /network down/,
    );
    assert.equal(listRuns(root).length, 0);
    assert.equal(existsSync(join(root, ".agentchainer", "local.json")), false);
  });

  it("updates the recorded version, and an uninstall drops the entry and marks the run rolled back", async () => {
    const root = workspace();
    const { cli, calls } = fakePluginCli(root);
    await installListed(root, cli, catalog, "design@anthropic-plugin-directory", "project");
    const updated = await updateListed(root, cli, catalog, "design@anthropic-plugin-directory", "project");
    assert.deepEqual(updated, { status: "done", version: "1.0.3", warnings: [] });
    const lockFile = join(root, ".agentchainer", "lock.json");
    assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).items[0].version, "1.0.3");

    await uninstallListed(root, cli, "design@anthropic-plugin-directory", "project");
    assert.deepEqual(JSON.parse(readFileSync(lockFile, "utf8")).items, []);
    assert.equal(listRuns(root)[0]?.actions[0]?.status, "rolled-back");
    assert.deepEqual(calls.slice(-1), ["uninstall design@anthropic-plugin-directory project"]);
    // The settings file didn't exist before the install, so it's gone again, not left with an empty list.
    assert.equal(existsSync(join(root, ".claude", "settings.json")), false);
  });

  it("leaves the settings file to the CLI when something else changed it since the install", async () => {
    const root = workspace();
    const { cli } = fakePluginCli(root);
    await installListed(root, cli, catalog, "design@anthropic-plugin-directory", "project");
    await installListed(root, cli, catalog, "linter@team-tools", "project");
    await uninstallListed(root, cli, "design@anthropic-plugin-directory", "project");
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings.enabledPlugins, { "linter@team-tools": true });
  });
});
