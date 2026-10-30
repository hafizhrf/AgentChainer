import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ApprovalRecord, GuardBlock, Task } from "@agentchainer/protocol";
import type { AgentSdkModule } from "../sdk-loader.ts";
import type { Session } from "../session.ts";
import shipped from "./library.json" with { type: "json" };
import { LibrarySchema } from "./library.ts";
import { newRun } from "./orchestrator.ts";
import { fileStats, sessionRunner, startBase, taskDiff } from "./runner.ts";

describe("a run's base and diff", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-diff-")));
  after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: root,
      encoding: "utf8",
    });

  it("counts only what changed after the start: not the user's uncommitted edits or untracked files", () => {
    writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    // The user's own work in progress, before the task starts.
    writeFileSync(join(root, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "notes.txt"), "mine\n");

    const { base, untrackedAtStart } = startBase(root);
    assert.ok(base);
    assert.notEqual(base, g("rev-parse", "HEAD").trim(), "a snapshot of the dirty tree, not HEAD");
    assert.deepEqual(untrackedAtStart, ["notes.txt"]);
    assert.equal(g("status", "--porcelain"), " M app.ts\n?? notes.txt\n", "taking the base changes nothing");

    // The task's changes.
    writeFileSync(join(root, "app.ts"), "export const a = 3;\n");
    writeFileSync(join(root, "counter.ts"), "export const counter = 0;\n");
    const diff = taskDiff(root, base, untrackedAtStart);
    assert.match(diff, /-export const a = 2;\n\+export const a = 3;/);
    assert.doesNotMatch(diff, /a = 1/);
    assert.match(diff, /new file\n--- \/dev\/null\n\+\+\+ b\/counter\.ts\n\+export const counter = 0;/);
    assert.doesNotMatch(diff, /notes\.txt/);
  });

  it("uses HEAD for a clean tree, and nothing outside git", () => {
    g("add", "-A");
    g("commit", "-q", "-m", "more");
    assert.equal(startBase(root).base, g("rev-parse", "HEAD").trim());
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "ac-plain-")));
    assert.deepEqual(startBase(plain), { base: null, untrackedAtStart: [] });
    assert.equal(taskDiff(plain, null, []), "");
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("a run's changed files", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-stats-")));
  after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: root,
      encoding: "utf8",
    });

  it("counts lines per file, new and deleted ones too, and leaves out AgentChainer's own and earlier files", () => {
    writeFileSync(join(root, "a.ts"), "one\ntwo\n");
    writeFileSync(join(root, "gone.ts"), "x\n");
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    writeFileSync(join(root, "mine.txt"), "the user's\n");
    const { base, untrackedAtStart } = startBase(root);
    writeFileSync(join(root, "a.ts"), "one\n2\nthree\n");
    rmSync(join(root, "gone.ts"));
    writeFileSync(join(root, "new.ts"), "a\nb\n");
    writeFileSync(join(root, "logo.png"), Buffer.from([0, 1, 2, 3]));
    mkdirSync(join(root, ".agentchainer"));
    writeFileSync(join(root, ".agentchainer", "x.json"), "{}");
    assert.deepEqual(fileStats(root, base, untrackedAtStart), [
      { path: "a.ts", status: "modified", added: 2, removed: 1 },
      { path: "gone.ts", status: "deleted", added: 0, removed: 1 },
      { path: "logo.png", status: "new", added: null, removed: 0 },
      { path: "new.ts", status: "new", added: 2, removed: 0 },
    ]);
  });
});

describe("the session runner's records", () => {
  it("records guard blocks and answered approvals, tagged with the step", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-records-")));
    const approvals: ApprovalRecord[] = [];
    const blocks: GuardBlock[] = [];
    const events: string[] = [];
    let session: Session | undefined;
    // A stand-in SDK: a Bash call the guard denied, then an Edit that needs approval, then the end of the turn.
    const sdk = {
      query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
        const canUseTool = options.canUseTool as (t: string, i: unknown, c: unknown) => Promise<unknown>;
        const messages = (async function* () {
          for await (const _ of prompt) {
            yield {
              type: "assistant",
              parent_tool_use_id: null,
              message: {
                content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git push --force" } }],
              },
            };
            yield {
              type: "user",
              parent_tool_use_id: null,
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "t1",
                    is_error: true,
                    content:
                      "PreToolUse:Bash hook error: Blocked by AgentChainer guard: Force-pushing rewrites remote history.",
                  },
                ],
              },
            };
            await canUseTool(
              "Edit",
              { file_path: join(root, "src/a.ts"), old_string: "a", new_string: "b" },
              { requestId: "r1", toolUseID: "t2", signal: new AbortController().signal, suggestions: [] },
            );
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "done",
              total_cost_usd: 0.01,
              duration_ms: 1,
              num_turns: 1,
            };
          }
        })();
        return Object.assign(messages, { close: () => undefined, interrupt: async () => undefined });
      },
    } as unknown as AgentSdkModule;
    const library = LibrarySchema.parse(shipped);
    const workflow = library.workflows.S;
    if (!workflow) throw new Error("no S workflow");
    const task = {
      id: "2026-10-30-0000abcd",
      run: newRun(workflow, { permissionMode: "default", base: null, untrackedAtStart: [] }, new Date()),
    } as Task;
    const runner = sessionRunner(
      root,
      task,
      library,
      {
        sdk,
        claudePath: "claude",
        register: (s) => {
          session = s;
        },
        unregister: () => undefined,
        event: (_id, event, tag) => events.push(`${tag.stepId}:${event.type}`),
        // The user allows the edit, as the approval dialog would.
        permission: (_id, request) => queueMicrotask(() => session?.respond(request.requestId, { allow: true })),
      },
      { approval: (r) => approvals.push(r), guardBlock: (b) => blocks.push(b) },
    );
    const implement = workflow.steps[0];
    if (!implement || "gates" in implement || "parallel" in implement) throw new Error("no implement step");
    const out = await runner.start(implement, "Implement it.", 1, {
      id: task.id,
      stepId: "implement",
      label: "Implement",
    });
    runner.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(out.ok, true);
    assert.deepEqual(
      blocks.map((b) => [b.stepId, b.tool, b.target, b.reason]),
      [["implement", "Bash", "git push --force", "Force-pushing rewrites remote history."]],
    );
    assert.deepEqual(
      approvals.map((a) => [a.stepId, a.tool, a.target, a.risk, a.allowed]),
      [["implement", "Edit", "src/a.ts", "low", true]],
    );
    assert.ok(events.includes("implement:tool.completed"), "events still reach the UI, tagged");
  });
});
