import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RpcErrorCode } from "@agentchainer/protocol";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { normalizeContract } from "./contract.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun } from "./orchestrator.ts";
import {
  acceptRisk,
  approveSubtasks,
  approveTask,
  cancelTask,
  cleanupTask,
  deleteTaskSafe,
  draftTask,
  mergeResult,
  newTask,
  retriageTask,
  reviseTask,
  splitTask,
  startTask,
  taskEvidence,
} from "./service.ts";
import { listTasks, loadTask, saveTask, writeTaskFile } from "./store.ts";
import { addWorktree, branchOf, worktreePath } from "./worktree.ts";

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

  it("accepts a failed run's risk with a reason, and the evidence says so", () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Fix total()");
    const workflow = LibrarySchema.parse(shipped).workflows.S;
    if (!workflow) throw new Error("no S workflow");
    assert.throws(() => acceptRisk(root, created.id, "fine"), /Only a failed or unverified run/);
    saveTask(root, {
      ...created,
      state: "failed",
      run: {
        ...newRun(workflow, { permissionMode: "default", base: null, untrackedAtStart: [] }, new Date()),
        outcome: "test was already failing before the task and still fails.",
      },
    });
    assert.throws(() => acceptRisk(root, created.id, "  "), /Say why/);
    const accepted = acceptRisk(root, created.id, "The test is the planted bug.", new Date("2026-10-30T05:00:00Z"));
    assert.equal(accepted.state, "accepted");
    assert.deepEqual(accepted.run?.acceptance, {
      reason: "The test is the planted bug.",
      at: "2026-10-30T05:00:00.000Z",
    });
    const { markdown, path } = taskEvidence(root, created.id);
    assert.ok(existsSync(path));
    assert.match(markdown, /\*\*Outcome:\*\* \*\*Accepted with risk\.\*\*/);
    assert.match(markdown, /Risk accepted\*\* by the user at 2026-10-30T05:00:00\.000Z: The test is the planted bug\./);
    assert.throws(() => acceptRisk(root, created.id, "again"), /Only a failed or unverified run/);
  });

  it("builds the report again when the task changed after it was written", () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Fix total()");
    assert.throws(() => taskEvidence(root, created.id), /written when the run ends/);
    const workflow = LibrarySchema.parse(shipped).workflows.S;
    if (!workflow) throw new Error("no S workflow");
    const run = newRun(workflow, { permissionMode: "default", base: null, untrackedAtStart: [] }, new Date());
    saveTask(root, {
      ...created,
      state: "failed",
      updatedAt: "2026-10-30T01:00:00.000Z",
      run: { ...run, outcome: "First." },
    });
    assert.match(taskEvidence(root, created.id).markdown, /First\./);
    // A newer run of the same task; the stored report is about the old one.
    saveTask(root, {
      ...created,
      state: "done",
      updatedAt: "2099-01-01T00:00:00.000Z",
      run: { ...run, outcome: "Second." },
    });
    const again = taskEvidence(root, created.id).markdown;
    assert.match(again, /Second\./);
    assert.doesNotMatch(again, /First\./);
  });

  it("splits an approved XL task into draft sub-tasks with their own triage, shown only on its page", async () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Coupons and quantities");
    const parent = { ...approvedXl(created), id: created.id };
    saveTask(root, parent);
    const sub = (title: string, tier: string, dependsOn: number[]) => ({
      title,
      request: `${title} in src/cart.js`,
      tier,
      dependsOn,
      contract: { ...DRAFT, objective: title },
    });
    const sdk = {
      query: () =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: 0.05,
            result: "",
            structured_output: { subtasks: [sub("Fix total()", "S", []), sub("Add coupons", "L", [1])] },
          };
        })(),
    } as unknown as AgentSdkModule;
    const split = await splitTask(root, created.id, { sdk, claudePath: "claude" });
    assert.equal(split.subtasks?.length, 2);
    assert.equal(split.costUsd, 0.05);
    const [first, second] = (split.subtasks ?? []).map((id) => loadTask(root, id));
    assert.ok(first && second);
    assert.deepEqual(first.parent, { id: created.id, index: 0 });
    assert.equal(first.title, "Fix total()");
    assert.equal(first.state, "draft");
    assert.equal(first.triage?.model?.rationale, "Proposed by the split.");
    assert.equal(second.triage?.chosen, "L");
    assert.equal(second.triage?.budgetUsd, 5, "capped by XL's per-sub-task budget");
    assert.deepEqual(second.dependsOn, [first.id]);
    assert.deepEqual(
      listTasks(root).map((t) => t.id),
      [created.id],
      "sub-tasks aren't in the list",
    );

    const draftFirst = loadTask(root, first.id);
    assert.ok(draftFirst.contract);
    assert.throws(
      () => approveTask(root, first.id, draftFirst.contract ?? DRAFT_CONTRACT, "XL", "too big", 5),
      /runs as S, M or L/,
    );
    approveSubtasks(root, created.id);
    assert.equal(loadTask(root, first.id).state, "ready");
    const host = {} as Parameters<typeof startTask>[2];
    assert.throws(
      () => startTask(root, first.id, host, { permissionMode: "default" }, () => undefined),
      /Sub-tasks run from their XL task/,
    );
    assert.throws(() => deleteTaskSafe(root, first.id), /delete that one instead/);
    deleteTaskSafe(root, created.id);
    assert.equal(existsSync(join(root, ".agentchainer", "tasks", first.id)), false, "deleted with its XL task");
  });

  it("merges a finished XL task's branch only into a clean tree, and cleans its worktrees up", () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Coupons");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const wt = worktreePath(root, created.id);
    addWorktree(root, wt, branchOf(created.id), head);
    writeFileSync(join(wt, "coupon.js"), "export const coupon = 1;\n");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd,
        encoding: "utf8",
      });
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "coupons");
    const workflow = LibrarySchema.parse(shipped).xl;
    if (!workflow) throw new Error("no XL workflow");
    saveTask(root, {
      ...approvedXl(created),
      state: "done",
      worktree: { path: wt, branch: branchOf(created.id), base: head, untracked: [] },
      run: newRun(workflow, { permissionMode: "default", base: head, untrackedAtStart: [] }, new Date()),
    });

    writeFileSync(join(root, "README.md"), "changed\n");
    assert.throws(() => mergeResult(root, created.id), /Commit or stash your changes first/);
    git(root, "checkout", "--", "README.md");
    const merged = mergeResult(root, created.id);
    assert.deepEqual(merged, { merged: true, conflicts: [], into: "main" });
    assert.ok(existsSync(join(root, "coupon.js")));
    assert.equal(loadTask(root, created.id).mergedInto?.branch, "main");

    cleanupTask(root, created.id, true);
    assert.equal(existsSync(wt), false);
    assert.equal(loadTask(root, created.id).worktree?.removed, true);
    assert.throws(() => git(root, "rev-parse", "--verify", branchOf(created.id)), "the branch went too");
  });
});

describe("an XL task's evidence", () => {
  after(removeFixtureCopies);

  it("gathers its sub-tasks' purposes, notes, approvals and guard blocks", () => {
    const root = copyFixture("sample-app");
    const parent = newTask(root, "Coupons and quantities");
    const child = newTask(root, "Add coupons");
    const lib = LibrarySchema.parse(shipped);
    const xl = lib.xl;
    const s = lib.workflows.S;
    if (!xl || !s) throw new Error("no workflows");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    saveTask(root, {
      ...child,
      state: "done",
      title: "Add coupons",
      parent: { id: parent.id, index: 0 },
      run: {
        ...newRun(s, { permissionMode: "default", base: head, untrackedAtStart: [] }, new Date()),
        approvals: [
          {
            stepId: "implement",
            label: "Implement",
            tool: "Bash",
            target: "npm test",
            risk: "medium",
            reasons: [],
            allowed: true,
            always: false,
            at: "2026-10-30T00:00:00.000Z",
          },
        ],
      },
    });
    writeTaskFile(
      root,
      child.id,
      "summary.md",
      "## Changes\n- src/cart.js: adds applyCoupon\n\n## Notes\n- Codes are case-sensitive.\n",
    );
    saveTask(root, {
      ...approvedXl(parent),
      state: "done",
      subtasks: [child.id],
      run: newRun(xl, { permissionMode: "default", base: head, untrackedAtStart: [] }, new Date()),
    });
    const md = taskEvidence(root, parent.id).markdown;
    assert.match(md, /- medium risk · Bash `npm test` \(Sub-task 1: Implement\): allowed once/);
    assert.match(md, /- Claude says: Sub-task 1: Codes are case-sensitive\./);
    assert.match(md, /\| 1 \| Add coupons \| – \| Done/);
  });
});

const DRAFT_CONTRACT = normalizeContract("x", DRAFT, ["test"]);

/** A task approved with tier XL, as the triage card would leave it. */
function approvedXl(task: ReturnType<typeof newTask>): ReturnType<typeof newTask> {
  return {
    ...task,
    state: "ready",
    contract: { ...normalizeContract(task.request, DRAFT, ["test"]), approvedAt: "2026-10-30T00:00:00.000Z" },
    triage: {
      signals: [],
      floor: "S",
      model: null,
      proposed: "XL",
      chosen: "XL",
      budgetUsd: 5,
      at: "2026-10-30T00:00:00.000Z",
    },
  };
}
