import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { RpcErrorCode } from "@agentchainer/protocol";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { approveTask, cancelTask, draftTask, newTask, retriageTask, reviseTask } from "./service.ts";
import { listTasks, loadTask } from "./store.ts";

const DRAFT = {
  objective: "Totals count quantity.",
  acceptanceCriteria: [{ text: "total() multiplies price by quantity", check: "gate:test" }],
  constraints: ["Keep cents"],
  outOfScope: [],
  risks: [],
  affectedAreas: ["src/cart.js", "test/cart.test.js"],
  openQuestions: [],
};

/** A stand-in SDK: drafting sessions get `DRAFT`, haiku classifications get tier `tier`. */
function fakeSdk(tier = "S") {
  const calls: string[] = [];
  const sdk = {
    query: ({ options }: { options: { model?: string } }) => {
      const classify = options.model === "haiku";
      calls.push(classify ? "classify" : "draft");
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: classify ? 0.002 : 0.1,
          result: "",
          structured_output: classify ? { tier, rationale: "Small fix.", confidence: "high" } : DRAFT,
        };
      })();
    },
  } as unknown as AgentSdkModule;
  return { claude: { sdk, claudePath: "claude" }, calls };
}

describe("task flow", () => {
  after(removeFixtureCopies);

  it("drafts, triages on the draft, and approves the contract and tier together", async () => {
    const root = copyFixture("sample-app");
    assert.throws(() => newTask(root, "   "), /Describe the task/);
    const created = newTask(root, " Fix total() ");
    assert.equal(created.request, "Fix total()");
    assert.deepEqual(created.availableGates, ["test"]);

    const { claude, calls } = fakeSdk("S");
    const drafted = await draftTask(root, created.id, claude, "sonnet");
    assert.deepEqual(calls, ["draft", "classify"]);
    assert.equal(drafted.contract?.objective, "Totals count quantity.");
    assert.deepEqual([drafted.triage?.proposed, drafted.triage?.budgetUsd], ["S", 1]);
    assert.equal(Math.round(drafted.costUsd * 1000), 102);
    const contract = drafted.contract;
    assert.ok(contract);

    assert.throws(
      () => approveTask(root, created.id, { ...contract, objective: "Edited" }, "S", undefined, 1),
      /changed after triage/,
    );
    assert.throws(() => approveTask(root, created.id, contract, "M", " ", 3), /rather than the proposed S/);
    const approved = approveTask(root, created.id, contract, "M", "It touches tests too", 3);
    assert.equal(approved.state, "ready");
    assert.ok(approved.contract?.approvedAt);
    assert.deepEqual([approved.triage?.chosen, approved.triage?.override?.reason], ["M", "It touches tests too"]);
    assert.deepEqual(loadTask(root, created.id), approved);
    await assert.rejects(draftTask(root, created.id, claude), /Revise it/);

    // Revised without edits, it can be approved again as is; the proposal needs no reason.
    const revised = reviseTask(root, created.id);
    assert.equal(revised.state, "draft");
    assert.equal(revised.contract?.approvedAt, undefined);
    const again = approveTask(root, created.id, contract, "S", undefined, 1);
    assert.equal(again.triage?.override, undefined);

    assert.deepEqual(
      listTasks(root).map((t) => [t.state, t.tier]),
      [["ready", "S"]],
    );
    // Only AgentChainer's .gitignore shows up in git; the task files are ignored.
    assert.equal(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }),
      "?? .agentchainer/.gitignore\n",
    );
  });

  it("re-triages an edited draft and saves it normalized", async () => {
    const root = copyFixture("sample-app");
    const task = newTask(root, "Fix total()");
    const { claude } = fakeSdk("S");
    const drafted = await draftTask(root, task.id, claude);
    const contract = drafted.contract;
    assert.ok(contract);
    const edited = {
      ...contract,
      risks: ["Callers handle auth tokens"],
      affectedAreas: [...contract.affectedAreas, " "],
    };
    const next = await retriageTask(root, task.id, edited, fakeSdk("S").claude);
    assert.deepEqual(next.contract?.risks, ["Callers handle auth tokens"]);
    assert.deepEqual(next.contract?.affectedAreas, ["src/cart.js", "test/cart.test.js"]);
    // The model said S, but a risk keyword sets an L floor.
    assert.deepEqual([next.triage?.model?.tier, next.triage?.floor, next.triage?.proposed], ["S", "L", "L"]);
  });

  it("cancels a draft in progress", async () => {
    const root = copyFixture("sample-app");
    const task = newTask(root, "Fix total()");
    const sdk = {
      query: ({ options }: { options: { abortController?: AbortController } }) =>
        (async function* () {
          await new Promise((_, reject) =>
            options.abortController?.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          );
          yield undefined;
        })(),
    } as unknown as AgentSdkModule;
    const running = draftTask(root, task.id, { sdk, claudePath: "claude" });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(draftTask(root, task.id, { sdk, claudePath: "claude" }), /already working/);
    assert.equal(cancelTask(task.id), true);
    await assert.rejects(running, (err: { code?: number }) => err.code === RpcErrorCode.cancelled);
    assert.equal(cancelTask(task.id), false);
    assert.equal(loadTask(root, task.id).contract, null);
  });
});
