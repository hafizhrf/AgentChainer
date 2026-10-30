import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskContract } from "@agentchainer/protocol";
import { approveBlocker, checkLabel, checkOptions, contractChanged, signalLabel, tidyContract } from "./taskForm.ts";

const contract: TaskContract = {
  task: "Fix total()",
  objective: "Totals count quantity.",
  acceptanceCriteria: [
    { id: "c1", text: "total multiplies", check: "gate:test" },
    { id: "c2", text: "reviewed", check: "review" },
  ],
  constraints: ["Keep cents"],
  outOfScope: [],
  risks: [],
  affectedAreas: ["src/cart.js"],
  openQuestions: [],
};

describe("task form", () => {
  it("offers only the gates the workspace has commands for", () => {
    const options = checkOptions(["test"]);
    assert.equal(options.find((o) => o.value === "gate:test")?.disabled, undefined);
    assert.equal(options.find((o) => o.value === "gate:lint")?.disabled, true);
    assert.ok(options.some((o) => o.value === "manual"));
    assert.equal(checkLabel("gate:typecheck"), "Gate: Typecheck");
  });

  it("names triage signals in sentence case", () => {
    assert.equal(signalLabel("risk-keywords"), "Risk keywords");
    assert.equal(signalLabel("repo-size"), "Repository size");
    assert.equal(signalLabel("some-new-signal"), "Some new signal");
  });

  it("tidies the form: trims, drops blank rows and duplicates, numbers criteria again", () => {
    const tidy = tidyContract({
      ...contract,
      objective: "  x ",
      acceptanceCriteria: [
        { id: "c1", text: " ", check: "manual" },
        { id: "c2", text: " b ", check: "review" },
      ],
      risks: ["a", " a ", ""],
    });
    assert.equal(tidy.objective, "x");
    assert.deepEqual(tidy.acceptanceCriteria, [{ id: "c1", text: "b", check: "review" }]);
    assert.deepEqual(tidy.risks, ["a"]);
  });

  it("marks the triage stale only for real changes", () => {
    assert.equal(contractChanged({ ...contract, risks: ["  "], constraints: [" Keep cents "] }, contract), false);
    assert.equal(contractChanged({ ...contract, approvedAt: "2026-10-30" }, contract), false);
    assert.equal(contractChanged({ ...contract, risks: ["Rounding"] }, contract), true);
    const recheck = contract.acceptanceCriteria.map((c) => ({ ...c, check: "manual" as const }));
    assert.equal(contractChanged({ ...contract, acceptanceCriteria: recheck }, contract), true);
  });

  it("says what blocks approval", () => {
    const ok = { edited: contract, stale: false, tier: "S" as const, proposed: "S" as const, reason: "", budget: "1" };
    assert.equal(approveBlocker(ok), null);
    assert.match(approveBlocker({ ...ok, stale: true }) ?? "", /triage again/);
    assert.match(approveBlocker({ ...ok, edited: { ...contract, objective: " " } }) ?? "", /objective/);
    assert.match(approveBlocker({ ...ok, edited: { ...contract, acceptanceCriteria: [] } }) ?? "", /criterion/);
    assert.match(approveBlocker({ ...ok, tier: "M" }) ?? "", /why M rather than S/);
    assert.equal(approveBlocker({ ...ok, tier: "M", reason: "Touches two modules" }), null);
    assert.match(approveBlocker({ ...ok, budget: "0" }) ?? "", /budget/);
    assert.match(approveBlocker({ ...ok, budget: "abc" }) ?? "", /budget/);
  });
});
