// Runs a task end to end through the sidecar's JSON-RPC, with real model calls (M3-06): create, draft, approve, run.
// Approvals are answered yes by this script, so use it only on a throwaway copy of a fixture; it makes one and
// prints the timeline, the gate runs and the cost, then re-runs the last round's gate commands by hand to compare
// exit codes, and checks that the evidence report's gate runs are the recorded ones (M3-E2).
//
// Usage: node scripts/live-task.ts [--fixture sample-app] [--request "…"] [--model haiku] [--tier S|M|L] [--keep]
//   [--stop-after <seconds>]: stops the run that long after it starts, to check it ends `cancelled`
//   [--accept "<reason>"]: accepts the risk when the run ends failed or not verified (M3-10)
//   [--print-evidence]: prints the evidence report (M3-09)
//   --tier XL: splits the task, approves every sub-task as drafted, runs it, prints the task branch's log, then cleans
//   the worktrees up (M3-07)
//   cost: a few cents with haiku for an S task; an M or L task's review runs on Opus (≈$0.2–3).

import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
    accept: { type: "string" },
    "print-evidence": { type: "boolean", default: false },
  },
});

const cwd = copyFixture(values.fixture);
console.log(`workspace: ${cwd}`);
const child = spawn(process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
let finished: (task: Task) => void = () => undefined;
const done = new Promise<Task>((resolve) => (finished = resolve));
const lastStep = new Map<string, string>();
/** The task this run is about; an XL task's sub-tasks report too, prefixed with their number. */
let topId = "";

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
    const prefix = t.parent ? `    [${t.parent.index + 1}] ` : "  · ";
    const line = step ? `${step.label}: ${step.status}${step.note ? ` (${step.note})` : ""}` : t.state;
    if (line !== lastStep.get(t.id)) console.log(`${prefix}${line}`);
    lastStep.set(t.id, line);
    if (t.id === topId && !["running", "ready"].includes(t.state)) finished(t);
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
  topId = created.id;
  const drafted = await request("task.draft", { cwd, id: created.id, model: values.model });
  if (!drafted.contract || !drafted.triage) throw new Error("no contract");
  const tier = (values.tier ?? drafted.triage.proposed) as "S" | "M" | "L" | "XL";
  console.log(`drafted ($${drafted.costUsd.toFixed(3)}); proposed ${drafted.triage.proposed}, running as ${tier}`);
  await request("task.approve", {
    cwd,
    id: created.id,
    contract: drafted.contract,
    tier,
    ...(tier !== drafted.triage.proposed ? { reason: "live test" } : {}),
    budgetUsd: drafted.triage.budgetUsd,
  });
  if (tier === "XL") {
    const split = await request("task.split", { cwd, id: created.id, model: values.model });
    console.log(`split ($${split.costUsd.toFixed(3)} so far):`);
    for (const [i, id] of (split.subtasks ?? []).entries()) {
      const sub = await request("task.get", { cwd, id });
      const after = (sub.dependsOn ?? []).map((d) => (split.subtasks ?? []).indexOf(d) + 1);
      console.log(
        `  ${i + 1}. [${sub.triage?.chosen}] ${sub.title}${after.length ? ` (after ${after.join(", ")})` : ""}`,
      );
    }
    await request("task.approveSubtasks", { cwd, id: created.id });
  }
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
  for (const g of end.run?.baseline ?? [])
    console.log(`  baseline ${g.kind} \`${g.command}\` → ${g.exitCode} (${g.durationMs} ms)`);
  const runs = end.run?.gates ?? [];
  for (const g of runs)
    console.log(`  gate ${g.kind} r${g.round} \`${g.command}\` → ${g.exitCode} (${g.durationMs} ms)`);
  // M3-E2: the recorded exit codes match the commands run again by hand.
  const last = Math.max(-1, ...runs.map((g) => g.round));
  for (const g of runs.filter((r) => r.round === last)) {
    let code = 0;
    try {
      execSync(g.command, {
        cwd: `${end.worktree?.path ?? cwd}/${g.package === "." ? "" : g.package}`,
        stdio: "ignore",
        env: { ...process.env, CI: "1" },
      });
    } catch (err) {
      code = (err as { status?: number }).status ?? -1;
    }
    console.log(`  by hand: ${g.command} → ${code} ${code === g.exitCode ? "✓ matches" : "✗ differs"}`);
  }
  let final = end;
  if (values.accept && (end.state === "failed" || end.state === "unverified")) {
    final = await request("task.acceptRisk", { cwd, id: created.id, reason: values.accept });
    console.log(`\naccepted: ${final.state} (${final.run?.acceptance?.reason})`);
  }
  // M3-09, M3-E2: the report exists, and its gate runs are exactly the recorded ones.
  const evidence = await request("task.evidence", { cwd, id: created.id });
  const stored = JSON.parse(readFileSync(evidence.path.replace(/\.md$/, ".json"), "utf8"));
  const same =
    JSON.stringify(stored.gates.runs) === JSON.stringify(final.run?.gates) &&
    JSON.stringify(stored.gates.baseline) === JSON.stringify(final.run?.baseline);
  console.log(`\nevidence: ${evidence.path}`);
  console.log(`  gate runs in the report ${same ? "✓ match the recorded runs" : "✗ differ from the recorded runs"}`);
  console.log(`  sections: ${[...evidence.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]).join(" · ")}`);
  if (values["print-evidence"]) console.log(`\n${evidence.markdown}`);
  if (end.worktree) {
    console.log(
      `\n${end.worktree.branch}:\n${execSync(`git log --oneline --graph -12 ${end.worktree.branch}`, { cwd, encoding: "utf8" })}`,
    );
    for (const id of end.subtasks ?? []) {
      const sub = await request("task.get", { cwd, id });
      console.log(
        `  [${(sub.parent?.index ?? 0) + 1}] ${sub.state}: ${sub.run?.outcome ?? ""} (≈$${(sub.run?.costUsd ?? 0).toFixed(3)})`,
      );
    }
    await request("task.cleanup", { cwd, id: created.id, deleteBranches: false });
    console.log(`after Clean up:\n${execSync("git worktree list", { cwd, encoding: "utf8" })}`);
  }
  console.log(`\ngit status:\n${execSync("git status --short", { cwd, encoding: "utf8" })}`);
} finally {
  // Close stdin and let the sidecar end its sessions and exit: on Windows a folder that a live process still runs in
  // can't be removed (EPERM). Killed only if it hangs.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 10_000);
  await exited;
  clearTimeout(timer);
  if (!values.keep) removeFixtureCopies();
}
