import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { bumpItemYaml, catalogVersion, compareVersions, newestEligible, rewriteAssetUrl } from "./updates.ts";

/** The upstream-update bot's choices (M2-04). */

describe("versions", () => {
  it("compares dotted versions numerically, with prereleases first", () => {
    assert.ok(compareVersions("1.7.12", "1.7.9") > 0);
    assert.ok(compareVersions("v0.12.0", "0.11.0") > 0);
    assert.ok(compareVersions("0.0.83", "0.0.83") === 0);
    assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  });

  it("picks the newest stable release that is at least two weeks old", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const candidates = [
      { version: "0.12.1", publishedAt: "2026-10-16T23:35:48Z" },
      { version: "0.12.0", publishedAt: "2026-10-12T22:08:18Z" },
      { version: "0.13.0-rc.1", publishedAt: "2026-09-01T00:00:00Z" },
      { version: "0.11.0", publishedAt: "2026-09-15T23:40:39Z" },
    ];
    assert.equal(newestEligible(candidates, "0.11.0", now)?.version, "0.12.0");
    assert.equal(newestEligible(candidates, "0.12.0", now), null, "0.12.1 is too new");
    assert.equal(newestEligible(candidates, "0.12.1", now), null, "nothing newer");
  });
});

describe("item edits", () => {
  it("rewrites the version in a release asset URL", () => {
    assert.equal(
      rewriteAssetUrl(
        "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz",
        "8.30.1",
        "8.31.0",
      ),
      "https://github.com/gitleaks/gitleaks/releases/download/v8.31.0/gitleaks_8.31.0_darwin_arm64.tar.gz",
    );
  });

  it("bumps fields, clears reviews, and keeps comments", () => {
    const before = `# Seed item (docs/CATALOG.md §6).
id: demo
source:
  type: npm
  name: "@x/mcp"
  version: "1.0.0" # pinned
reviews:
  - { by: a, date: "2026-10-01", ref: "1.0.0" }
`;
    const after = bumpItemYaml(`${before}notes: kept\n`, [[["source", "version"], "1.1.0"]]);
    assert.equal(
      after,
      `${before.replace('"1.0.0" # pinned', '"1.1.0" # pinned').replace(/reviews:\n.*\n/, "reviews: []\n")}notes: kept\n`,
      "only the bumped value and the reviews change",
    );
    assert.match(after, /^# Seed item/);
    assert.match(after, /# pinned/);
    const doc = parse(after);
    assert.equal(doc.source.version, "1.1.0");
    assert.deepEqual(doc.reviews, []);
  });

  it("dates the catalog version without padding", () => {
    assert.equal(catalogVersion(new Date("2026-11-05T12:00:00Z")), "2026.11.5");
  });
});
