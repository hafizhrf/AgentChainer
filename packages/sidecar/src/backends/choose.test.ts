import assert from "node:assert/strict";
import { describe, it } from "node:test";
import shipped from "../tasks/library.json" with { type: "json" };
import { LibrarySchema } from "../tasks/library.ts";
import { agentFor, agentsNeeded, roleOf, rolesOf } from "./choose.ts";

const library = LibrarySchema.parse(shipped);
const tier = (t: "S" | "M" | "L") => {
  const w = library.workflows[t];
  if (!w) throw new Error(`no ${t} workflow`);
  return w;
};

describe("choosing a step's agent (M9-06)", () => {
  it("gives each step a role by what it does", () => {
    assert.equal(roleOf({ access: "write" }), "implement");
    assert.equal(roleOf({ access: "read", output: "review" }), "review");
    assert.equal(roleOf({ access: "read", output: "plan" }), "plan");
    assert.equal(roleOf({ access: "read" }), "plan");
  });

  it("lets a step's own agent win, then the task's for its role, then Claude", () => {
    const write = { access: "write" as const };
    assert.equal(agentFor(write), "claude");
    assert.equal(agentFor(write, { implement: "codex" }), "codex");
    assert.equal(agentFor({ ...write, agent: "agy" as const }, { implement: "codex" }), "agy");
    assert.equal(agentFor({ access: "read", output: "review" }, { implement: "codex" }), "claude");
  });

  it("lists the roles a tier has, and the agents a run needs besides Claude", () => {
    assert.deepEqual(rolesOf(tier("S")), ["implement"]);
    assert.deepEqual(rolesOf(tier("M")), ["plan", "implement", "review"]);
    // L's planners run side by side: one role.
    assert.deepEqual(rolesOf(tier("L")), ["plan", "implement", "review"]);
    assert.deepEqual(agentsNeeded(tier("M")), []);
    // Claude plans and implements, agy reviews: only agy needs to be there.
    assert.deepEqual(agentsNeeded(tier("M"), { review: "agy" }), ["agy"]);
    assert.deepEqual(agentsNeeded(tier("L"), { plan: "codex", review: "agy" }), ["agy", "codex"]);
  });
});
