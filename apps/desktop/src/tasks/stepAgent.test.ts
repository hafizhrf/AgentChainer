import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentLabel, costText } from "./stepAgent.ts";

describe("who ran a step, and what it cost (M9-07)", () => {
  it("shows Claude's model alone, and the other agents by name", () => {
    assert.equal(agentLabel("claude", "claude-haiku-5-5"), "Haiku 5.5");
    assert.equal(agentLabel(undefined, "claude-opus-5-5"), "Opus 5.5");
    assert.equal(agentLabel("codex", "gpt-6-luna"), "Codex · gpt-6-luna");
    assert.equal(agentLabel("agy", undefined), "agy");
    assert.equal(agentLabel(undefined, undefined), "");
  });

  it("keeps Claude's figure, marks an estimate, and says when a cost is unknown", () => {
    assert.deepEqual(costText("≈$0.0123", undefined, undefined), { text: "≈$0.0123" });
    const est = costText("≈$0.0084", "estimate", { input: 216_834, output: 1_304 });
    assert.equal(est.text, "≈$0.0084 est.");
    assert.match(est.title ?? "", /218,138 tokens/);
    const unknown = costText("≈$0.0000", "unknown", { input: 900, output: 100 });
    assert.equal(unknown.text, "cost unknown");
    assert.match(unknown.title ?? "", /1,000 tokens.*\$0/);
  });
});
