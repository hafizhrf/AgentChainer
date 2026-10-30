import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import shipped from "./library.json" with { type: "json" };
import {
  buildLibrary,
  isGates,
  isParallel,
  LibrarySchema,
  libraryJsonText,
  parseRoleFile,
  RoleSchema,
  renderRoleFile,
  WorkflowSchema,
} from "./library.ts";
import { readLibrarySources } from "./library-source.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const sources = readLibrarySources(repo);

describe("task library", () => {
  it("ships up to date (run: node packages/sidecar/scripts/build-catalog.ts)", () => {
    const built = buildLibrary(sources.workflows, sources.roles);
    assert.equal(libraryJsonText(built), libraryJsonText(LibrarySchema.parse(shipped)));
  });

  it("has the S and M workflows, with the gates after the write step and a fresh Opus review in M", () => {
    const lib = LibrarySchema.parse(shipped);
    assert.deepEqual(Object.keys(lib.workflows).sort(), ["L", "M", "S"]);
    const m = lib.workflows.M;
    assert.ok(m);
    assert.deepEqual(
      m.steps.map((s) => s.id),
      ["plan", "implement", "gates", "review"],
    );
    const review = m.steps.find((s) => s.id === "review");
    assert.ok(review && !isGates(review) && !isParallel(review));
    assert.equal(review.fresh, true);
    assert.equal(lib.roles[review.role]?.model, "opus");
  });

  it("rejects fixes that don't go to an earlier write step, and writing reviewers", () => {
    const base = {
      id: "tier-x",
      tier: "S",
      version: 1,
      description: "x",
    };
    const implement = {
      id: "implement",
      label: "Implement",
      role: "implementer",
      access: "write",
      inputs: ["contract"],
      limits: { maxTurns: 1, maxBudgetUsd: 1 },
    };
    const gates = (step: string) => ({
      id: "gates",
      label: "Gates",
      gates: ["test"],
      fix: { step, maxRounds: 1, maxBudgetUsd: 1 },
    });
    assert.ok(WorkflowSchema.safeParse({ ...base, steps: [implement, gates("implement")] }).success);
    assert.equal(WorkflowSchema.safeParse({ ...base, steps: [implement, gates("nope")] }).success, false);
    assert.equal(WorkflowSchema.safeParse({ ...base, steps: [gates("implement"), implement] }).success, false);
    const writingReview = { ...implement, id: "review", output: "review" };
    assert.equal(WorkflowSchema.safeParse({ ...base, steps: [implement, writingReview] }).success, false);
  });

  it("has the XL template: a read-only split, a parallel cap and the integration gates", () => {
    const xl = LibrarySchema.parse(shipped).xl;
    assert.ok(xl);
    assert.equal(xl.split.role, "architect");
    assert.equal(xl.split.access, "read");
    assert.equal(xl.maxParallel, 2);
    assert.deepEqual(xl.integration.gates, ["format", "lint", "typecheck", "test", "build", "smoke"]);
    const writing = (sources.workflows["xl.yaml"] ?? "").replace("access: read", "access: write");
    assert.throws(
      () => buildLibrary({ ...sources.workflows, "xl.yaml": writing }, sources.roles),
      /split step is read-only/,
    );
  });

  it("has L plan in parallel with three read-only planners", () => {
    const l = LibrarySchema.parse(shipped).workflows.L;
    const plan = l?.steps[0];
    assert.ok(plan && isParallel(plan));
    assert.deepEqual(
      plan.parallel.map((m) => m.role),
      ["architect", "security-reviewer", "test-planner"],
    );
  });

  it("rejects a parallel step that writes", () => {
    const writer = {
      id: "x",
      label: "X",
      role: "implementer",
      access: "write",
      inputs: [],
      limits: { maxTurns: 1, maxBudgetUsd: 1 },
    };
    const reader = { ...writer, id: "y", role: "architect", access: "read" };
    const w = { id: "tier-x", tier: "L", version: 1, description: "x" };
    const group = (members: unknown[]) => ({ id: "plan", label: "Plan", output: "plan", parallel: members });
    assert.ok(WorkflowSchema.safeParse({ ...w, steps: [group([reader, { ...reader, id: "z" }])] }).success);
    assert.equal(WorkflowSchema.safeParse({ ...w, steps: [group([reader, writer])] }).success, false);
  });

  it("writes each role back exactly as its file (what Install roles copies)", () => {
    for (const [file, text] of Object.entries(sources.roles)) {
      assert.equal(renderRoleFile(RoleSchema.parse(parseRoleFile(text))), text, file);
    }
  });

  it("reads role files and checks read steps use read-only roles", () => {
    assert.deepEqual(parseRoleFile("---\nname: ac-x\nmodel: opus\n---\n\nBody\n"), {
      name: "ac-x",
      model: "opus",
      prompt: "Body",
    });
    assert.throws(() => parseRoleFile("no frontmatter"), /frontmatter/);
    const roles = { ...sources.roles, "ac-architect.md": sources.roles["ac-architect.md"]?.replace(/tools:.*\n/, "") };
    assert.throws(() => buildLibrary(sources.workflows, roles as Record<string, string>), /read step's role/);
    assert.throws(
      () => buildLibrary({ "s.yaml": sources.workflows["m.yaml"] ?? "" }, sources.roles),
      /name it <tier>\.yaml/,
    );
  });
});
