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
import { RpcErrorCode, resultEnglish, resultText, setLanguage } from "@agentchainer/protocol";
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
  ciLog,
  cleanupTask,
  createTaskPr,
  deleteTaskSafe,
  draftTask,
  dropFlow,
  fixCiTask,
  mergeGates,
  mergePrTask,
  mergeResult,
  messageRun,
  newTask,
  overlapsOf,
  prBody,
  proposeFlow,
  prPreview,
  prStatus,
  readyBranch,
  retriageTask,
  reviseTask,
  shortTitle,
  splitTask,
  startTask,
  taskBranch,
  taskEvidence,
  taskWorkflow,
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
    return { root, bare, gh, prs, calls, checks };
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
