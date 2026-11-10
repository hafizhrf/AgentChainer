import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { readDefaults, writeDefaults } from "./defaults.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const root = () => {
  const r = mkdtempSync(path.join(tmpdir(), "ac-agents-"));
  roots.push(r);
  return r;
};

describe("a workspace's default agents (M9-06)", () => {
  it("has none until they're saved, keeps them out of git, and drops Claude as the default it already is", () => {
    const r = root();
    assert.deepEqual(readDefaults(r), {});
    assert.deepEqual(writeDefaults(r, { plan: "claude", implement: "codex", review: "agy" }), {
      implement: "codex",
      review: "agy",
    });
    assert.deepEqual(readDefaults(r), { implement: "codex", review: "agy" });
    assert.match(readFileSync(path.join(r, ".agentchainer", ".gitignore"), "utf8"), /^agents\.json$/m);
  });

  it("reads a broken or hand-edited file as no defaults", () => {
    const r = root();
    writeDefaults(r, {});
    writeFileSync(path.join(r, ".agentchainer", "agents.json"), '{"implement":"gpt"}');
    assert.deepEqual(readDefaults(r), {});
    writeFileSync(path.join(r, ".agentchainer", "agents.json"), "not json");
    assert.deepEqual(readDefaults(r), {});
  });
});
