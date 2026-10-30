import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { WorkspaceProfile } from "@agentchainer/protocol";
import { detectWorkspace } from "../detect/detect.ts";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { availableGates, cleanArea, draftContract, normalizeContract } from "./contract.ts";

const profile = (commands: string[]): WorkspaceProfile => ({
  stacks: ["node"],
  monorepo: null,
  packages: [
    {
      path: ".",
      stack: "node",
      packageManager: "npm",
      frameworks: [],
      testFrameworks: [],
      commands: Object.fromEntries(commands.map((k) => [k, { run: `npm run ${k}`, source: "x", confidence: "high" }])),
    },
  ],
  ci: [],
});

describe("contract normalization", () => {
  it("lists the gates the profile has commands for", () => {
    assert.deepEqual(availableGates(profile(["test", "lint", "install", "dev"])), ["lint", "test"]);
    assert.deepEqual(availableGates(profile([])), []);
  });

  it("numbers criteria and turns a check that can't be proved into manual", () => {
    const c = normalizeContract(
      "Fix it",
      {
        objective: "  Fixed.  ",
        acceptanceCriteria: [
          { text: "tests pass", check: "gate:test" },
          { text: "", check: "review" },
          { text: "types pass", check: "gate:typecheck" },
          { text: "looks right", check: "eyeball" },
          { text: "reviewed", check: "review" },
          { text: "no check" },
        ],
      },
      ["test"],
    );
    assert.equal(c.task, "Fix it");
    assert.equal(c.objective, "Fixed.");
    assert.deepEqual(
      c.acceptanceCriteria.map((x) => [x.id, x.check]),
      [
        ["c1", "gate:test"],
        ["c2", "manual"],
        ["c3", "manual"],
        ["c4", "review"],
        ["c5", "manual"],
      ],
    );
  });

  it("keeps areas inside the workspace, and trims, dedupes and caps lists", () => {
    const c = normalizeContract(
      "x",
      {
        affectedAreas: ["./src/a.ts", "src\\b.ts", "/etc/passwd", "../x", "C:\\x", "src/a.ts", " docs/ "],
        risks: [" a ", "a", "", 3, "b"],
        constraints: Array.from({ length: 40 }, (_, i) => `c${i}`),
      },
      [],
    );
    assert.deepEqual(c.affectedAreas, ["src/a.ts", "src/b.ts", "docs/"]);
    assert.deepEqual(c.risks, ["a", "b"]);
    assert.equal(c.constraints.length, 30);
    assert.equal(cleanArea("a/../../b"), null);
  });

  it("survives garbage", () => {
    const c = normalizeContract("x", null, []);
    assert.deepEqual([c.objective, c.acceptanceCriteria, c.affectedAreas], ["", [], []]);
  });
});

describe("drafting", () => {
  after(removeFixtureCopies);

  it("runs read-only, isolated, and leaves the workspace as it was", async () => {
    const root = copyFixture("sample-app");
    let seen: Record<string, unknown> = {};
    const sdk = {
      query: ({ options }: { options: Record<string, unknown> }) => {
        seen = options;
        return (async function* () {
          // A session that changed a file anyway: the workspace guard must undo it.
          writeFileSync(join(root, "src", "cart.js"), "// changed\n");
          writeFileSync(join(root, "stray.txt"), "x");
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: 0.08,
            result: "",
            structured_output: {
              objective: "Totals count quantity.",
              acceptanceCriteria: [{ text: "total multiplies", check: "gate:test" }],
              constraints: [],
              outOfScope: [],
              risks: [],
              affectedAreas: ["src/cart.js"],
              openQuestions: [],
            },
          };
        })();
      },
    } as unknown as AgentSdkModule;
    const r = await draftContract(sdk, "claude", root, "Fix total", detectWorkspace(root), { model: "sonnet" });
    assert.equal(r.costUsd, 0.08);
    assert.deepEqual(r.contract?.acceptanceCriteria, [{ id: "c1", text: "total multiplies", check: "gate:test" }]);
    assert.deepEqual(seen.tools, ["Read", "Grep", "Glob"]);
    assert.deepEqual(seen.settingSources, []);
    assert.equal(seen.model, "sonnet");
    assert.equal(seen.persistSession, false);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
    assert.ok(!existsSync(join(root, "stray.txt")));
  });

  it("returns the error and the cost when the session stops", async () => {
    const root = copyFixture("sample-app");
    const sdk = {
      query: () =>
        (async function* () {
          yield { type: "result", subtype: "error_max_budget_usd", total_cost_usd: 0.5 };
        })(),
    } as unknown as AgentSdkModule;
    const r = await draftContract(sdk, "claude", root, "x", detectWorkspace(root));
    assert.deepEqual([r.contract, r.costUsd], [null, 0.5]);
    assert.match(r.error ?? "", /error_max_budget_usd/);
  });
});
