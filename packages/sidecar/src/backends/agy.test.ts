import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent } from "@agentchainer/protocol";
import { GUARD_PREFIX } from "../guard.ts";
import { agyBackend, runSettings, turnArgs } from "./agy.ts";
import { estimateUsd } from "./prices.ts";
import type { LiveSession } from "./types.ts";

// A stand-in `agy -p`: prints the stream spike S8 recorded, writing the file named in FAKE_WRITE, and appends the
// arguments it got to FAKE_ARGS (one JSON array a line), so the test sees each turn's command line.
const FAKE = String.raw`
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ARGS, JSON.stringify(args) + "\n");
const at = args.indexOf("--conversation");
const conv = at >= 0 ? args[at + 1] : "conv-1";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
out({ event: "init", conversation_id: conv, init: { model: process.env.FAKE_MODEL || "gemini-fake", permission_mode: "request-review" } });
const p = { Path: process.env.FAKE_WRITE };
out({ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "ACTIVE", step_type: "tool", tool_info: { name: "write_file", parameters: p } } });
out({ event: "step_update", step_update: { conversation_id: conv, step_index: 1, state: "DONE", step_type: "tool", tool_info: { name: "write_file", parameters: p } } });
out({ event: "step_update", step_update: { conversation_id: conv, step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "Wrote it." } });
out({ event: "result", result: { conversation_id: conv, status: "SUCCESS", response: "Wrote it.", duration_seconds: 1.5, usage: { input_tokens: 100, output_tokens: 7, thinking_tokens: 3, cache_read_tokens: 40 } } });
`;

const dir = mkdtempSync(path.join(tmpdir(), "ac-agy-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const script = path.join(dir, "fake-agy.mjs");
writeFileSync(script, FAKE);

async function run(write: string, opts: { readOnly?: boolean; turns?: number } = {}) {
  const argsFile = path.join(dir, `args-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(argsFile, "");
  process.env.FAKE_ARGS = argsFile;
  process.env.FAKE_WRITE = write;
  const events: AgentEvent[] = [];
  const statuses: string[] = [];
  const registered = new Map<string, LiveSession>();
  const open = agyBackend({
    cli: { bin: process.execPath, prefix: [script] },
    version: "agy fake",
    register: (s) => registered.set(s.id, s),
    unregister: (id) => registered.delete(id),
  });
  const session = (await open(
    { cwd: dir, readOnly: opts.readOnly === true, appendSystemPrompt: "You are the implementer.", model: "haiku" },
    {
      emit: (e) => events.push(e),
      askPermission: () => undefined,
      onEnd: () => undefined,
      statusChanged: (item) => statuses.push(`${item.sessionId}:${item.status}`),
    },
  )) as LiveSession;
  const results = [];
  for (let i = 0; i < (opts.turns ?? 1); i++)
    results.push(await session.turn(i ? "Fix the failing test." : "Write it."));
  const ids = [...registered.keys()];
  await session.close();
  const argv = readFileSync(argsFile, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);
  return { session, results, events, argv, ids, registered, statuses };
}

describe("the Antigravity CLI step backend (M9-05)", () => {
  it("estimates each turn's cost from its tokens at the model's price (M9-07)", async () => {
    process.env.FAKE_MODEL = "gemini-3.8-flash-low";
    try {
      const { results, session } = await run(path.join(dir, "priced.txt"), { turns: 2 });
      const each = estimateUsd("gemini-3.8-flash-low", { input: 100, cached: 40, output: 10 }) ?? 0;
      assert.ok(each > 0);
      for (const r of results) {
        assert.equal(r.costKind, "estimate");
        assert.ok(Math.abs(r.costUsd - each) < 1e-12);
      }
      assert.ok(Math.abs(session.fleetItem.costUsd - 2 * each) < 1e-12);
    } finally {
      delete process.env.FAKE_MODEL;
    }
  });

  it("edits files with no commands, through per-run settings, and goes by agy's conversation id", async () => {
    const { session, results, events, argv, ids, statuses } = await run(path.join(dir, "hello.txt"), { turns: 2 });
    // The fleet only hears of the conversation's id: no row is left behind under the temporary one.
    assert.ok(statuses.length > 0 && statuses.every((s) => s.startsWith("conv-1:")), statuses.join(", "));
    assert.deepEqual(
      results.map((r) => [r.subtype, r.text, r.costUsd]),
      [
        ["success", "Wrote it.", 0],
        ["success", "Wrote it.", 0],
      ],
    );
    assert.equal(session.id, "conv-1");
    assert.deepEqual(ids, ["conv-1"], "registered again under the conversation's id");
    // A model with no price: tokens, and a cost that's unknown (M9-07).
    assert.deepEqual(
      results.map((r) => [r.model, r.costKind, r.tokens?.input, r.tokens?.output]),
      [
        ["gemini-fake", "unknown", 100, 10],
        ["gemini-fake", "unknown", 100, 10],
      ],
    );
    assert.equal(session.fleetItem.agent, "agy");
    const [first, second] = argv;
    assert.ok(first && second);
    // The first turn carries the role's prompt and the no-commands rule; the second resumes the conversation.
    assert.match(first[1] ?? "", /^You are the implementer\.[\s\S]*not run commands[\s\S]*Write it\.$/);
    assert.equal(second[1], "Fix the failing test.");
    assert.deepEqual(second.slice(second.indexOf("--conversation"), second.indexOf("--conversation") + 2), [
      "--conversation",
      "conv-1",
    ]);
    for (const a of [first, second]) {
      assert.ok(a.includes("--sandbox") && a.includes("accept-edits"));
      assert.ok(!a.includes("--model"), "a Claude alias isn't passed to agy");
      assert.ok(!a.includes("--dangerously-skip-permissions"));
    }
    const settings = JSON.parse(first[first.indexOf("--settings") + 1] ?? "{}");
    assert.equal(settings.toolPermission, "request-review", "every command refused");
    const done = events.find((e) => e.type === "turn.completed");
    assert.ok(done?.type === "turn.completed" && done.usage?.inputTokens === 100 && done.usage.outputTokens === 10);
  });

  it("fails a turn that wrote where the guard rules it out, and says so in the evidence's words", async () => {
    const { results, events } = await run(path.join(homedir(), ".ssh", "authorized_keys"));
    assert.deepEqual([results[0]?.subtype, results[0]?.isError], ["error_during_execution", true]);
    const blocked = events.find((e) => e.type === "tool.completed" && e.isError);
    assert.ok(blocked?.type === "tool.completed" && blocked.output.startsWith(GUARD_PREFIX));
  });

  it("denies every write to a read step, and the credential folders to every step", () => {
    const read = JSON.parse(runSettings(true, "/home/dev")) as { permissions: { deny: string[] } };
    assert.ok(read.permissions.deny.includes("write_file(*)"));
    assert.ok(read.permissions.deny.includes("read_file(/home/dev/.ssh)"));
    const write = JSON.parse(runSettings(false, "/home/dev")) as { permissions: { deny: string[] } };
    assert.ok(!write.permissions.deny.includes("write_file(*)"));
    const args = turnArgs({ cwd: "/w", readOnly: true, model: "gemini-3.8-flash-low" }, "Review it.", null);
    assert.ok(!args.includes("accept-edits"), "a read step doesn't accept edits");
    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "gemini-3.8-flash-low",
    ]);
  });
});
