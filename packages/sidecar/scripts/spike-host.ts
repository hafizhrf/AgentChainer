// Drives the sidecar the way the Rust core will (spikes S2/S3): hello → session.start →
// a text-only turn → a turn that needs a Bash approval. Prints events and timings.
//
// Usage: node scripts/spike-host.ts [--cwd DIR] [--model haiku] [--deny]
// Makes real model calls with the user's own `claude` login (keep prompts tiny).
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AgentEvent, PermissionRequest } from "@agentchainer/protocol";

const { values } = parseArgs({
  options: {
    cwd: { type: "string", default: process.cwd() },
    model: { type: "string", default: "haiku" },
    deny: { type: "boolean", default: false },
  },
});

const sidecar = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
  stdio: ["pipe", "pipe", "inherit"],
});

type Frame = Record<string, unknown>;
let nextId = 1;
const pending = new Map<number, (frame: Frame) => void>();
let onEvent: ((event: AgentEvent) => void) | null = null;
const permissionTimes: number[] = [];

createInterface({ input: sidecar.stdout }).on("line", (line) => {
  const frame = JSON.parse(line) as Frame;
  if (typeof frame.id === "number" && !("method" in frame)) {
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  } else if (frame.method === "agent.event") {
    const event = frame.params as AgentEvent;
    if (event.type === "tool.started") console.log(`  [tool.started] ${event.name} ${JSON.stringify(event.input)}`);
    if (event.type === "tool.completed") console.log(`  [tool.completed] error=${event.isError} output=${JSON.stringify(event.output.trim())}`);
    if (event.type === "session.started") console.log(`  [session.started] model=${event.model} claude=${event.claudeCodeVersion}`);
    if (event.type === "error") console.log(`  [error] ${event.message}`);
    onEvent?.(event);
  } else if (frame.method === "permission.request") {
    const req = frame.params as PermissionRequest;
    const allow = !values.deny;
    console.log(`  [permission.request] ${req.toolName} ${JSON.stringify(req.input)} → ${allow ? "allow" : "deny"}`);
    const t0 = performance.now();
    void request("permission.respond", { requestId: req.requestId, allow }).then(() =>
      permissionTimes.push(performance.now() - t0),
    );
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

async function turn(label: string, text: string) {
  console.log(`\n▶ ${label}: ${JSON.stringify(text)}`);
  const t0 = performance.now();
  // Mutated from the event callback, so keep it in an object (TS can't track closure writes to locals).
  const stats = { firstDeltaMs: null as number | null, deltas: 0, reply: "" };
  const end = new Promise<AgentEvent>((resolve) => {
    onEvent = (event) => {
      if (event.type === "text.delta") {
        stats.deltas++;
        stats.reply += event.text;
        stats.firstDeltaMs ??= performance.now() - t0;
      }
      if (event.type === "turn.completed" || event.type === "error") resolve(event);
    };
  });
  await request("session.send", { text });
  const last = await end;
  const totalMs = performance.now() - t0;
  console.log(`  reply: ${JSON.stringify(stats.reply.trim())}`);
  console.log(
    `  first delta: ${stats.firstDeltaMs?.toFixed(0) ?? "-"} ms · deltas: ${stats.deltas} · total: ${totalMs.toFixed(0)} ms`,
  );
  if (last.type === "turn.completed") {
    console.log(`  result: ${last.subtype} error=${last.isError} cost≈$${last.costUsd.toFixed(4)} turns=${last.numTurns}`);
  }
  return last;
}

const guard = setTimeout(() => {
  console.error("FAIL: timed out after 240 s");
  process.exit(1);
}, 240_000);

const hello = await request("system.hello", { protocolVersion: 1 });
console.log("hello:", JSON.stringify(hello));
await request("session.start", { cwd: values.cwd, model: values.model });

const t1 = await turn("text turn", "Reply with exactly one word: pong");
// Read-only commands (e.g. `echo`) are auto-approved by Claude Code and never reach canUseTool,
// so the tool turn uses a write, which needs an approval in the default permission mode.
const t2 = await turn(
  "tool turn",
  "Use the Write tool to create a file named agentchainer-spike.txt containing exactly: ok. Do nothing else.",
);
console.log(`\npermission round-trips (host→sidecar ack): ${permissionTimes.map((t) => `${t.toFixed(1)} ms`).join(", ") || "none"}`);

clearTimeout(guard);
sidecar.stdin.end();
const ok = t1.type === "turn.completed" && !t1.isError && t2.type === "turn.completed" && permissionTimes.length > 0;
console.log(ok ? "\nOK: S2/S3 flow completed" : "\nFAIL: see events above");
process.exit(ok ? 0 : 1);
