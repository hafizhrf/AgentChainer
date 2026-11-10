import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, PermissionRequest } from "@agentchainer/protocol";
import { GUARD_PREFIX } from "../guard.ts";
import { codexBackend, openCodexChat } from "./codex.ts";
import type { LiveSession } from "./types.ts";

// A stand-in `codex app-server`: the protocol as spike S8 recorded it, scripted. One turn edits a file (asking first),
// then tries a force push (asking first), then answers. It reports the decisions it got in its final message.
const FAKE = String.raw`
import { createInterface } from "node:readline";
const send = (f) => process.stdout.write(JSON.stringify(f) + "\n");
let ask = 100;
const waiting = new Map();
const decisions = [];
let interrupted = null;
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ask++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
createInterface({ input: process.stdin }).on("line", async (line) => {
  const f = JSON.parse(line);
  if (f.id !== undefined && !f.method) return waiting.get(f.id)?.(f.result);
  if (f.method === "initialize") return send({ id: f.id, result: { userAgent: "fake" } });
  if (f.method === "model/list") return send({ id: f.id, result: { data: [{ id: "gpt-fake", isDefault: true }] } });
  if (f.params?.threadId === "taken")
    return send({ id: f.id, error: { message: "thread taken already has an active writer" } });
  if (f.method === "thread/start" || f.method === "thread/resume")
    return send({ id: f.id, result: { thread: { id: f.params.threadId ?? "thread-1", model: f.params.model } } });
  if (f.method === "turn/interrupt") {
    send({ id: f.id, result: {} });
    return interrupted?.();
  }
  if (f.method === "turn/start") {
    send({ id: f.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
    const edit = { type: "fileChange", id: "item-1", status: "inProgress", changes: [{ path: process.env.FAKE_FILE, kind: { type: "add" }, diff: "hi\n" }] };
    send({ method: "item/started", params: { item: edit } });
    const a = await request("item/fileChange/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" });
    decisions.push(a.decision);
    send({ method: "item/completed", params: { item: { ...edit, status: a.decision === "accept" ? "completed" : "declined" } } });
    const push = { type: "commandExecution", id: "item-2", command: "powershell.exe -Command 'git push --force origin main'", commandActions: [{ type: "unknown", command: "git push --force origin main" }], status: "inProgress" };
    send({ method: "item/started", params: { item: push } });
    const b = await request("item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", command: push.command, commandActions: push.commandActions });
    decisions.push(b.decision);
    send({ method: "item/completed", params: { item: { ...push, status: b.decision === "accept" ? "completed" : "declined", exitCode: null, aggregatedOutput: "" } } });
    send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: 50, cachedInputTokens: 20, outputTokens: 7, reasoningOutputTokens: 3 }, last: { inputTokens: 50, cachedInputTokens: 20, outputTokens: 7, reasoningOutputTokens: 3 } } } });
    if (process.env.FAKE_WAIT_INTERRUPT) {
      await new Promise((resolve) => (interrupted = resolve));
      return send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted", error: null, durationMs: 5 } } });
    }
    send({ method: "item/completed", params: { item: { type: "agentMessage", id: "m1", text: "decisions: " + decisions.join(",") } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, durationMs: 5 } } });
  }
});
`;

const dir = mkdtempSync(path.join(tmpdir(), "ac-codex-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const script = path.join(dir, "fake-app-server.mjs");
writeFileSync(script, FAKE);

/** Opens a Codex step on the fake, with the person's answer to every approval it's asked. */
async function step(opts: {
  permissionMode?: "default" | "acceptEdits";
  allow: boolean;
  resume?: string;
  model?: string;
  maxBudgetUsd?: number;
}) {
  process.env.FAKE_FILE = path.join(dir, "hello.txt");
  if (opts.maxBudgetUsd !== undefined) process.env.FAKE_WAIT_INTERRUPT = "1";
  else delete process.env.FAKE_WAIT_INTERRUPT;
  const events: AgentEvent[] = [];
  const asked: Omit<PermissionRequest, "sessionId">[] = [];
  const answered: string[] = [];
  const registered = new Map<string, LiveSession>();
  let session: LiveSession | undefined;
  const open = codexBackend({
    // The fake ignores the `app-server` argument the backend adds.
    cli: { bin: process.execPath, prefix: [script] },
    version: "codex-cli fake",
    register: (s) => registered.set(s.id, s),
    unregister: (id) => registered.delete(id),
  });
  session = (await open(
    {
      cwd: dir,
      permissionMode: opts.permissionMode ?? "default",
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    },
    {
      emit: (e) => events.push(e),
      askPermission: (r) => {
        asked.push(r);
        queueMicrotask(() => session?.respond(r.requestId, { allow: opts.allow }));
      },
      answered: (r, a) => answered.push(`${r.toolName}:${a.allow}`),
      onEnd: () => undefined,
    },
  )) as LiveSession;
  const result = await session.turn("Create hello.txt, then force-push.");
  await session.close();
  return { session, result, events, asked, answered, registered };
}

describe("the Codex step backend (M9-04)", () => {
  it("estimates a turn's cost from its tokens, or says it's unknown for a model with no price (M9-07)", async () => {
    const priced = await step({ allow: true, model: "gpt-6-luna" });
    assert.equal(priced.result.model, "gpt-6-luna");
    assert.equal(priced.result.costKind, "estimate");
    assert.deepEqual(priced.result.tokens, { input: 50, output: 10 });
    // 30 uncached × $0.10, 20 cached × $0.01, 10 out × $0.50, per million.
    assert.ok(Math.abs(priced.result.costUsd - (3 + 0.2 + 5) / 1_000_000) < 1e-12);
    assert.equal(priced.session.fleetItem.agent, "codex");
    const unpriced = await step({ allow: true });
    assert.equal(unpriced.result.model, "gpt-fake");
    assert.equal(unpriced.result.costKind, "unknown");
    assert.equal(unpriced.result.costUsd, 0);
  });

  it("stops a turn once its estimate passes the step's budget (M9-07)", async () => {
    const { result } = await step({ allow: true, model: "gpt-6-luna", maxBudgetUsd: 0.000001 });
    assert.equal(result.subtype, "error_max_budget_usd");
    assert.equal(result.isError, true);
  });

  it("asks before an edit, and the guard declines a force push before anyone is asked", async () => {
    const { session, result, events, asked, answered } = await step({ allow: true });
    assert.equal(session.id, "thread-1", "the session's id is the thread's, which fix rounds resume");
    assert.deepEqual(
      asked.map((r) => [r.toolName, r.input]),
      [["Write", { file_path: path.join(dir, "hello.txt") }]],
      "only the edit reached the person",
    );
    assert.deepEqual(answered, ["Write:true"]);
    assert.equal(result.text, "decisions: accept,decline");
    assert.deepEqual([result.subtype, result.isError, result.costUsd], ["success", false, 0]);
    const push = events.find((e) => e.type === "tool.completed" && e.toolUseId === "item-2");
    assert.ok(push?.type === "tool.completed" && push.isError && push.output.startsWith(GUARD_PREFIX));
    const started = events.find((e) => e.type === "session.started");
    assert.ok(started?.type === "session.started" && started.model === "gpt-fake", "Codex's default when none is set");
    const done = events.find((e) => e.type === "turn.completed");
    assert.ok(done?.type === "turn.completed" && done.usage?.inputTokens === 50 && done.usage.outputTokens === 10);
  });

  it("runs an edit inside the workspace without asking in Standard, and a declined one stays declined", async () => {
    const standard = await step({ permissionMode: "acceptEdits", allow: true });
    assert.equal(standard.asked.length, 0);
    assert.equal(standard.result.text, "decisions: accept,decline");
    const denied = await step({ allow: false });
    assert.equal(denied.result.text, "decisions: decline,decline");
  });

  it("resumes a thread by its id and unregisters a session once it ends", async () => {
    const { session, registered } = await step({ allow: true, resume: "thread-7" });
    assert.equal(session.id, "thread-7");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(registered.size, 0);
  });
});

describe("a chat on Codex (M9-09)", () => {
  it("holds its opening events until released, then a message runs a turn and plan mode is refused", async () => {
    process.env.FAKE_FILE = path.join(dir, "chat.txt");
    delete process.env.FAKE_WAIT_INTERRUPT;
    const events: AgentEvent[] = [];
    const host = {
      cli: { bin: process.execPath, prefix: [script] },
      version: "codex-cli fake",
      register: () => undefined,
      unregister: () => undefined,
    };
    let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
    chat = await openCodexChat(
      host,
      { cwd: dir, permissionMode: "acceptEdits" },
      {
        emit: (e) => events.push(e),
        askPermission: (r) => queueMicrotask(() => chat?.respond(r.requestId, { allow: true })),
        onEnd: () => undefined,
      },
    );
    assert.equal(chat.agent, "codex");
    assert.equal(events.length, 0, "nothing goes out before the tab exists");
    chat.release();
    assert.deepEqual(
      events.map((e) => e.type),
      ["session.started", "models.changed"],
    );
    const models = events.find((e) => e.type === "models.changed");
    assert.deepEqual(models?.type === "models.changed" ? models.models.map((m) => m.value) : [], ["gpt-fake"]);
    const ended = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (events.some((e) => e.type === "turn.completed")) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    assert.equal(typeof chat.send("Create chat.txt"), "string");
    await ended;
    assert.ok(events.some((e) => e.type === "text.delta" || e.type === "tool.started"));
    await assert.rejects(chat.setMode("plan"), /plan mode/);
    await chat.setModel("gpt-other");
    await chat.close();
  });

  it("stops its app-server when the thread can't be opened, so it isn't left as the thread's writer", async () => {
    let ended = false;
    const host = {
      cli: { bin: process.execPath, prefix: [script] },
      version: "codex-cli fake",
      register: () => undefined,
      unregister: () => undefined,
    };
    await assert.rejects(
      openCodexChat(
        host,
        { cwd: dir, resume: "taken" },
        {
          emit: () => undefined,
          askPermission: () => undefined,
          onEnd: () => {
            ended = true;
          },
        },
      ),
      /active writer/,
    );
    for (let i = 0; i < 100 && !ended; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ended, "the app-server exited");
  });
});
