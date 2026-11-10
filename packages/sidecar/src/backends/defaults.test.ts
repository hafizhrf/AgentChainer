import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  budgetFor,
  defaultsView,
  readDefaults,
  readWorkspaceDefaults,
  setAppDefaults,
  writeDefaults,
  writeWorkspaceDefaults,
} from "./defaults.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
afterEach(() => setAppDefaults({}));
const root = () => {
  const r = mkdtempSync(path.join(tmpdir(), "ac-agents-"));
  roots.push(r);
  return r;
};

describe("a workspace's task defaults (M9-06, app-wide defaults)", () => {
  it("has none until they're saved, keeps them out of git, and keeps an explicit Claude", () => {
    const r = root();
    assert.deepEqual(readDefaults(r), {});
    assert.deepEqual(writeDefaults(r, { plan: "claude", implement: "codex", review: "agy" }), {
      plan: "claude",
      implement: "codex",
      review: "agy",
    });
    assert.deepEqual(readDefaults(r), { plan: "claude", implement: "codex", review: "agy" });
    assert.match(readFileSync(path.join(r, ".agentchainer", ".gitignore"), "utf8"), /^defaults\.json$/m);
  });

  it("reads a broken or hand-edited file as no defaults, and an older agents.json until it saves", () => {
    const r = root();
    mkdirSync(path.join(r, ".agentchainer"), { recursive: true });
    writeFileSync(path.join(r, ".agentchainer", "agents.json"), '{"implement":"codex"}');
    assert.deepEqual(readWorkspaceDefaults(r), { agents: { implement: "codex" } });
    writeFileSync(path.join(r, ".agentchainer", "defaults.json"), '{"agents":{"implement":"gpt"}}');
    assert.deepEqual(readWorkspaceDefaults(r), {});
    writeFileSync(path.join(r, ".agentchainer", "defaults.json"), "not json");
    assert.deepEqual(readWorkspaceDefaults(r), {});
  });

  it("puts the workspace's values over the app's, field by field, and falls back to the built-in budget", () => {
    const r = root();
    setAppDefaults({
      agents: { implement: "codex", review: "agy" },
      model: "sonnet",
      permissionMode: "acceptEdits",
      budgetUsd: { S: 2, M: null },
    });
    writeWorkspaceDefaults(r, { agents: { review: "claude" }, budgetUsd: { S: 0.5 } });
    const view = defaultsView(r);
    assert.deepEqual(view.effective, {
      agents: { implement: "codex", review: "claude" },
      model: "sonnet",
      permissionMode: "acceptEdits",
      budgetUsd: { S: 0.5, M: null },
    });
    assert.deepEqual(readDefaults(r), { implement: "codex", review: "claude" });
    assert.equal(budgetFor(r, "S", 1), 0.5);
    assert.equal(budgetFor(r, "M", 3), null, "the app's 'no budget'");
    assert.equal(budgetFor(r, "L", 8), 8, "nobody set L: the built-in one");
  });

  it("follows the app again once its own defaults are cleared", () => {
    const r = root();
    setAppDefaults({ model: "haiku" });
    writeWorkspaceDefaults(r, { model: "opus" });
    assert.equal(defaultsView(r).effective.model, "opus");
    assert.deepEqual(writeWorkspaceDefaults(r, {}), {});
    assert.equal(defaultsView(r).effective.model, "haiku");
  });
});
