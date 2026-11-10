import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSION_MODES } from "@agentchainer/protocol";
import { agentModes, fitMode } from "./options.ts";

describe("the permission modes a chat on each agent has (M9-09)", () => {
  it("offers Claude every mode, Codex all but plan, and agy only Standard and Plan", () => {
    assert.deepEqual(agentModes("claude"), PERMISSION_MODES);
    assert.deepEqual(agentModes(undefined), PERMISSION_MODES);
    assert.equal(agentModes("codex").includes("plan"), false);
    assert.deepEqual(agentModes("agy"), ["acceptEdits", "plan"]);
  });

  it("keeps a mode the agent has, and otherwise picks the nearest it has", () => {
    assert.equal(fitMode("claude", "plan"), "plan");
    assert.equal(fitMode("codex", "plan"), "default");
    assert.equal(fitMode("codex", "auto"), "auto");
    assert.equal(fitMode("agy", "default"), "acceptEdits");
    assert.equal(fitMode("agy", "auto"), "acceptEdits");
    assert.equal(fitMode("agy", "plan"), "plan");
  });
});
