// Runs a task end to end through the sidecar's JSON-RPC, with real model calls (M3-06): create, draft, approve, run.
// Approvals are answered yes by this script, so use it only on a throwaway copy of a fixture; it makes one and
// prints the timeline, the gate runs and the cost, then re-runs the last round's gate commands by hand to compare
// exit codes (M3-E2).
//
// Usage: node scripts/live-task.ts [--fixture sample-app] [--request "…"] [--model haiku] [--tier S] [--keep]
//   [--stop-after <seconds>]: stops the run that long after it starts, to check it ends `cancelled`
//   cost: a few cents with haiku for an S task; an M task's review runs on Opus (≈$1–3).
import { execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { MethodName, Methods, Task } from "@agentchainer/protocol";
import { copyFixture, removeFixtureCopies } from "../src/detect/fixture-copy.ts";

const { values } = parseArgs({
  options: {
    fixture: { type: "string", default: "sample-app" },
    request: { type: "string", default: "total() ignores the quantity: multiply each item's price by its quantity." },
    model: { type: "string", default: "haiku" },
    tier: { type: "string" },
    keep: { type: "boolean", default: false },
    "stop-after": { type: "string" },
  },
});

const cwd = copyFixture(values.fixture);
console.log(`workspace: ${cwd}`);
const child = spawn(process.execPath, [new URL("../src/main.ts", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
let finished: (task: Task) => void = () => undefined;
const done = new Promise<Task>((resolve) => (finished = resolve));
let lastStep = "";

createInterface({ input: child.stdout }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id != null) {
    pending.get(m.id)?.(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === "permission.request") {
    const p = m.params;
    console.log(`  approve ${p.toolName} ${JSON.stringify(p.input).slice(0, 100)} (${p.task?.label ?? "?"})`);
    void request("permission.respond", { sessionId: p.sessionId, requestId: p.requestId, allow: true });
  }
  if (m.method === "task.updated") {
    const t: Task = m.params.task;
    const step = t.run?.steps.at(-1);
    const line = step ? `${step.label}: ${step.status}${step.note ? ` (${step.note})` : ""}` : t.state;
    if (line !== lastStep) console.log(`  · ${line}`);
    lastStep = line;
    if (!["running", "ready"].includes(t.state)) finished(t);
  }
});

let id = 0;
async function request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
  const n = ++id;
  const reply = new Promise<{ result?: unknown; error?: { message: string } }>((r) => pending.set(n, r));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
  const m = await reply;
  if (m.error) throw new Error(`${method}: ${m.error.message}`);
  return m.result as Methods[M]["result"];
}

try {
  await request("system.hello", { protocolVersion: 2 });
  const created = await request("task.create", { cwd, request: values.request });
  const drafted = await request("task.draft", { cwd, id: created.id, model: values.model });
  if (!drafted.contract || !drafted.triage) throw new Error("no contract");
  const tier = (values.tier ?? drafted.triage.proposed) as "S" | "M";
  console.log(`drafted ($${drafted.costUsd.toFixed(3)}); proposed ${drafted.triage.proposed}, running as ${tier}`);
  await request("task.approve", {
    cwd,
    id: created.id,
    contract: drafted.contract,
    tier,
    ...(tier !== drafted.triage.proposed ? { reason: "live test" } : {}),
    budgetUsd: drafted.triage.budgetUsd,
  });
  const t0 = Date.now();
  await request("task.start", { cwd, id: created.id, permissionMode: "acceptEdits", model: values.model });
  if (values["stop-after"]) {
    setTimeout(() => {
      console.log("  ✋ stopping");
      void request("task.cancel", { cwd, id: created.id }).then((r) => console.log(`  cancel → ${JSON.stringify(r)}`));
    }, Number(values["stop-after"]) * 1000);
  }
  const end = await done;
  console.log(
    `\n${end.state}: ${end.run?.outcome} (${((Date.now() - t0) / 1000).toFixed(0)} s, ≈$${end.costUsd.toFixed(3)})`,
  );
  for (const s of end.run?.steps ?? []) {
    console.log(`  ${s.id.padEnd(18)} ${s.status.padEnd(9)} $${s.costUsd.toFixed(3)}  ${s.note ?? ""}`);
  }
  const runs = end.run?.gates ?? [];
  for (const g of runs)
    console.log(`  gate ${g.kind} r${g.round} \`${g.command}\` → ${g.exitCode} (${g.durationMs} ms)`);
  // M3-E2: the recorded exit codes match the commands run again by hand.
  const last = Math.max(-1, ...runs.map((g) => g.round));
  for (const g of runs.filter((r) => r.round === last)) {
    let code = 0;
    try {
      execSync(g.command, {
        cwd: `${cwd}/${g.package === "." ? "" : g.package}`,
        stdio: "ignore",
        env: { ...process.env, CI: "1" },
      });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    console.log(`  by hand: ${g.command} → ${code} ${code === g.exitCode ? "✓ matches" : "✗ differs"}`);
  }
  console.log(`\ngit status:\n${execSync("git status --short", { cwd, encoding: "utf8" })}`);
} finally {
  child.kill();
  if (!values.keep) removeFixtureCopies();
}
