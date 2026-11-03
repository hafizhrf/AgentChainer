import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { generatePrompt, generateWorkflow } from "./generate-workflow.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";

const library = LibrarySchema.parse(shipped);
const m = readFileSync(new URL("../../../../catalog/workflows/m.yaml", import.meta.url), "utf8");

/** A stand-in model: each call answers with the next scripted YAML, and records its prompt and options. */
function scripted(answers: string[]) {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const sdk = {
    query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
      calls.push({ prompt, options });
      const yaml = answers[calls.length - 1] ?? "";
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.03,
          structured_output: { yaml, summary: "Adds a test planner before the change." },
        };
      })();
    },
  } as unknown as AgentSdkModule;
  return { sdk, calls };
}

describe("workflows made by AI (UX-14)", () => {
  it("keeps a valid answer, with no tools, isolated, in one call", async () => {
    const { sdk, calls } = scripted([m]);
    const r = await generateWorkflow(sdk, "claude", "/w", "M", m, { description: "add a test planner" }, library);
    assert.equal(r.error, undefined);
    assert.equal(r.yaml, m);
    assert.equal(r.costUsd, 0.03);
    assert.deepEqual([calls.length, calls[0]?.options.tools, calls[0]?.options.settingSources], [1, [], []]);
    assert.match(calls[0]?.prompt ?? "", /What the person wants: add a test planner/);
  });

  it("asks once more with the checks' errors, then keeps the fixed answer", async () => {
    const broken = m.replace("role: architect", "role: wizard");
    const { sdk, calls } = scripted([broken, m]);
    const r = await generateWorkflow(sdk, "claude", "/w", "M", m, { description: "x" }, library);
    assert.equal(r.yaml, m);
    assert.equal(r.costUsd, 0.06);
    assert.match(calls[1]?.prompt ?? "", /Your last answer was refused[\s\S]*wizard/);
  });

  it("gives up after the second answer fails too, and says why", async () => {
    const broken = m.replace("tier: M", "tier: S");
    const { sdk } = scripted([broken, broken]);
    const r = await generateWorkflow(sdk, "claude", "/w", "M", m, { description: "x" }, library);
    assert.equal(r.yaml, null);
    assert.match(r.error ?? "", /didn't pass the checks/);
  });

  it("writes a task's flow from its contract, keeping the tier's where the task doesn't call for more", () => {
    const p = generatePrompt("M", m, {
      contract: {
        task: "Rotate the API keys",
        objective: "Keys rotate monthly.",
        acceptanceCriteria: [],
        constraints: [],
        outOfScope: [],
        risks: ["Leaked keys"],
        affectedAreas: [],
        openQuestions: [],
      },
    });
    assert.match(p, /Design the flow for this one task/);
    assert.match(p, /"objective":"Keys rotate monthly\."/);
  });
});
