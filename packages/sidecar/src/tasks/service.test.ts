import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcErrorCode, resultEnglish, resultText, setLanguage, type Task } from "@agentchainer/protocol";
import { writeDefaults } from "../backends/defaults.ts";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import type { Gh, GhResult } from "../github.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { normalizeContract } from "./contract.ts";
import { branchFolders } from "./folders.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun } from "./orchestrator.ts";
import { result } from "./result.ts";
import {
  acceptRisk,
  approveSubtasks,
  approveTask,
  cancelTask,
  changesOf,
  ciLog,
  cleanupTask,
  createTaskPr,
  deleteTaskSafe,
  draftTask,
  dropFlow,
  feedbackTask,
  fixCiTask,
  fixReviewComments,
  keepVariant,
  mergeGates,
  mergePrTask,
  mergeResult,
  messageRun,
  newTask,
  overlapsOf,
  prBody,
  proposeFlow,
  prPreview,
  prReviewThreads,
  prStatus,
  readyBranch,
  retriageTask,
  reviseTask,
  runningTask,
  runVariants,
  settleFeedback,
  shortTitle,
  splitTask,
  startTask,
  stopVariants,
  taskBranch,
  taskEvidence,
  taskFileDiff,
  taskWorkflow,
  threadComment,
  variantSummaries,
} from "./service.ts";
import { createTask, listTasks, loadTask, readTaskFile, saveTask, writeTaskFile } from "./store.ts";
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
    assert.equal(
      newTask(copyFixture("sample-app"), "From a chat", "  you: hi  ").chatContext,
      "you: hi",
      "the chat it came from is kept",
    );
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

  it("keeps the person's answers to the drafter's questions, and tells a redraft about them (UX-24)", async () => {
    const root = copyFixture("sample-app");
    const task = newTask(root, "Add discounts");
    const prompts: string[] = [];
    const question = { questions: [{ question: "Which discounts?", header: "Discounts", options: [] }] };
    const sdk = {
      query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
        const classify = options.model === "haiku";
        if (!classify) prompts.push(prompt);
        const canUseTool = options.canUseTool as (
          tool: string,
          input: unknown,
          o: { signal: AbortSignal },
        ) => Promise<unknown>;
        return (async function* () {
          if (!classify) await canUseTool("AskUserQuestion", question, { signal: new AbortController().signal });
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: classify ? 0.002 : 0.1,
            result: "",
            structured_output: classify ? { tier: "S", rationale: "Small.", confidence: "high" } : DRAFT,
          };
        })();
      },
    } as unknown as AgentSdkModule;
    const claude = { sdk, claudePath: "claude" };
    const drafted = await draftTask(root, task.id, claude, undefined, {
      ask: async () => ({ "Which discounts?": "Percent off" }),
    });
    assert.deepEqual(
      drafted.clarifications?.map(({ question, answer }) => [question, answer]),
      [["Which discounts?", "Percent off"]],
    );
    assert.deepEqual(loadTask(root, task.id).clarifications, drafted.clarifications);
    // A redraft is told what's settled; a question it asks anyway and the person skips adds nothing.
    const again = await draftTask(root, task.id, claude, undefined, { ask: async () => null }, "Also fixed amounts");
    assert.match(prompts[1] ?? "", /Already settled with the person[^\n]*\n- Which discounts\? → Percent off/);
    assert.equal(again.clarifications?.length, 1);
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

  it("shows the report in the app's language, while evidence.md and the PR body stay English (X-13)", async () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Fix total()");
    const workflow = LibrarySchema.parse(shipped).workflows.S;
    if (!workflow) throw new Error("no S workflow");
    const run = newRun(workflow, { permissionMode: "default", base: null, untrackedAtStart: [] }, new Date());
    saveTask(root, {
      ...created,
      state: "failed",
      updatedAt: "2026-10-30T01:00:00.000Z",
      run: { ...run, outcome: "X." },
    });
    const { markdown: english, path } = taskEvidence(root, created.id);
    await setLanguage("id");
    try {
      const shown = taskEvidence(root, created.id).markdown;
      assert.match(shown, /^# Bukti task: Fix total\(\)\n/);
      assert.match(shown, /- \*\*Hasil:\*\* \*\*Gagal\.\*\* X\./);
      assert.equal(readFileSync(path, "utf8"), english);
      const body = prBody(root, loadTask(root, created.id));
      assert.match(body, /## Evidence\n\n- \*\*Request:\*\* Fix total\(\)/);
      assert.doesNotMatch(body, /Permintaan|Hasil/);
      // A report written before its prose had refs is shown as it was written.
      const json = join(root, ".agentchainer", "tasks", created.id, "evidence.json");
      const { refs: _, ...old } = JSON.parse(readFileSync(json, "utf8"));
      writeFileSync(json, JSON.stringify(old));
      assert.equal(taskEvidence(root, created.id).markdown, english);
    } finally {
      await setLanguage("en");
    }
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

  it("keeps the reasons the split gives through approval, shown in the app's language (X-13)", async () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Coupons");
    saveTask(root, { ...approvedXl(created), id: created.id });
    const subtask = { title: "Fix total()", request: "Fix total()", tier: "M", dependsOn: [], contract: DRAFT };
    const sdk = {
      query: () =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: 0,
            result: "",
            structured_output: { subtasks: [subtask] },
          };
        })(),
    } as unknown as AgentSdkModule;
    const split = await splitTask(root, created.id, { sdk, claudePath: "claude" });
    const child = loadTask(root, split.subtasks?.[0] ?? "");
    if (!child.triage?.model?.rationaleRef) throw new Error("no rationale ref");
    assert.equal(resultEnglish(child.triage.model.rationaleRef), "Proposed by the split.");
    // A sub-task proposed as XL runs as L, with the split's reason; approving it as drafted keeps the reason's ref.
    const reason = result("triage.split.overrideReason");
    const override = { reason: reason.text, reasonRef: reason.ref };
    saveTask(root, { ...child, triage: { ...child.triage, proposed: "XL", chosen: "L", override } });
    approveSubtasks(root, created.id);
    const approved = loadTask(root, child.id);
    assert.equal(approved.state, "ready");
    assert.deepEqual(approved.triage?.override, override);
    await setLanguage("id");
    try {
      assert.equal(resultText(reason.ref), "Sub-task berjalan sebagai S, M, atau L.");
      assert.equal(resultText(child.triage.model.rationaleRef), "Diusulkan oleh pemecahan task.");
    } finally {
      await setLanguage("en");
    }
    // A reason the person writes is theirs: it has no ref.
    reviseTask(root, child.id);
    const own = approveTask(root, child.id, approved.contract ?? DRAFT_CONTRACT, "M", "Smaller than it looks", 3);
    assert.deepEqual(own.triage?.override, { reason: "Smaller than it looks" });
  });

  it("loads a task recorded before its results had refs, as written (X-13)", () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Coupons");
    const workflow = LibrarySchema.parse(shipped).workflows.S;
    if (!workflow) throw new Error("no S workflow");
    const at = "2026-10-30T00:00:00.000Z";
    const run = {
      ...newRun(workflow, { permissionMode: "default", base: null, untrackedAtStart: [] }, new Date(at)),
      outcome: "Every gate passed after the last change.",
      steps: [
        {
          id: "baseline",
          step: "baseline",
          label: "Gates before the task",
          kind: "baseline" as const,
          status: "done" as const,
          startedAt: at,
          costUsd: 0,
          note: "All passed.",
        },
      ],
    };
    const triage = {
      signals: [{ signal: "tests", detail: "No test command detected.", floor: null }],
      floor: "S" as const,
      model: null,
      modelError: "The classification ended without a result.",
      proposed: "XL" as const,
      chosen: "L" as const,
      override: { reason: "Sub-tasks run as S, M or L." },
      budgetUsd: 5,
      at,
    };
    saveTask(root, { ...created, state: "done", contract: DRAFT_CONTRACT, triage, run });
    const dir = join(root, ".agentchainer", "tasks", created.id);
    for (const file of ["task.json", "triage.json"]) {
      assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /Ref"/, `${file} has no refs`);
    }
    const loaded = loadTask(root, created.id);
    assert.deepEqual(loaded.run, run);
    assert.deepEqual(loaded.triage, triage);
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

describe("a branch for every task (M5-01)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd,
      encoding: "utf8",
    });
  /** An approved M task with its own worktree, ended Done. */
  const doneM = (root: string, request: string) => {
    // The app commits as the user; CI machines have no global identity, so the repository gets one.
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@example.invalid");
    const approved = approvedXl(newTask(root, request));
    if (!approved.triage) throw new Error("no triage");
    const { task } = taskBranch(root, { ...approved, triage: { ...approved.triage, chosen: "M" } });
    const created = approved;
    const wt = task.worktree;
    if (!wt) throw new Error("no worktree");
    const workflow = LibrarySchema.parse(shipped).workflows.M;
    if (!workflow) throw new Error("no M workflow");
    saveTask(root, {
      ...task,
      state: "done",
      run: newRun(workflow, { permissionMode: "default", base: wt.base, untrackedAtStart: wt.untracked }, new Date()),
    });
    return { id: created.id, wt: wt.path };
  };

  it("gives a task its own worktree on agentchainer/<id> from HEAD, once", () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Coupons");
    const head = git(root, "rev-parse", "HEAD").trim();
    const first = taskBranch(root, created);
    assert.equal(first.fresh, true);
    assert.deepEqual(
      [first.task.worktree?.branch, first.task.worktree?.base, existsSync(first.task.worktree?.path ?? "")],
      [branchOf(created.id), head, true],
    );
    const again = taskBranch(root, first.task);
    assert.equal(again.fresh, false, "a re-run keeps its worktree");
    assert.equal(again.task.worktree?.path, first.task.worktree?.path);
  });

  it("notes the task's branch, and that the workspace's uncommitted changes aren't on it (X-13)", async () => {
    // No install command, so nothing runs in the worktree.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-branch-")));
    try {
      git(root, "init", "-q", "-b", "main");
      writeFileSync(join(root, "README.md"), "# Coupons\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");
      const { task } = taskBranch(root, newTask(root, "Coupons"));
      const signal = new AbortController().signal;
      const branch = branchOf(task.id);
      assert.deepEqual(await readyBranch(root, task, signal), { ok: true, note: branch }, "a branch name as it is");
      writeFileSync(join(root, "README.md"), "# Coupons, edited\n");
      const r = await readyBranch(root, task, signal);
      assert.equal(r.note, `${branch}; your uncommitted changes in the workspace aren't on this branch`);
      assert.ok(r.noteRef);
      assert.equal(resultEnglish(r.noteRef), r.note);
      await setLanguage("id");
      try {
        assert.equal(
          resultText(r.noteRef),
          `${branch}; perubahan Anda yang belum di-commit di workspace tidak ada di branch ini`,
        );
      } finally {
        await setLanguage("en");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs in the workspace when it has no git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-nogit-"));
    try {
      const created = newTask(dir, "Coupons");
      const r = taskBranch(dir, created);
      assert.deepEqual([r.fresh, r.task.worktree], [false, undefined]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commits what an M task's run left in its worktree, then merges its branch", () => {
    const root = copyFixture("sample-app");
    const { id, wt } = doneM(root, "Coupons");
    writeFileSync(join(wt, "coupon.js"), "export const coupon = 1;\n");
    const merged = mergeResult(root, id);
    assert.deepEqual(merged, { merged: true, conflicts: [], into: "main" });
    assert.equal(readFileSync(join(root, "coupon.js"), "utf8"), "export const coupon = 1;\n");
    assert.match(git(root, "log", "-2", "--format=%s", branchOf(id)), /^Totals count quantity$/m);
    cleanupTask(root, id, false);
    assert.equal(existsSync(wt), false);
    assert.equal(loadTask(root, id).worktree?.removed, true);
  });

  it("keeps a run's uncommitted work on its branch when its worktree is cleaned up", () => {
    const root = copyFixture("sample-app");
    const { id, wt } = doneM(root, "Coupons");
    writeFileSync(join(wt, "coupon.js"), "export const coupon = 1;\n");
    cleanupTask(root, id, false);
    assert.equal(existsSync(wt), false);
    assert.equal(git(root, "show", `${branchOf(id)}:coupon.js`), "export const coupon = 1;\n");
  });

  it("warns when two live tasks change the same files", () => {
    const root = copyFixture("sample-app");
    const a = doneM(root, "Coupons");
    const b = doneM(root, "Discounts");
    const c = doneM(root, "Docs");
    writeFileSync(join(a.wt, "README.md"), "a\n");
    writeFileSync(join(a.wt, "a-only.js"), "1\n");
    writeFileSync(join(b.wt, "README.md"), "b\n");
    writeFileSync(join(c.wt, "other.md"), "c\n");
    assert.deepEqual(overlapsOf(root, a.id), [{ taskId: b.id, title: "Totals count quantity.", files: ["README.md"] }]);
    assert.deepEqual(overlapsOf(root, c.id), []);
  });
});

describe("pull requests (M5-02)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd,
      encoding: "utf8",
    });
  const URL = "https://github.com/acme/app.git";

  /**
   * A workspace whose origin is on GitHub for `gh`, while pushes go to a local bare repository, and a `gh` stand-in
   * that knows the PRs it made.
   */
  const world = () => {
    const root = copyFixture("sample-app");
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@example.invalid");
    const bare = mkdtempSync(join(tmpdir(), "ac-origin-"));
    git(bare, "init", "-q", "--bare");
    git(root, "remote", "add", "origin", URL);
    git(root, "config", `url.${bare}.pushInsteadOf`, URL);
    const prs = new Map<string, { number: number; base: string; title: string; body: string; draft: boolean }>();
    const calls: string[][] = [];
    const checks: { name: string; workflow: string; state: string; bucket: string; link: string }[] = [];
    /** The PR's review threads, as GitHub's GraphQL answer lists them (CP-07). */
    const threads: Record<string, unknown>[] = [];
    const out = (stdout: string, status = 0): GhResult => ({ status, stdout, stderr: "" });
    const gh: Gh = async (args) => {
      calls.push(args);
      if (args[0] === "--version") return out("gh version 2.103.3 (2026-10-26)\n");
      if (args[0] === "auth") return out("");
      const [cmd, sub] = args;
      if (cmd === "pr" && sub === "view") {
        // By branch, or by number.
        const head = [...prs].find(([b, p]) => b === args[2] || String(p.number) === args[2])?.[0] ?? "";
        const pr = prs.get(head);
        if (!pr) return out("", 1);
        const sha = git(bare, "rev-parse", head).trim();
        return out(
          JSON.stringify({
            number: pr.number,
            url: `https://github.com/acme/app/pull/${pr.number}`,
            isDraft: pr.draft,
            headRefOid: sha,
            baseRefName: pr.base,
            headRefName: head,
            state: "OPEN",
          }),
        );
      }
      if (cmd === "repo" && sub === "view") {
        return out(
          JSON.stringify({
            mergeCommitAllowed: true,
            squashMergeAllowed: true,
            rebaseMergeAllowed: false,
            viewerDefaultMergeMethod: "SQUASH",
          }),
        );
      }
      if (cmd === "pr" && (sub === "ready" || sub === "merge")) return out("");
      if (cmd === "pr" && sub === "checks")
        return out(JSON.stringify(checks), checks.some((c) => c.bucket === "fail") ? 1 : 0);
      if (cmd === "run" && sub === "view") return out("test  ✖ total counts quantity\n");
      if (cmd === "api" && sub === "graphql") {
        const reviewThreads = { totalCount: threads.length, nodes: threads };
        return out(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads } } } }));
      }
      if (cmd === "pr" && sub === "create") {
        const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
        prs.set(flag("--head"), {
          number: prs.size + 7,
          base: flag("--base"),
          title: flag("--title"),
          body: readFileSync(flag("--body-file"), "utf8"),
          draft: args.includes("--draft"),
        });
        return out("https://github.com/acme/app/pull/7\n");
      }
      return out("", 1);
    };
    return { root, bare, gh, prs, calls, checks, threads };
  };

  /** A done M task with a change in its worktree. */
  const doneWithChange = (root: string) => {
    const approved = approvedXl(newTask(root, "Coupons"));
    if (!approved.triage) throw new Error("no triage");
    const { task } = taskBranch(root, { ...approved, triage: { ...approved.triage, chosen: "M" } });
    const wt = task.worktree;
    if (!wt) throw new Error("no worktree");
    const workflow = LibrarySchema.parse(shipped).workflows.M;
    if (!workflow) throw new Error("no M workflow");
    saveTask(root, {
      ...task,
      state: "done",
      run: newRun(workflow, { permissionMode: "default", base: wt.base, untrackedAtStart: wt.untracked }, new Date()),
    });
    writeFileSync(join(wt.path, "coupon.js"), "export const coupon = 1;\n");
    return { id: task.id, wt };
  };

  it("previews the PR without sending anything: base, head, title, and a body from the contract and the evidence", async () => {
    const { root, gh, calls } = world();
    const { id, wt } = doneWithChange(root);
    const p = await prPreview(root, id, gh);
    assert.deepEqual([p.github.state, p.base, p.head, p.title], ["ready", "main", wt.branch, "Totals count quantity"]);
    assert.match(p.body, /## Contract[\s\S]*\*\*Objective:\*\* Totals count quantity\.[\s\S]*## Evidence/);
    assert.match(p.body, /Opened from AgentChainer task `[^`]+`\.$/);
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "create"), "nothing was created");
  });

  it("commits, pushes the task's branch without force, opens a draft PR, and records it", async () => {
    const { root, bare, gh, prs, calls } = world();
    const { id, wt } = doneWithChange(root);
    const t = await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh, new Date("2026-11-01T12:00:00Z"));
    assert.equal(git(bare, "show", `${wt.branch}:coupon.js`), "export const coupon = 1;\n", "pushed with the work");
    const made = prs.get(wt.branch);
    assert.deepEqual([made?.base, made?.title, made?.draft], ["main", "Add coupons", true]);
    assert.match(made?.body ?? "", /## Contract/);
    assert.deepEqual(
      [t.pr?.number, t.pr?.base, t.pr?.head, t.pr?.draft, t.pr?.headSha],
      [7, "main", wt.branch, true, git(bare, "rev-parse", wt.branch).trim()],
    );
    assert.ok(!calls.flat().some((a) => /force|--show-token/.test(a)));

    // Again: the open PR is picked up, not made twice.
    const again = await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    assert.equal(again.pr?.number, 7);
    assert.equal(prs.size, 1);
  });

  it("titles a PR and its commit with the objective's first sentence, at most 72 characters", () => {
    assert.equal(shortTitle("Totals count quantity."), "Totals count quantity");
    assert.equal(shortTitle("Fix totals. Then also do more."), "Fix totals");
    const long = shortTitle(
      "Fix total() in src/cart.js so each item contributes price times quantity (in cents) instead of price alone",
    );
    assert.ok(long.length <= 72 && long.endsWith("…"), long);
    assert.equal(long, "Fix total() in src/cart.js so each item contributes price times…");
  });

  it("reads only the PR's own checks' logs, and starts Fix CI only on a failing check, at most 3 times", async () => {
    const { root, gh, checks } = world();
    const { id } = doneWithChange(root);
    await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    const job = "https://github.com/acme/app/actions/runs/1/job/2";
    checks.push({ name: "test", workflow: "test", state: "SUCCESS", bucket: "pass", link: job });
    assert.equal((await prStatus(root, id, gh)).checks.length, 1);
    await assert.rejects(
      ciLog(root, id, "https://github.com/acme/app/actions/runs/9/job/9", gh),
      /isn't one of the PR's/,
    );
    assert.match(await ciLog(root, id, job, gh), /total counts quantity/);
    const host = {} as Parameters<typeof fixCiTask>[3];
    await assert.rejects(
      fixCiTask(root, id, job, host, gh, () => undefined),
      /isn't failing/,
    );
    const t = loadTask(root, id);
    const at = "2026-11-01T00:00:00.000Z";
    const done3 = [1, 2, 3].map(() => ({ check: "test", at, state: "failed" as const }));
    saveTask(root, { ...t, pr: t.pr ? { ...t.pr, fixes: done3 } : undefined });
    checks[0] = { ...checks[0], bucket: "fail" } as (typeof checks)[number];
    await assert.rejects(
      fixCiTask(root, id, job, host, gh, () => undefined),
      /had its 3 Fix CI rounds/,
    );
  });

  it("lists a task's changes and diffs a file against its base, even after its branch committed (CP-05)", async () => {
    const { root, gh } = world();
    const { id, wt } = doneWithChange(root);
    const before = readFileSync(join(wt.path, "src", "cart.js"), "utf8");
    writeFileSync(join(wt.path, "src", "cart.js"), `${before}// cents\n`);
    // Create PR commits the worktree: HEAD moves past the task's base.
    await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    writeFileSync(join(wt.path, "src", "cart.js"), `${before}// cents, rounded\n`);
    assert.deepEqual(
      changesOf(root, id).map((f) => [f.path, f.status, f.dir]),
      [
        ["coupon.js", "new", wt.path],
        ["src/cart.js", "modified", wt.path],
      ],
    );
    const diff = taskFileDiff(root, id, { path: "src/cart.js" });
    assert.deepEqual([diff.status, diff.original, diff.modified], ["modified", before, `${before}// cents, rounded\n`]);
    assert.deepEqual(diff.hunks, []);
    const added = taskFileDiff(root, id, { path: "coupon.js" });
    assert.deepEqual([added.status, added.original], ["added", null]);
    assert.throws(() => taskFileDiff(root, id, { path: "package.json" }), /isn't among the task's changes/);
    assert.throws(() => taskFileDiff(root, id, { path: "../outside.txt" }), /isn't among the task's changes/);
    // A tampered base (a cloned repository can carry task records) never reaches git as an option.
    const file = join(root, ".agentchainer", "tasks", id, "task.json");
    const target = join(mkdtempSync(join(tmpdir(), "ac-out-")), "written");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...raw, run: { ...raw.run, base: `--output=${target}` } }));
    assert.throws(() => changesOf(root, id), /can't be read|unreadable/i);
    assert.throws(() => taskFileDiff(root, id, { path: "src/cart.js" }), /can't be read|unreadable/i);
    assert.equal(existsSync(target), false);
  });

  it("starts Fix as commented only on a finished, unmerged task, on files it changed (CP-05)", () => {
    const root = world().root;
    const { id } = doneWithChange(root);
    const host = {} as Parameters<typeof feedbackTask>[3];
    const comment = { path: "coupon.js", side: "new" as const, start: 1, end: 1, quote: "x", text: "Rename it." };
    const start = (comments = [comment]) => feedbackTask(root, id, { comments }, host, () => undefined);
    assert.throws(
      () => start([{ ...comment, path: "README.md" }]),
      /aren't among the task's changes anymore: README\.md/,
    );
    const t = loadTask(root, id);
    saveTask(root, { ...t, state: "draft" });
    assert.throws(() => start(), /works on a run that ended/);
    saveTask(root, { ...t, mergedInto: { branch: "main", at: "2026-11-11T00:00:00.000Z" } });
    assert.throws(() => start(), /merged already/);
    saveTask(root, { ...t, subtasks: ["2026-11-11-0a1b2c3d"] });
    assert.throws(() => start(), /XL tasks and their sub-tasks/);
    saveTask(root, { ...t, worktree: t.worktree ? { ...t.worktree, removed: true } : undefined });
    assert.throws(() => start(), /worktree is gone/);
  });

  it("after a round, commits and pushes to an open PR only when it ended Done, and records every round (CP-05)", async () => {
    const { root, bare, gh } = world();
    const { id, wt } = doneWithChange(root);
    // Without a PR, the round's edits stay in the worktree.
    writeFileSync(join(wt.path, "coupon.js"), "export const coupon = 2;\n");
    const round = { at: "2026-11-11T00:00:00.000Z", comments: 2, files: ["coupon.js"] };
    const local = await settleFeedback(root, id, "done", round);
    assert.deepEqual(local.run?.feedback, [{ ...round, state: "done" }]);
    assert.match(git(wt.path, "status", "--porcelain"), /coupon\.js/);

    const withPr = await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    writeFileSync(join(wt.path, "coupon.js"), "export const coupon = 3;\n");
    const failed = await settleFeedback(root, id, "failed", round);
    assert.equal(
      git(bare, "show", `${wt.branch}:coupon.js`),
      "export const coupon = 2;\n",
      "a failed round pushes nothing",
    );
    assert.equal(failed.pr?.headSha, withPr.pr?.headSha);
    const pushed = await settleFeedback(root, id, "done", round);
    assert.equal(git(bare, "show", `${wt.branch}:coupon.js`), "export const coupon = 3;\n");
    assert.equal(git(bare, "log", "-1", "--format=%s", wt.branch).trim(), "Address review comments");
    assert.equal(pushed.pr?.headSha, git(bare, "rev-parse", wt.branch).trim());
    assert.deepEqual(
      pushed.run?.feedback?.map((f) => f.state),
      ["done", "failed", "done"],
    );
  });

  /** A review thread as GitHub's GraphQL answer has it (CP-07). */
  const reviewThread = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: "coupon.js",
    line: 1,
    startLine: null,
    originalLine: 1,
    originalStartLine: null,
    diffSide: "RIGHT",
    subjectType: "LINE",
    comments: {
      totalCount: 1,
      nodes: [
        {
          author: { login: "octocat" },
          body: "Name it COUPON.",
          createdAt: "2026-11-12T00:00:00Z",
          url: `https://github.com/acme/app/pull/7#discussion_${id}`,
          diffHunk: "@@ -0,0 +1 @@\n+export const coupon = 1;",
        },
      ],
    },
    ...over,
  });

  it("reads the PR's review threads, and sends the picked ones, read again by id, as data (CP-07)", async () => {
    const { root, gh, threads } = world();
    const { id } = doneWithChange(root);
    const host = {} as Parameters<typeof fixReviewComments>[3];
    await assert.rejects(prReviewThreads(root, id, gh), /no pull request/);
    await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    threads.push(reviewThread("PRRT_a"), reviewThread("PRRT_b", { isResolved: true }));
    const read = await prReviewThreads(root, id, gh);
    assert.deepEqual(
      read.threads.map((t) => [t.id, t.resolved, t.path, t.start, t.quote]),
      [
        ["PRRT_a", false, "coupon.js", 1, "export const coupon = 1;"],
        ["PRRT_b", true, "coupon.js", 1, "export const coupon = 1;"],
      ],
    );
    assert.deepEqual(threadComment(read.threads[0] ?? (null as never)), {
      path: "coupon.js",
      side: "new",
      start: 1,
      end: 1,
      quote: "export const coupon = 1;",
      text: "octocat: Name it COUPON.",
    });
    await assert.rejects(
      fixReviewComments(root, id, { threads: ["PRRT_gone"] }, host, gh, () => undefined),
      /isn't on the PR any more|None of those review threads/,
    );
    // The round starts on the threads asked for; with no session host it ends at once, and is recorded.
    const started = await fixReviewComments(root, id, { threads: ["PRRT_a"] }, host, gh, () => undefined);
    assert.equal(started.state, "running");
    let ended = loadTask(root, id);
    for (let i = 0; i < 100 && !ended.run?.feedback?.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ended = loadTask(root, id);
    }
    assert.deepEqual(ended.run?.feedback?.at(-1)?.source, "github");
    assert.deepEqual(ended.run?.feedback?.at(-1)?.threads, ["PRRT_a"]);
  });

  it("works out the merge gates, and merges only with a person's reason while a gate holds it back (M5-04, M5-05)", async () => {
    const { root, gh, calls, checks } = world();
    const { id } = doneWithChange(root);
    const t = await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    const sha = t.pr?.headSha ?? "";
    checks.push({
      name: "test",
      workflow: "test",
      state: "SUCCESS",
      bucket: "pass",
      link: "https://x/actions/runs/1/job/2",
    });
    const g = await mergeGates(root, id, gh);
    const by = Object.fromEntries(g.gates.map((x) => [x.id, x.state]));
    assert.deepEqual([by.local, by.review, by.ci], ["pass", "missing", "pass"]);
    assert.ok(["pass", "not-run"].includes(by.secrets ?? ""), "gitleaks when installed");
    assert.deepEqual([g.methods, g.defaultMethod, g.headSha, g.draft], [["merge", "squash"], "squash", sha, true]);

    await assert.rejects(
      mergePrTask(root, id, { method: "squash", headSha: sha }, gh),
      /held back by: Review of the PR/,
    );
    await assert.rejects(
      mergePrTask(root, id, { method: "squash", headSha: "0000000" }, gh),
      /changed since you checked/,
    );
    await assert.rejects(
      mergePrTask(root, id, { method: "rebase", headSha: sha, acceptReason: "x" }, gh),
      /doesn't allow rebase/,
    );
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "merge"), "nothing merged so far");

    const merged = await mergePrTask(
      root,
      id,
      { method: "squash", headSha: sha, acceptReason: "Reviewed by hand." },
      gh,
    );
    const ready = calls.findIndex((c) => c[0] === "pr" && c[1] === "ready");
    const merge = calls.findIndex((c) => c[0] === "pr" && c[1] === "merge");
    assert.ok(ready >= 0 && ready < merge, "a draft is marked ready first");
    assert.deepEqual(calls[merge], ["pr", "merge", "7", "--squash", "--match-head-commit", sha]);
    assert.ok(!calls.flat().includes("--auto"));
    assert.deepEqual(
      [merged.pr?.merged?.method, merged.pr?.merged?.accepted, merged.mergedInto?.branch],
      ["squash", "Reviewed by hand.", "main"],
    );
    assert.match(
      taskEvidence(root, id).markdown,
      /## Pull request[\s\S]*Merged by a person \(squash\)[\s\S]*accepted: Reviewed by hand\./,
    );
    await assert.rejects(mergePrTask(root, id, { method: "squash", headSha: sha }, gh), /merged already/);
  });

  it("shows the merge gates in the app's language, the run's outcome too when it has a ref (X-13)", async () => {
    const { root, gh, checks } = world();
    const { id } = doneWithChange(root);
    const t = await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    const run = t.run;
    if (!run) throw new Error("no run");
    checks.push({
      name: "test",
      workflow: "test",
      state: "SUCCESS",
      bucket: "pass",
      link: "https://x/actions/runs/1/job/2",
    });
    const outcome = result("run.outcome.everyGatePassed");
    saveTask(root, { ...t, run: { ...run, outcome: outcome.text, outcomeRef: outcome.ref } });
    await setLanguage("id");
    try {
      const g = await mergeGates(root, id, gh);
      const by = Object.fromEntries(g.gates.map((x) => [x.id, [x.label, x.detail]]));
      assert.deepEqual(by.local, ["Gate lokal", "Semua gate lulus setelah perubahan terakhir."]);
      assert.deepEqual(by.review, ["Tinjauan PR", "Belum ada tinjauan independen untuk PR ini."]);
      assert.deepEqual(by.ci, ["CI", "1 pemeriksaan lulus."]);
      assert.equal(by.secrets?.[0], "Secret (gitleaks)");
      // What holds Merge back is named as the gates are shown.
      await assert.rejects(mergePrTask(root, id, { method: "squash", headSha: g.headSha }, gh), /Tinjauan PR/);
      // An outcome recorded before refs is quoted as written.
      saveTask(root, { ...loadTask(root, id), run: { ...run, outcome: "Every gate passed after the last change." } });
      const older = await mergeGates(root, id, gh);
      assert.equal(older.gates.find((x) => x.id === "local")?.detail, "Every gate passed after the last change.");
    } finally {
      await setLanguage("en");
    }
  });

  it("counts the run's own review for the head it pushed", async () => {
    const { root, gh } = world();
    const { id } = doneWithChange(root);
    const t = loadTask(root, id);
    const at = "2026-11-01T00:00:00.000Z";
    if (!t.run) throw new Error("no run");
    saveTask(root, {
      ...t,
      run: {
        ...t.run,
        steps: [
          {
            id: "review",
            step: "review",
            label: "Independent review",
            kind: "agent",
            status: "done",
            startedAt: at,
            costUsd: 0,
          },
        ],
      },
    });
    writeTaskFile(root, id, "review.json", JSON.stringify({ verdict: "approve", findings: [], criteria: [] }));
    const shipped = await createTaskPr(root, id, { title: "Add coupons", draft: true }, gh);
    assert.deepEqual(
      [shipped.pr?.review?.source, shipped.pr?.review?.verdict, shipped.pr?.review?.headSha],
      ["run", "approve", shipped.pr?.headSha],
    );
    assert.equal((await mergeGates(root, id, gh)).gates.find((x) => x.id === "review")?.state, "pass");
  });

  it("refuses without gh, without changes, or before the run is Done", async () => {
    const { root, gh } = world();
    const { id } = doneWithChange(root);
    await assert.rejects(
      createTaskPr(root, id, { title: "x", draft: true }, null),
      /GitHub CLI \(gh\) isn't installed/,
    );
    const empty = doneWithChange(root);
    rmSync(join(empty.wt.path, "coupon.js"));
    await assert.rejects(createTaskPr(root, empty.id, { title: "x", draft: true }, gh), /nothing to propose/);
    saveTask(root, { ...loadTask(root, id), state: "failed" });
    await assert.rejects(createTaskPr(root, id, { title: "x", draft: true }, gh), /once the run is Done/);
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

describe("a task's agents (M9-06)", () => {
  it("doesn't start a run that names an agent this computer doesn't have", () => {
    const root = copyFixture("sample-app");
    const xl = approvedXl(newTask(root, "Fix total()"));
    if (!xl.triage) throw new Error("no triage");
    const task = { ...xl, triage: { ...xl.triage, proposed: "S" as const, chosen: "S" as const } };
    saveTask(root, task);
    // No Codex and no agy on this host.
    const host = { codex: () => null, agy: () => null } as unknown as Parameters<typeof startTask>[2];
    assert.throws(
      () =>
        startTask(root, task.id, host, { permissionMode: "default", agents: { implement: "codex" } }, () => undefined),
      /runs a step on Codex, which isn't installed/,
    );
    assert.equal(loadTask(root, task.id).state, "ready", "nothing started: no branch, no run");
    assert.ok(!loadTask(root, task.id).run);
    // The workspace's default counts too when the task chooses nothing.
    writeDefaults(root, { implement: "codex" });
    assert.throws(
      () => startTask(root, task.id, host, { permissionMode: "default" }, () => undefined),
      /runs a step on Codex, which isn't installed/,
    );
  });
});

describe("messages to a running task (UX-13)", () => {
  it("refuses a message for a task that isn't running", () => {
    assert.throws(() => messageRun("t-20261103-00000000", "hi"), /isn't running/);
  });
});

describe("a task's flow (UX-14)", () => {
  it("draws nothing before triage, then its tier's workflow: the app's, or the project's", () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Fix total()");
    assert.equal(taskWorkflow(root, created.id), null);
    const triaged = {
      ...created,
      triage: {
        signals: [],
        floor: "S" as const,
        model: null,
        proposed: "S" as const,
        chosen: "S" as const,
        budgetUsd: 1,
        at: "2026-11-03T00:00:00.000Z",
      },
    };
    saveTask(root, triaged);
    const app = taskWorkflow(root, created.id);
    assert.deepEqual([app?.source, app?.workflow.id], ["app", "tier-s"]);
    mkdirSync(join(root, ".agentchainer", "workflows"), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("../../../../catalog/workflows/s.yaml", import.meta.url)),
      join(root, ".agentchainer", "workflows", "s.yaml"),
    );
    assert.equal(taskWorkflow(root, created.id)?.source, "project");
  });

  it("keeps a flow AI proposed for the task, draws it, and drops it again", async () => {
    const root = copyFixture("sample-app");
    const created = newTask(root, "Fix total()");
    const triage = {
      signals: [],
      floor: "S" as const,
      model: null,
      proposed: "S" as const,
      chosen: "S" as const,
      budgetUsd: 1,
      at: "2026-11-03T00:00:00.000Z",
    };
    const contract = normalizeContract("Fix total()", { objective: "Totals count quantity." }, []);
    saveTask(root, { ...created, triage, contract });
    const s = readFileSync(fileURLToPath(new URL("../../../../catalog/workflows/s.yaml", import.meta.url)), "utf8");
    const sdk = {
      query: () =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: 0.04,
            structured_output: { yaml: s, summary: "As the tier's." },
          };
        })(),
    } as unknown as AgentSdkModule;
    const proposed = await proposeFlow(root, created.id, { sdk, claudePath: "claude" });
    assert.equal(proposed.flow?.summary, "As the tier's.");
    assert.match(proposed.flow?.hash ?? "", /^[0-9a-f]{12}$/);
    assert.equal(proposed.costUsd, created.costUsd + 0.04);
    assert.equal(taskWorkflow(root, created.id)?.source, "task");
    assert.equal(dropFlow(root, created.id).flow, undefined);
    assert.equal(taskWorkflow(root, created.id)?.source, "app");
  });
});

describe("a multi-folder task's pull requests (M8-01)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd,
      encoding: "utf8",
    });
  /** A repository whose GitHub origin pushes to a local bare one. */
  const origin = (dir: string, repo: string) => {
    git(dir, "config", "user.name", "t");
    git(dir, "config", "user.email", "t@example.invalid");
    const bare = mkdtempSync(join(tmpdir(), "ac-origin-"));
    git(bare, "init", "-q", "--bare");
    const url = `https://github.com/acme/${repo}.git`;
    git(dir, "remote", "add", "origin", url);
    git(dir, "config", `url.${bare}.pushInsteadOf`, url);
    return bare;
  };

  it("opens a PR in each repository the task changed, the main one linking the others, and they link back", async () => {
    const root = copyFixture("sample-app");
    origin(root, "app");
    const api = copyFixture("sample-app");
    const apiBare = origin(api, "api");
    // A `gh` stand-in that keeps PRs per repository.
    const prs = new Map<string, { number: number; url: string; base: string; body: string; cwd: string }>();
    const gh: Gh = async (args, cwd) => {
      const out = (stdout: string, status = 0): GhResult => ({ status, stdout, stderr: "" });
      const repo = cwd === api ? "api" : "app";
      const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
      if (args[0] === "--version") return out("gh version 2.103.3 (2026-10-26)\n");
      if (args[0] === "auth") return out("");
      if (args[0] === "pr" && args[1] === "view") {
        const found = [...prs].find(
          ([k, p]) => k === `${repo}|${args[2]}` || (p.cwd === cwd && String(p.number) === args[2]),
        );
        if (!found) return out("", 1);
        const [key, p] = found;
        const head = key.split("|")[1] ?? "";
        return out(
          JSON.stringify({
            number: p.number,
            url: p.url,
            isDraft: true,
            headRefOid: git(cwd, "rev-parse", head).trim(),
            baseRefName: p.base,
            headRefName: head,
            state: "OPEN",
          }),
        );
      }
      if (args[0] === "pr" && args[1] === "create") {
        const number = prs.size + 1;
        prs.set(`${repo}|${flag("--head")}`, {
          number,
          url: `https://github.com/acme/${repo}/pull/${number}`,
          base: flag("--base"),
          body: readFileSync(flag("--body-file"), "utf8"),
          cwd,
        });
        return out("");
      }
      if (args[0] === "pr" && args[1] === "edit") {
        const p = [...prs.values()].find((x) => x.cwd === cwd && String(x.number) === args[2]);
        if (p) p.body = readFileSync(flag("--body-file"), "utf8");
        return out(p ? "" : "no", p ? 0 : 1);
      }
      return out("", 1);
    };

    const approved = approvedXl(newTask(root, "Coupons", undefined, [api]));
    if (!approved.triage) throw new Error("no triage");
    const primary = taskBranch(root, { ...approved, triage: { ...approved.triage, chosen: "M" } }).task;
    const { task } = branchFolders(primary);
    const wt = task.worktree;
    const apiWt = task.folders?.[0]?.worktree;
    if (!wt || !apiWt) throw new Error("no worktrees");
    const workflow = LibrarySchema.parse(shipped).workflows.M;
    if (!workflow) throw new Error("no M workflow");
    saveTask(root, {
      ...task,
      state: "done",
      run: newRun(workflow, { permissionMode: "default", base: wt.base, untrackedAtStart: wt.untracked }, new Date()),
    });
    writeFileSync(join(wt.path, "coupon.js"), "export const coupon = 1;\n");
    writeFileSync(join(apiWt.path, "coupons-api.js"), "export const route = 1;\n");

    const preview = await prPreview(root, task.id, gh);
    assert.ok(preview.body.includes("get their own PRs, linked here"), "the preview says the api change gets a PR");
    assert.equal(prs.size, 0, "a preview opens nothing");
    const t = await createTaskPr(root, task.id, { title: "Add coupons", draft: true }, gh);
    assert.equal(git(apiBare, "show", `${apiWt.branch}:coupons-api.js`), "export const route = 1;\n", "api pushed");
    const apiPr = prs.get(`api|${apiWt.branch}`);
    const mainPr = prs.get(`app|${wt.branch}`);
    assert.ok(apiPr && mainPr);
    assert.deepEqual(t.folders?.[0]?.pr, { number: apiPr.number, url: apiPr.url, base: "main", head: apiWt.branch });
    assert.ok(mainPr.body.includes("## The task's other pull requests"), mainPr.body);
    assert.ok(mainPr.body.includes(`- \`${t.folders?.[0]?.name}\`: ${apiPr.url}`), "the main PR links the other");
    assert.ok(apiPr.body.includes(`main PR: ${mainPr.url}`), "the other PR links back");
  });
});

describe("Best-of-N (CP-06)", () => {
  after(removeFixtureCopies);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd,
      encoding: "utf8",
    });
  const S = LibrarySchema.parse(shipped).workflows.S;

  /** An approved tier-S task with a budget, ready to run. */
  function ready(root: string): Task {
    const a = approvedXl(newTask(root, "Coupons"));
    if (!a.triage) throw new Error("no triage");
    const task: Task = { ...a, triage: { ...a.triage, chosen: "S", proposed: "S", budgetUsd: 1 } };
    saveTask(root, task);
    return task;
  }

  /** A variant of `lead` that ran on `agent` and ended `state`, with a file of its own in its worktree. */
  function variant(root: string, lead: Task, index: number, agent: "claude" | "codex" | "agy"): Task {
    if (!S) throw new Error("no S workflow");
    const made = createTask(root, lead.request, lead.availableGates);
    const { task } = taskBranch(root, {
      ...made,
      contract: lead.contract,
      triage: lead.triage,
      state: "ready",
      variantOf: { id: lead.id, index, agent },
    });
    const wt = task.worktree;
    if (!wt) throw new Error("no worktree");
    writeFileSync(join(wt.path, `by-${agent}.js`), `export const by = "${agent}";\n`);
    const opts = { permissionMode: "default" as const, base: wt.base, untrackedAtStart: wt.untracked };
    const run = {
      ...newRun(S, { ...opts, agents: { implement: agent } }, new Date()),
      endedAt: new Date().toISOString(),
      costUsd: 0.1 * index,
    };
    const v: Task = { ...task, state: "done", run, costUsd: 0.1 * index };
    saveTask(root, v);
    writeTaskFile(root, v.id, "summary.md", `## Changes\n- by-${agent}.js: by ${agent}\n`);
    return v;
  }

  /** A task comparing two finished variants, Claude's and Codex's. */
  function comparing(root: string) {
    const lead = ready(root);
    const a = variant(root, lead, 1, "claude");
    const b = variant(root, lead, 2, "codex");
    const withVariants: Task = { ...lead, variants: [a.id, b.id] };
    saveTask(root, withVariants);
    return { lead: withVariants, a, b };
  }

  const near = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-9, `${x} ≈ ${y}`);

  it("hides a comparing task's variants from the list, and sums each one up", () => {
    const root = copyFixture("sample-app");
    const { lead, a, b } = comparing(root);
    const listed = listTasks(root);
    assert.deepEqual(
      listed.map((t) => [t.id, t.variants]),
      [[lead.id, [a.id, b.id]]],
    );
    const [one, two] = variantSummaries(root, lead.id);
    assert.deepEqual([one?.index, one?.agent, one?.state, one?.files, one?.added], [1, "claude", "done", 1, 1]);
    assert.deepEqual([two?.index, two?.agent], [2, "codex"]);
    near(two?.costUsd ?? 0, 0.2);
    assert.equal(overlapsOf(root, a.id).length, 0, "variants don't warn about each other");
  });

  it("keeps one: the task takes its worktree, run and files, and the others go with their branches", async () => {
    const root = copyFixture("sample-app");
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@example.invalid");
    const { lead, a, b } = comparing(root);
    // A review from an earlier run of the task: the kept variant (tier S) has none, so it must go.
    writeTaskFile(root, lead.id, "review.json", "{}");
    const kept = await keepVariant(root, lead.id, b.id);
    assert.deepEqual([kept.worktree?.path, kept.worktree?.branch], [b.worktree?.path, branchOf(b.id)]);
    assert.equal(kept.state, "done");
    assert.deepEqual(
      [kept.run?.bestOf?.chosen, kept.run?.bestOf?.compared.map((c) => c.agent)],
      [2, ["claude", "codex"]],
    );
    assert.equal(kept.variants, undefined);
    near(kept.costUsd, lead.costUsd + 0.3);
    assert.match(readTaskFile(root, lead.id, "summary.md") ?? "", /by codex/);
    assert.equal(readTaskFile(root, lead.id, "review.json"), null);
    assert.ok(existsSync(join(b.worktree?.path ?? "", "by-codex.js")), "the kept worktree stays");
    assert.equal(existsSync(a.worktree?.path ?? ""), false, "the other is removed");
    const branches = git(root, "branch", "--list");
    assert.doesNotMatch(branches, new RegExp(a.id));
    assert.match(branches, new RegExp(b.id));
    assert.throws(() => loadTask(root, a.id));
    assert.throws(() => loadTask(root, b.id));
    assert.match(taskEvidence(root, lead.id).markdown, /## Best of N[\s\S]*Variant 2 \(Codex\), kept/);
    // Keeping again finishes nothing more, and counts nothing twice.
    near((await keepVariant(root, lead.id, b.id)).costUsd, kept.costUsd);
    // It merges like any task, and its branch outlives Clean up: Run again's worktree is on it.
    assert.equal(mergeResult(root, lead.id).merged, true);
    cleanupTask(root, lead.id, false);
    assert.equal(existsSync(b.worktree?.path ?? ""), false);
    assert.equal(taskBranch(root, loadTask(root, lead.id)).task.worktree?.branch, branchOf(b.id));
  });

  it("discards every variant, and their cost stays with the task", async () => {
    const root = copyFixture("sample-app");
    const { lead, a, b } = comparing(root);
    const kept = await keepVariant(root, lead.id, null);
    assert.deepEqual([kept.variants, kept.state, kept.worktree], [undefined, "ready", undefined]);
    near(kept.costUsd, lead.costUsd + 0.3);
    for (const v of [a, b]) {
      assert.equal(existsSync(v.worktree?.path ?? ""), false);
      assert.throws(() => loadTask(root, v.id));
    }
  });

  it("removes only what a variant's own id names: a tampered record can't point elsewhere", async () => {
    const root = copyFixture("sample-app");
    const { lead, a, b } = comparing(root);
    const elsewhere = mkdtempSync(join(tmpdir(), "ac-elsewhere-"));
    writeFileSync(join(elsewhere, "keep.txt"), "x");
    if (a.worktree) saveTask(root, { ...a, worktree: { ...a.worktree, path: elsewhere } });
    await keepVariant(root, lead.id, b.id);
    assert.ok(existsSync(join(elsewhere, "keep.txt")));
  });

  it("refuses what it can't compare, and keeps a comparing task and its variants to themselves", () => {
    const root = copyFixture("sample-app");
    const host = {} as Parameters<typeof runVariants>[2];
    const two = [{ agent: "claude" as const }, { agent: "claude" as const, model: "haiku" }];
    const start = (id: string, variants: { agent: "claude" | "codex" | "agy"; model?: string }[] = two) =>
      runVariants(root, id, host, { permissionMode: "default", variants }, () => undefined);
    assert.throws(() => start(newTask(root, "x").id), /Approve the contract/);
    const unbudgeted = ready(root);
    if (unbudgeted.triage) saveTask(root, { ...unbudgeted, triage: { ...unbudgeted.triage, budgetUsd: null } });
    assert.throws(() => start(unbudgeted.id), /Set a budget first/);
    const one = ready(root);
    assert.throws(() => start(one.id, [{ agent: "claude" }]), /2 to 3 variants/);
    assert.throws(() => start(one.id, [{ agent: "codex" }, { agent: "claude" }]), /Codex, which isn't installed/);
    const branched = taskBranch(root, ready(root)).task;
    saveTask(root, branched);
    assert.throws(() => start(branched.id), /already has a worktree/);
    const { lead, a } = comparing(root);
    assert.throws(() => start(lead.id), /comparing Best-of-N variants/);
    assert.throws(() => startTask(root, lead.id, host, { permissionMode: "default" }, () => undefined), /comparing/);
    assert.throws(() => reviseTask(root, lead.id), /comparing/);
    assert.throws(() => mergeResult(root, a.id), /Best-of-N variant/);
    assert.throws(() => cleanupTask(root, a.id, false), /Best-of-N variant/);
    assert.throws(() => deleteTaskSafe(root, a.id), /discard it from its task/);
  });

  it("starts each variant as a ready copy of the task, on its own implementer", async () => {
    const root = copyFixture("sample-app");
    const lead = ready(root);
    const host = {} as Parameters<typeof runVariants>[2];
    const started = runVariants(
      root,
      lead.id,
      host,
      { permissionMode: "default", variants: [{ agent: "claude" }, { agent: "claude", model: "haiku" }] },
      () => undefined,
    );
    const ids = started.variants ?? [];
    assert.equal(ids.length, 2);
    // Stopped at once: this checks what was made, not a model's work.
    stopVariants(root, lead.id);
    for (let i = 0; i < 200 && ids.some((id) => runningTask(id)); i++) await new Promise((r) => setTimeout(r, 50));
    const [one, two] = ids.map((id) => loadTask(root, id));
    assert.deepEqual(
      [one?.variantOf, two?.variantOf],
      [
        { id: lead.id, index: 1, agent: "claude" },
        { id: lead.id, index: 2, agent: "claude", model: "haiku" },
      ],
    );
    assert.equal(one?.contract?.approvedAt, lead.contract?.approvedAt);
    assert.equal(one?.triage?.budgetUsd, 1);
    assert.equal(one?.costUsd, 0, "a variant's cost starts at nothing");
    assert.match(two?.title ?? "", /· Claude haiku$/);
    assert.deepEqual(two?.run?.models, { implement: "haiku" });
    assert.equal(two?.run?.agents?.implement, "claude");
    assert.notEqual(one?.worktree?.path, two?.worktree?.path);
    assert.deepEqual(
      listTasks(root).map((t) => t.id),
      [lead.id],
    );
  });
});
