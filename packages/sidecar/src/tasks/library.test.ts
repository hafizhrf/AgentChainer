import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import shipped from "./library.json" with { type: "json" };
import { buildLibrary, isGates, LibrarySchema, libraryJsonText, parseRoleFile, WorkflowSchema } from "./library.ts";
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
    assert.deepEqual(Object.keys(lib.workflows).sort(), ["M", "S"]);
    const m = lib.workflows.M;
    assert.ok(m);
    assert.deepEqual(
      m.steps.map((s) => s.id),
      ["plan", "implement", "gates", "review"],
    );
    const review = m.steps.find((s) => s.id === "review");
    assert.ok(review && !isGates(review));
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
