import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SUBTASKS, normalizeSplit } from "./split.ts";

const contract = (objective: string) => ({
  objective,
  acceptanceCriteria: [{ text: `${objective} works`, check: "gate:test" }],
  constraints: [],
  outOfScope: [],
  risks: [],
  affectedAreas: ["src/cart.js"],
  openQuestions: [],
});

describe("the XL split", () => {
  it("keeps titled sub-tasks, with their own contracts and a tier of S, M or L", () => {
    const out = normalizeSplit(
      {
        subtasks: [
          { title: " Fix total() ", request: "Count quantity", tier: "S", dependsOn: [], contract: contract("Totals") },
          { title: "", request: "dropped", tier: "S", dependsOn: [], contract: contract("x") },
          { title: "Add coupons", request: "", tier: "XL", dependsOn: [1], contract: contract("Coupons") },
        ],
      },
      ["test"],
    );
    assert.deepEqual(
      out.map((s) => [s.title, s.request, s.tier, s.dependsOn]),
      [
        ["Fix total()", "Count quantity", "S", []],
        ["Add coupons", "Add coupons", "M", [0]],
      ],
    );
    assert.equal(out[1]?.contract.task, "Add coupons");
    assert.deepEqual(out[0]?.contract.acceptanceCriteria, [{ id: "c1", text: "Totals works", check: "gate:test" }]);
  });

  it("only lets a sub-task depend on earlier ones that were kept, so there are no cycles", () => {
    const out = normalizeSplit(
      {
        subtasks: [
          { title: "A", request: "a", tier: "S", dependsOn: [2, 1, 0], contract: contract("A") },
          { title: "", request: "b", tier: "S", dependsOn: [], contract: contract("B") },
          { title: "C", request: "c", tier: "S", dependsOn: [2, 1, 1, 3, 9, 1.5], contract: contract("C") },
        ],
      },
      [],
    );
    assert.deepEqual(
      out.map((s) => s.dependsOn),
      [[], [0]],
      "A can't depend on itself or later ones; C's link to the dropped B goes",
    );
    assert.equal(out[0]?.contract.acceptanceCriteria[0]?.check, "manual", "no test gate here");
  });

  it("caps the number of sub-tasks and reads nonsense as nothing", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `T${i}`,
      request: "r",
      tier: "S",
      dependsOn: [],
      contract: contract("x"),
    }));
    assert.equal(normalizeSplit({ subtasks: many }, []).length, MAX_SUBTASKS);
    assert.deepEqual(normalizeSplit(null, []), []);
    assert.deepEqual(normalizeSplit({ subtasks: "no" }, []), []);
  });
});
