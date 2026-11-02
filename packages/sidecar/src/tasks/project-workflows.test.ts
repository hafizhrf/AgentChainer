import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { effectiveLibrary, tierWorkflows, WORKFLOWS_DIR } from "./project-workflows.ts";
import { newTask, runWorkflow, startRun, workflowsOf } from "./service.ts";
import { readTaskFile, writeTaskFile } from "./store.ts";

const library = LibrarySchema.parse(shipped);
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  removeFixtureCopies();
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ac-workflows-"));
  dirs.push(d);
  return d;
};
const put = (root: string, name: string, text: string) => {
  mkdirSync(path.join(root, WORKFLOWS_DIR), { recursive: true });
  writeFileSync(path.join(root, WORKFLOWS_DIR, name), text);
};

/** Tier S with only the test gate: what a project might want for a quick loop. */
const QUICK_S = `# Our S: tests only.
id: tier-s
tier: S
version: 2
description: Implement, then run the tests.
steps:
  - id: implement
    label: Implement
    role: implementer
    access: write
    inputs: [contract]
    limits: { maxTurns: 40, maxBudgetUsd: 1 }
  - id: gates
    label: Gates
    gates: [test]
    fix: { step: implement, maxRounds: 1, maxBudgetUsd: 0.5 }
`;

describe("a project's own workflows (M6-04)", () => {
  it("uses the app's workflows when the project has none", () => {
    const eff = effectiveLibrary(tmp(), library);
    assert.deepEqual([eff.origins, eff.problems], [{}, []]);
    assert.deepEqual(
      tierWorkflows(eff).map((w) => [w.tier, w.source]),
      [
        ["S", "app"],
        ["M", "app"],
        ["L", "app"],
        ["XL", "app"],
      ],
    );
  });

  it("puts a valid file in place of its tier's workflow, with the file's hash", () => {
    const root = tmp();
    put(root, "s.yaml", QUICK_S);
    put(root, "notes.txt", "not a workflow");
    const eff = effectiveLibrary(root, library);
    assert.deepEqual(eff.problems, []);
    assert.equal(eff.library.workflows.S?.version, 2);
    assert.equal(eff.library.workflows.M, library.workflows.M, "other tiers stay the app's");
    assert.equal(eff.library.roles, library.roles, "roles are always the app's");
    const s = tierWorkflows(eff).find((w) => w.tier === "S");
    assert.deepEqual(
      [s?.source, s?.file, s?.steps, s?.hash?.length],
      ["project", ".agentchainer/workflows/s.yaml", 2, 12],
    );
  });

  it("doesn't use a file that fails the shipped library's checks, and says why", () => {
    const root = tmp();
    put(root, "m.yaml", QUICK_S);
    put(root, "l.yaml", "steps: [\n");
    put(
      root,
      "s.yaml",
      QUICK_S.replace("access: write\n    inputs: [contract]", "access: read\n    inputs: [contract]"),
    );
    put(root, "xl.yaml", "id: tier-xl\ntier: XL\n");
    const eff = effectiveLibrary(root, library);
    assert.deepEqual(
      eff.problems.map((p) => p.file),
      [
        ".agentchainer/workflows/l.yaml",
        ".agentchainer/workflows/m.yaml",
        ".agentchainer/workflows/s.yaml",
        ".agentchainer/workflows/xl.yaml",
      ],
    );
    const error = (name: string) => eff.problems.find((p) => p.file.endsWith(name))?.error ?? "";
    assert.match(error("l.yaml"), /not valid YAML/);
    assert.match(error("m.yaml"), /a S workflow goes in s\.yaml/);
    // A read-only implementer: the role has every tool, so "read" would mean nothing.
    assert.match(error("s.yaml"), /fix\.step must name an earlier write step|a read step's role must list tools/);
    assert.match(error("xl.yaml"), /description|split/);
    assert.deepEqual(eff.origins, {});
    assert.equal(eff.library.workflows.S, library.workflows.S);
  });

  it("refuses a review step that can write, as the shipped library does", () => {
    const root = tmp();
    put(
      root,
      "m.yaml",
      `id: tier-m
tier: M
version: 9
description: Review that writes.
steps:
  - id: implement
    label: Implement
    role: implementer
    access: write
    inputs: [contract]
    limits: { maxTurns: 40, maxBudgetUsd: 1 }
  - id: review
    label: Review
    role: independent-reviewer
    access: write
    inputs: [contract, diff]
    output: review
    limits: { maxTurns: 20, maxBudgetUsd: 1 }
`,
    );
    assert.match(effectiveLibrary(root, library).problems[0]?.error ?? "", /a review step must be read-only/);
  });

  it("runs the copy a run started with, whatever happens to the file afterwards", () => {
    const root = copyFixture("sample-app");
    put(root, "s.yaml", QUICK_S);
    const task = newTask(root, "Fix the total");
    const eff = workflowsOf(root);
    const workflow = eff.library.workflows.S;
    assert.ok(workflow);
    const run = startRun(
      root,
      task,
      workflow,
      eff,
      { permissionMode: "default", base: null, untrackedAtStart: [] },
      new Date(),
    );
    assert.deepEqual(
      [run.workflow.source, run.workflow.file, run.workflow.version],
      ["project", ".agentchainer/workflows/s.yaml", 2],
    );
    assert.ok(readTaskFile(root, task.id, "workflow.json"));
    put(root, "s.yaml", "broken: [\n");
    assert.deepEqual(
      runWorkflow(root, { ...task, run }).steps.map((s) => s.id),
      ["implement", "gates"],
    );
    writeTaskFile(root, task.id, "workflow.json", "{}");
    assert.throws(() => runWorkflow(root, { ...task, run }), /missing or damaged/);

    // The app's workflow isn't copied: a run on it finds it by id.
    const appRun = startRun(root, task, library.workflows.M ?? workflow, workflowsOf(root), run, new Date());
    assert.equal(appRun.workflow.source, undefined);
    assert.equal(runWorkflow(root, { ...task, run: appRun }).id, "tier-m");
  });
});
