import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InstalledPlugin, MarketPlugin } from "@agentchainer/protocol";
import {
  byDefault,
  defaultScope,
  installedRows,
  oneLiner,
  reviewBadge,
  searchPlugins,
  sourceLink,
  updateCount,
  vendorOf,
} from "./pluginList.ts";

const plugin = (name: string, more: Partial<MarketPlugin> = {}): MarketPlugin => ({
  id: `${name}@claude-plugins-official`,
  name,
  marketplace: "claude-plugins-official",
  source: {},
  official: true,
  ...more,
});

const review = (approved: boolean): MarketPlugin["review"] => ({
  itemId: "x",
  approved,
  tier: "official",
  reviews: approved ? [{ by: "maintainer", date: "2026-10-30" }] : [],
  license: "Apache-2.0",
  risk: "low",
  permissions: [],
  summary: "s",
});

describe("the Plugins page's list (UX-10)", () => {
  const list = [
    plugin("zeta", { installCount: 10 }),
    plugin("commit-commands", { review: review(true), description: "Commands for git commit workflows" }),
    plugin("mine", { marketplace: "team", official: false, installCount: 999 }),
    plugin("alpha", { installCount: 500, description: "Lints commit messages" }),
    plugin("security-guidance", { review: review(false) }),
  ];

  it("puts reviewed plugins first, then Anthropic's, then the most installed", () => {
    assert.deepEqual(
      [...list].sort(byDefault).map((p) => p.name),
      ["commit-commands", "alpha", "zeta", "security-guidance", "mine"],
    );
  });

  it("ranks name matches above description matches, and needs every word", () => {
    assert.deepEqual(
      searchPlugins("commit", list).map((p) => p.name),
      ["commit-commands", "alpha"],
    );
    assert.deepEqual(
      searchPlugins("commit lint", list).map((p) => p.name),
      ["alpha"],
    );
    assert.deepEqual(
      searchPlugins("cmtcmd", list).map((p) => p.name),
      ["commit-commands"],
    );
    assert.deepEqual(
      searchPlugins("", list, true).map((p) => p.name),
      ["commit-commands"],
    );
  });

  it("calls only an approved catalog item reviewed", () => {
    assert.equal(reviewBadge(list[1]).label, "Reviewed");
    assert.match(reviewBadge(list[1]).title, /official, 1 review$/);
    assert.equal(reviewBadge(list[4]).label, "Not reviewed");
    assert.match(reviewBadge(list[4]).title, /waiting for reviews/);
    assert.equal(reviewBadge(list[0]).title, "Not reviewed by AgentChainer");
  });

  it("installs a reviewed plugin for the team and any other just for you by default", () => {
    assert.equal(defaultScope(list[1]), "project");
    assert.equal(defaultScope(list[4]), "local");
    assert.equal(defaultScope(undefined), "local");
  });

  it("links to the source at the pinned commit", () => {
    const sha = "2574e29377c7173d0cecffef29a6ecbd7f8ccb5d";
    assert.equal(
      sourceLink({ url: "https://github.com/anthropics/knowledge-work-plugins", path: "design", sha }),
      `https://github.com/anthropics/knowledge-work-plugins/tree/${sha}/design`,
    );
    assert.equal(
      sourceLink({ url: "https://github.com/acme/linter.git", sha }),
      `https://github.com/acme/linter/tree/${sha}`,
    );
    assert.equal(
      sourceLink({ url: "https://github.com/anthropics/claude-plugins-official", path: "plugins/x" }),
      "https://github.com/anthropics/claude-plugins-official/tree/HEAD/plugins/x",
    );
    assert.equal(sourceLink({ url: "https://gitlab.com/a/b.git" }), "https://gitlab.com/a/b");
    assert.equal(sourceLink({ url: "file:///tmp/x" }), null);
    assert.equal(sourceLink({}), null);
  });

  it("names the vendor from what the listing tells", () => {
    assert.equal(
      vendorOf(
        plugin("x", { source: { url: "https://github.com/anthropics/claude-plugins-official", path: "plugins/x" } }),
      ),
      "Anthropic",
    );
    assert.equal(
      vendorOf(plugin("y", { source: { url: "https://github.com/42Crunch-AI/claude-plugins.git" } })),
      "42Crunch-AI",
    );
    assert.equal(vendorOf(plugin("z")), null);
  });

  it("shortens descriptions to one line", () => {
    assert.equal(oneLiner("First line\nSecond"), "First line");
    assert.equal(oneLiner("a".repeat(200), 10), `${"a".repeat(9)}…`);
    assert.equal(oneLiner(undefined), "");
  });

  it("lists this workspace's installs first and counts the updates it can apply", () => {
    const installed: InstalledPlugin[] = [
      {
        id: "zeta@claude-plugins-official",
        scope: "user",
        enabled: true,
        here: false,
        update: { to: "2", reviewed: null },
      },
      {
        id: "alpha@claude-plugins-official",
        scope: "project",
        enabled: true,
        here: true,
        update: { to: "2", reviewed: null },
      },
      { id: "gone@elsewhere", scope: "local", enabled: false, here: true },
    ];
    const rows = installedRows(installed, list);
    assert.deepEqual(
      rows.map((r) => [r.installed.id, r.plugin?.name ?? null]),
      [
        ["alpha@claude-plugins-official", "alpha"],
        ["gone@elsewhere", null],
        ["zeta@claude-plugins-official", "zeta"],
      ],
    );
    assert.equal(updateCount(installed), 1);
  });
});
