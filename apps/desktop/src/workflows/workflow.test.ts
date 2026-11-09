import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setLanguage } from "@agentchainer/protocol";
import { freshId, insertAt, moveAt, readWorkflow, removeAt, setAt } from "./workflowDoc.ts";
import { workflowGraph } from "./workflowGraph.ts";

const S = `# Our S: tests only.
id: tier-s
tier: S
version: 2
description: Implement, then run the tests.
steps:
  # The one writer.
  - id: implement
    label: Implement
    role: implementer
    access: write
    inputs: [contract]
    limits: { maxTurns: 40, maxBudgetUsd: 1 }
  - id: gates
    label: Gates
    gates: [test]
    fix: { step: implement, maxRounds: 1, maxBudgetUsd: 0.5 } # one round is enough
`;

const L = `id: tier-l
tier: L
version: 1
description: Plan in parallel, implement, gates.
steps:
  - id: plan
    label: Planning
    output: plan
    parallel:
      - { id: architecture, label: Architecture, role: architect, access: read, inputs: [contract], limits: { maxTurns: 30, maxBudgetUsd: 1 } }
      - { id: security, label: Security, role: security-reviewer, access: read, inputs: [contract], limits: { maxTurns: 30, maxBudgetUsd: 1 } }
  - id: implement
    label: Implement
    role: implementer
    access: write
    inputs: [contract, plan]
    limits: { maxTurns: 60, maxBudgetUsd: 2 }
  - id: gates
    label: Gates
    gates: [lint, test]
    fix: { step: implement, maxRounds: 2, maxBudgetUsd: 1 }
`;

describe("editing a workflow's YAML in place (M6-04)", () => {
  it("changes one value and keeps the comments and the one-line maps", () => {
    const out = setAt(S, ["steps", 0, "limits", "maxBudgetUsd"], 2);
    assert.match(out, /^# Our S: tests only\./);
    assert.match(out, /# The one writer\./);
    assert.match(out, /# one round is enough/);
    assert.match(out, /limits: \{ maxTurns: 40, maxBudgetUsd: 2 \}/);
    assert.equal(readWorkflow(out).data?.version, 2);
  });

  it("writes new lists on one line, and removes a key with undefined", () => {
    const out = setAt(setAt(S, ["steps", 1, "gates"], ["lint", "test"]), ["steps", 0, "fresh"], true);
    assert.match(out, /gates: \[ lint, test \]|gates: \[lint, test\]/);
    assert.match(out, /fresh: true/);
    assert.doesNotMatch(setAt(out, ["steps", 0, "fresh"], undefined), /fresh/);
  });

  it("adds, moves and removes steps, comments travelling with them", () => {
    const step = {
      id: "docs",
      label: "Docs",
      role: "docs-writer",
      access: "write",
      inputs: ["contract", "diff"],
      limits: { maxTurns: 20, maxBudgetUsd: 0.5 },
    };
    const added = insertAt(S, ["steps"], 1, step);
    const ids = (t: string) => ((readWorkflow(t).data?.steps ?? []) as { id: string }[]).map((s) => s.id);
    assert.deepEqual(ids(added), ["implement", "docs", "gates"]);
    assert.match(added, /inputs: \[ contract, diff \]|inputs: \[contract, diff\]/);
    const moved = moveAt(added, ["steps"], 0, 1);
    assert.deepEqual(ids(moved), ["docs", "implement", "gates"]);
    assert.ok(moved.indexOf("# The one writer.") > moved.indexOf("id: docs"), "the comment moves with its step");
    assert.deepEqual(ids(moveAt(moved, ["steps"], 0, -1)), ["docs", "implement", "gates"], "no move past the top");
    assert.deepEqual(ids(removeAt(moved, ["steps"], 0)), ["implement", "gates"]);
  });

  it("refuses to edit YAML that doesn't parse, and names fresh ids", () => {
    assert.throws(() => setAt("steps: [\n", ["id"], "x"), /Fix the YAML first/);
    assert.ok(readWorkflow("steps: [\n").yamlError);
    const data = readWorkflow(L).data;
    assert.equal(freshId(data, "review"), "review");
    assert.equal(freshId(data, "security"), "security-2", "group members count");
  });
});

describe("a workflow as a graph (M6-04)", () => {
  it("draws S top to bottom with the fix going back to the implementer", () => {
    const g = workflowGraph(readWorkflow(S).data);
    assert.deepEqual(
      g.nodes.map((n) => [n.id, n.kind, n.label]),
      [
        ["steps.0", "agent", "Implement"],
        ["steps.1", "gates", "Gates"],
      ],
    );
    assert.deepEqual(
      g.edges.map((e) => [e.source, e.target, e.kind, e.label]),
      [
        ["steps.0", "steps.1", "next", undefined],
        ["steps.1", "steps.0", "fix", "fix ×1"],
      ],
    );
    assert.equal(g.nodes[1]?.detail, "test");
  });

  it("puts a group's members side by side, each joined to the next step", () => {
    const g = workflowGraph(readWorkflow(L).data);
    const kinds = g.nodes.map((n) => [n.id, n.kind]);
    assert.deepEqual(kinds.slice(0, 3), [
      ["steps.0", "group"],
      ["steps.0.parallel.0", "member"],
      ["steps.0.parallel.1", "member"],
    ]);
    const [a, b] = g.nodes.filter((n) => n.kind === "member");
    assert.equal(a?.y, b?.y);
    assert.ok((a?.x ?? 0) < (b?.x ?? 0));
    assert.deepEqual(
      g.edges.filter((e) => e.kind === "next" && e.target === "steps.1").map((e) => e.source),
      ["steps.0.parallel.0", "steps.0.parallel.1"],
    );
  });

  it("draws XL as its split, the sub-tasks and the integration gates", () => {
    const xl = readWorkflow(
      "id: tier-xl\ntier: XL\nversion: 1\ndescription: x\nsplit: { id: split, label: Split, role: architect, access: read, inputs: [contract], limits: { maxTurns: 20, maxBudgetUsd: 1 } }\nmaxParallel: 2\nintegration: { gates: [test, build] }\n",
    ).data;
    const g = workflowGraph(xl);
    assert.deepEqual(
      g.nodes.map((n) => [n.id, n.kind, n.detail]),
      [
        ["split", "split", "architect · read · $1"],
        ["maxParallel", "subtasks", "each with its tier's workflow · 2 at once"],
        ["integration", "integration", "test, build"],
      ],
    );
  });

  it("draws nothing for text that isn't a workflow yet", () => {
    assert.deepEqual(workflowGraph(null), { nodes: [], edges: [] });
  });
});

describe("a workflow's own translation on the canvas (X-13)", () => {
  it("shows the labels the YAML translates in the app's language, and the labels as written otherwise", async () => {
    const yaml = `${S}\ni18n:\n  id:\n    description: Satu agent.\n    labels:\n      implement: Implementasi\n`;
    const labels = () => workflowGraph(readWorkflow(yaml).data).nodes.map((n) => n.label);
    assert.equal(labels()[0], "Implement");
    await setLanguage("id");
    try {
      assert.equal(labels()[0], "Implementasi");
      assert.equal(labels()[1], workflowGraph(readWorkflow(S).data).nodes[1]?.label, "a step it doesn't translate");
    } finally {
      await setLanguage("en");
    }
  });
});
