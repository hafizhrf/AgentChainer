import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanAction } from "@agentchainer/protocol";
import { autoApplicable } from "./auto-apply.ts";

/** What opt-in auto-apply may apply without a preview (M2-18, M2-03). */

const action = (over: Partial<PlanAction>): PlanAction => ({
  id: "item:x",
  kind: "catalog",
  title: "X",
  why: "",
  risk: "low",
  scope: "project",
  permissions: [],
  secrets: [],
  preview: { type: "note", text: "" },
  state: "recommended",
  selected: true,
  ...over,
});

describe("autoApplicable", () => {
  it("allows recommended, pre-selected first-party and official items", () => {
    assert.equal(autoApplicable(action({ tier: "first-party" })), true);
    assert.equal(autoApplicable(action({ tier: "official" })), true);
  });

  it("never applies vendor or community items, unselected or unavailable ones", () => {
    assert.equal(autoApplicable(action({ tier: "verified-vendor" })), false);
    assert.equal(autoApplicable(action({ tier: "community" })), false);
    assert.equal(autoApplicable(action({ tier: "official", selected: false })), false);
    assert.equal(autoApplicable(action({ tier: "official", state: "optional" })), false);
    assert.equal(autoApplicable(action({ tier: "official", state: "unavailable" })), false);
  });

  it("allows only the fixes that add lines, and never generators", () => {
    assert.equal(autoApplicable(action({ id: "fix:fix-gitignore", kind: "fix" })), true);
    assert.equal(autoApplicable(action({ id: "fix:link-agents-md", kind: "fix" })), true);
    for (const id of ["fix:untrack-env", "fix:git-init", "fix:stop-tests"]) {
      assert.equal(autoApplicable(action({ id, kind: "fix" })), false, id);
    }
    assert.equal(autoApplicable(action({ id: "gen:generate-claude-md", kind: "generator" })), false);
  });
});
