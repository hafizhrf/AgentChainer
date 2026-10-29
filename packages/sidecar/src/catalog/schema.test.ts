import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Catalog, catalogProblems, type Item } from "./schema.ts";

/** Install-step rules beyond the schema (M2-15): binaries, private registration, pins, secrets. */

const base: Item = {
  id: "x",
  name: "X",
  kind: "mcp",
  tier: "verified-vendor",
  license: "MIT",
  summary: "",
  why: "",
  source: {
    type: "release-asset",
    repo: "https://example.com/x",
    version: "1.0.0",
    assets: { "linux-x64": { url: "https://example.com/x.tar.gz", sha256: "0".repeat(64) } },
  },
  platforms: ["linux"],
  requires: [],
  risk: "low",
  permissions: [],
  secrets: [],
  install: {
    scope: "local",
    steps: [{ "download-binary": { binary: "x" } }, { "mcp-add": { name: "x", command: ["{binary}"] } }],
  },
  reviews: [],
};
const problems = (item: Item) => catalogProblems({ version: "2026.10.29", items: [item], profiles: [] } as Catalog);

describe("install step rules", () => {
  it("accepts a downloaded binary registered as a local MCP server", () => {
    assert.deepEqual(problems(base), []);
  });

  it("requires local scope for a server that runs a downloaded binary", () => {
    assert.match(problems({ ...base, install: { ...base.install, scope: "project" } }).join(), /must use local scope/);
  });

  it("ties downloads and {binary} to release assets", () => {
    assert.match(
      problems({ ...base, install: { ...base.install, steps: base.install.steps.slice(1) } }).join(),
      /exactly one download-binary/,
    );
    const npm: Item = {
      ...base,
      source: { type: "npm", name: "@x/mcp", version: "1.0.0", integrity: "sha512-x" },
    };
    assert.match(problems(npm).join(), /download-binary needs a release-asset source/);
    assert.match(problems(npm).join(), /\{binary\} needs a release-asset source/);
  });

  it("keeps npm steps on the pinned version", () => {
    const npm = (arg: string): Item => ({
      ...base,
      source: { type: "npm", name: "@x/mcp", version: "1.0.0", integrity: "sha512-x" },
      install: {
        scope: "project",
        steps: [{ "merge-json": { path: ".mcp.json", value: { mcpServers: { x: { command: "npx", args: [arg] } } } } }],
      },
    });
    assert.deepEqual(problems(npm("@x/mcp@1.0.0")), []);
    assert.match(problems(npm("@x/mcp@latest")).join(), /pinned version/);
  });

  it("allows only declared secrets as env var references", () => {
    const withEnv = (secrets: string[]): Item => ({
      ...base,
      secrets,
      install: {
        ...base.install,
        steps: [
          { "download-binary": { binary: "x" } },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal env var reference, as items write them.
          { "mcp-add": { name: "x", command: ["{binary}", "--token", "${API_TOKEN}"] } },
        ],
      },
    });
    assert.deepEqual(problems(withEnv(["API_TOKEN"])), []);
    assert.match(problems(withEnv([])).join(), /API_TOKEN\} isn't one of its declared secrets/);
  });
});
