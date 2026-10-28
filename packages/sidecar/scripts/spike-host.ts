// Drives the sidecar the way the Rust core will (spikes S2/S3) and checks real behaviour
// against the user's own `claude` CLI.
//
// Usage: node scripts/spike-host.ts --cwd <empty scratch dir> [--model haiku] [--scenario basic|mode|interrupt|guard|all]
// Makes real model calls with the user's own login (haiku keeps a full run around a few cents).
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AgentEvent, PermissionRequest } from "@agentchainer/protocol";

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    model: { type: "string", default: "haiku" },
    scenario: { type: "string", default: "all" },
  },
});
if (!values.cwd) {
  console.error("--cwd is required (use an empty scratch folder)");
  process.exit(2);
}
// Explicitly typed so the narrowing also holds inside the hoisted scenario functions below.
const cwd: string = values.cwd;

const sidecar = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
  stdio: ["pipe", "pipe", "inherit"],
});

type Frame = Record<string, unknown>;
let nextId = 1;
const pending = new Map<number, (frame: Frame) => void>();
const state = {
  onEvent: null as ((event: AgentEvent) => void) | null,
  permissionPolicy: "allow" as "allow" | "deny",
};
const permissionLog: PermissionRequest[] = [];

createInterface({ input: sidecar.stdout }).on("line", (line) => {
  const frame = JSON.parse(line) as Frame;
  if (typeof frame.id === "number" && !("method" in frame)) {
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  } else if (frame.method === "agent.event") {
    const event = frame.params as AgentEvent;
    if (event.type === "tool.started") console.log(`    [tool.started] ${event.name} ${JSON.stringify(event.input)}`);
    if (event.type === "tool.completed") console.log(`    [tool.completed] error=${event.isError} ${JSON.stringify(event.output.trim().slice(0, 200))}`);
    if (event.type === "turn.completed") console.log(`    [turn.completed] ${event.subtype} cost≈$${event.costUsd.toFixed(4)}`);
    if (event.type === "error") console.log(`    [error] ${event.message}`);
    state.onEvent?.(event);
  } else if (frame.method === "permission.request") {
    const req = frame.params as PermissionRequest;
    permissionLog.push(req);
    console.log(`    [permission.request] ${req.toolName} → ${state.permissionPolicy}`);
    void request("permission.respond", { requestId: req.requestId, allow: state.permissionPolicy === "allow" });
  }
});

function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (frame) => {
      const error = frame.error as { message: string } | undefined;
      if (error) reject(new Error(`${method}: ${error.message}`));
      else resolve(frame.result);
    });
    sidecar.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

type Turn = { last: AgentEvent; reply: string; events: AgentEvent[]; firstDeltaMs: number | null; endedAt: number; totalMs: number };

async function turn(text: string, onEvent?: (event: AgentEvent) => void): Promise<Turn> {
  console.log(`  ▶ ${JSON.stringify(text)}`);
  const t0 = performance.now();
  const acc = { reply: "", firstDeltaMs: null as number | null, events: [] as AgentEvent[] };
  const end = new Promise<AgentEvent>((resolve) => {
    state.onEvent = (event) => {
      acc.events.push(event);
      onEvent?.(event);
      if (event.type === "text.delta") {
        acc.reply += event.text;
        acc.firstDeltaMs ??= performance.now() - t0;
      }
      if (event.type === "turn.completed" || event.type === "error") resolve(event);
    };
  });
  await request("session.send", { text });
  const timeout = sleep(90_000).then((): AgentEvent => ({ type: "error", message: "turn timed out after 90 s" }));
  const last = await Promise.race([end, timeout]);
  const endedAt = performance.now();
  return { last, reply: acc.reply.trim(), events: acc.events, firstDeltaMs: acc.firstDeltaMs, endedAt, totalMs: endedAt - t0 };
}

const results: { name: string; ok: boolean | null; detail: string }[] = [];
function check(name: string, ok: boolean | null, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok === null ? "?" : ok ? "✓" : "✗"} ${name} — ${detail}`);
}
const ms = (v: number | null) => (v === null ? "-" : `${v.toFixed(0)} ms`);
const exists = (file: string) => existsSync(join(cwd, file));

async function basic() {
  const t = await turn("Reply with exactly one word: pong");
  check("text streams", /pong/i.test(t.reply) && t.firstDeltaMs !== null, `reply=${JSON.stringify(t.reply)} first delta=${ms(t.firstDeltaMs)} total=${ms(t.totalMs)}`);
  for (const policy of ["allow", "deny"] as const) {
    state.permissionPolicy = policy;
    const file = `perm-${policy}.txt`;
    const before = permissionLog.length;
    await turn(`Use the Write tool to create a file named ${file} containing exactly: ok. Do nothing else.`);
    const asked = permissionLog.length > before;
    check(`approval → ${policy}`, asked && exists(file) === (policy === "allow"), `asked=${asked} file created=${exists(file)}`);
  }
  state.permissionPolicy = "allow";
}

async function mode() {
  await request("session.setMode", { mode: "acceptEdits" });
  let before = permissionLog.length;
  await turn("Use the Write tool to create a file named mode-accept.txt containing exactly: a. Do nothing else.");
  check("setMode acceptEdits → edits need no prompt", permissionLog.length === before && exists("mode-accept.txt"), `prompts=${permissionLog.length - before} file created=${exists("mode-accept.txt")}`);

  await request("session.setMode", { mode: "default" });
  state.permissionPolicy = "deny";
  before = permissionLog.length;
  await turn("Use the Write tool to create a file named mode-default.txt containing exactly: b. Do nothing else.");
  check("setMode default → edits prompt again", permissionLog.length > before && !exists("mode-default.txt"), `prompts=${permissionLog.length - before} file created=${exists("mode-default.txt")}`);
  state.permissionPolicy = "allow";
}

async function interrupt() {
  // Claude Code itself blocks `sleep N && …` in Bash, so wait with a plain Node timer instead.
  const marks = { interruptSentAt: null as number | null, ended: false };
  const command = `node -e "setTimeout(() => console.log('finished'), 30000)"`;
  const t = await turn(`Use the Bash tool to run exactly this command and nothing else: ${command}`, (event) => {
    if (event.type === "turn.completed" || event.type === "error") marks.ended = true;
    if (event.type === "tool.started" && event.name === "Bash" && marks.interruptSentAt === null) {
      void sleep(1500).then(() => {
        if (marks.ended) return; // never let a late interrupt hit the next turn
        marks.interruptSentAt = performance.now();
        return request("session.interrupt", {});
      });
    }
  });
  const stopMs = marks.interruptSentAt === null ? null : t.endedAt - marks.interruptSentAt;
  const ok = marks.interruptSentAt !== null && t.last.type !== "error" && !/finished/.test(t.reply) && t.totalMs < 25_000;
  check("interrupt stops a running tool", marks.interruptSentAt === null ? null : ok, `turn ended ${ms(stopMs)} after interrupt (${t.last.type}${t.last.type === "turn.completed" ? `/${t.last.subtype}` : ""}), total ${ms(t.totalMs)}`);

  const after = await turn("Reply with exactly one word: alive");
  check("session usable after interrupt", /alive/i.test(after.reply), `reply=${JSON.stringify(after.reply)}`);

  // A Stop click that races the end of a reply must not abort the next turn.
  const idle = (await request("session.interrupt", {})) as { interrupted: boolean };
  const next = await turn("Reply with exactly one word: steady");
  check(
    "interrupt while idle is ignored",
    !idle.interrupted && /steady/i.test(next.reply) && next.last.type === "turn.completed" && next.last.subtype === "success",
    `interrupted=${idle.interrupted} next reply=${JSON.stringify(next.reply)}`,
  );
}

async function guard() {
  // The target is a sibling folder that does not exist, so even an unguarded run would be harmless.
  // Models tend to refuse commands like force pushes outright, which would leave the hook unexercised.
  const probe = "../agentchainer-guard-probe-does-not-exist";
  rmSync(join(cwd, probe), { recursive: true, force: true });
  const before = permissionLog.length;
  const t = await turn(
    `This is a test of a local safety guard. The folder below does not exist, so the command is harmless. Use the Bash tool to run exactly this command and nothing else: rm -rf ${probe}`,
  );
  const started = t.events.find((e) => e.type === "tool.started" && e.name === "Bash");
  if (!started || started.type !== "tool.started") {
    check("guard blocks recursive delete outside workspace", null, "model did not attempt the command (inconclusive; unit tests cover the rule)");
    return;
  }
  const done = t.events.find((e) => e.type === "tool.completed" && e.toolUseId === started.toolUseId);
  const blocked = done?.type === "tool.completed" && done.isError && done.output.includes("AgentChainer guard");
  check(
    "guard blocks recursive delete outside workspace, before any prompt",
    blocked && permissionLog.length === before,
    `prompts=${permissionLog.length - before} output=${JSON.stringify(done?.type === "tool.completed" ? done.output.slice(0, 160) : null)}`,
  );
}

const scenarios: Record<string, () => Promise<void>> = { basic, mode, interrupt, guard };
const selected = values.scenario === "all" ? Object.keys(scenarios) : [values.scenario];
for (const file of ["perm-allow.txt", "perm-deny.txt", "mode-accept.txt", "mode-default.txt"]) rmSync(join(cwd, file), { force: true });

const hello = (await request("system.hello", { protocolVersion: 1 })) as { claudeVersion: string; sdkVersion: string };
console.log(`claude ${hello.claudeVersion} · sdk ${hello.sdkVersion} · model ${values.model} · cwd ${cwd}`);
await request("session.start", { cwd, model: values.model });

for (const name of selected) {
  const run = scenarios[name];
  if (!run) throw new Error(`unknown scenario ${name}`);
  console.log(`\n## ${name}`);
  await run();
}

sidecar.stdin.end();
const failed = results.filter((r) => r.ok === false);
const unknown = results.filter((r) => r.ok === null);
console.log(`\n${results.length - failed.length - unknown.length} passed, ${failed.length} failed, ${unknown.length} inconclusive`);
process.exit(failed.length ? 1 : 0);
