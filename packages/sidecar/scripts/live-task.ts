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
//   [--cwd <checkout>]: runs in an existing checkout instead of a fixture copy (left in place); for M5's live checks
//   [--fix-ci]: with --pr, breaks a test on the PR's branch, waits for CI to fail, runs one Fix CI round and waits for
//   CI on the fix (M5-03); the worktree is kept for the round
//   [--pr]: after a Done (or accepted) run, opens a draft PR through the user's own `gh` (task.createPr, M5-02). Only
//   with --cwd on a throwaway repository you own: it pushes a branch and opens a real pull request
//   cost: a few cents with haiku for an S task; an M or L task's review runs on Opus (≈$0.2–3).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Task } from "@agentchainer/protocol";
import { copyFixture, removeFixtureCopies } from "../src/detect/fixture-copy.ts";
import { SidecarClient } from "../src/evals/client.ts";

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
    cwd: { type: "string" },
    pr: { type: "boolean", default: false },
    "fix-ci": { type: "boolean", default: false },
  },
});
if (values.pr && !values.cwd) throw new Error("--pr needs --cwd: a checkout of a throwaway repository you own.");

const cwd = values.cwd ?? copyFixture(values.fixture);
console.log(`workspace: ${cwd}`);
const client = new SidecarClient();
const request = client.request.bind(client);
const lastStep = new Map<string, string>();

client.onPermission = (p) =>
  console.log(`  approve ${p.toolName} ${JSON.stringify(p.input).slice(0, 100)} (${p.task?.label ?? "?"})`);
client.onUpdate((t) => {
  const step = t.run?.steps.at(-1);
  const prefix = t.parent ? `    [${t.parent.index + 1}] ` : "  · ";
  const line = step ? `${step.label}: ${step.status}${step.note ? ` (${step.note})` : ""}` : t.state;
  if (line !== lastStep.get(t.id)) console.log(`${prefix}${line}`);
  lastStep.set(t.id, line);
});

/** Polls the PR's checks until `done` says so, or gives up after 10 minutes. */
async function waitForChecks(taskId: string, done: (checks: { bucket: string }[]) => boolean) {
  const until = Date.now() + 600_000;
  for (;;) {
    const s = await request("task.prStatus", { cwd, id: taskId });
    if (s.checks.length && done(s.checks)) return s;
    if (Date.now() > until) throw new Error(`CI didn't settle: ${JSON.stringify(s.checks.map((c) => c.bucket))}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/**
 * M5-03 live: breaks a test on the PR's branch on purpose (applyDiscount rounds up), waits for CI to fail, shows the
 * failing log, runs one Fix CI round, and waits for CI to pass on the pushed fix.
 */
async function fixCiRound(task: Task) {
  const wt = task.worktree;
  if (!wt) return;
  const git = (...args: string[]) => execSync(`git ${args.join(" ")}`, { cwd: wt.path, encoding: "utf8" });
  const file = `${wt.path}/src/cart.js`;
  writeFileSync(file, readFileSync(file, "utf8").replace("Math.round(", "Math.ceil("));
  git("commit", "-q", "-am", '"Round discounts up"');
  execSync(`git push -q origin ${wt.branch}`, { cwd, encoding: "utf8" });
  console.log("\nFix CI: pushed a commit that breaks applyDiscount; waiting for CI to fail…");
  const failing = await waitForChecks(
    task.id,
    (c) => c.every((x) => x.bucket !== "pending") && c.some((x) => x.bucket === "fail"),
  );
  const check = failing.checks.find((c) => c.bucket === "fail");
  if (!check) return;
  const { log } = await request("task.ciLog", { cwd, id: task.id, link: check.link });
  console.log(
    `  ${check.name} failed; log (${log.length} chars), last lines:\n${log
      .trim()
      .split("\n")
      .slice(-6)
      .map((l) => `    ${l}`)
      .join("\n")}`,
  );
  const ended = client.ended(task.id);
  await request("task.fixCi", { cwd, id: task.id, link: check.link });
  const round = await ended;
  // The push and the round's record come right after the run's end.
  let after = round;
  for (let i = 0; i < 20 && (after.pr?.fixes?.length ?? 0) < 1; i++) {
    await new Promise((r) => setTimeout(r, 500));
    after = await request("task.get", { cwd, id: task.id });
  }
  console.log(`  round: ${after.state} · ${after.run?.outcome} · fixes ${JSON.stringify(after.pr?.fixes)}`);
  if (after.pr?.fixes?.at(-1)?.state !== "done") return;
  console.log(`  pushed ${after.pr.headSha.slice(0, 7)}; waiting for CI on it…`);
  const green = await waitForChecks(task.id, (c) => c.every((x) => x.bucket !== "pending"));
  console.log(`  CI after the fix: ${green.checks.map((c) => `${c.name} ${c.bucket}`).join(", ")}`);
}

try {
  await request("system.hello", { protocolVersion: 2 });
  const created = await request("task.create", { cwd, request: values.request });
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
  const done = client.ended(created.id);
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
  // M5-02: the PR through the user's own gh, after the same preview the dialog shows.
  if (values.pr && (final.state === "done" || final.state === "accepted")) {
    const preview = await request("task.prPreview", { cwd, id: created.id });
    console.log(`\nPR: ${preview.head} → ${preview.base} (gh ${preview.github.state}, ${preview.github.repo ?? "-"})`);
    const shipped = await request("task.createPr", { cwd, id: created.id, title: preview.title, draft: true });
    console.log(
      `  ${shipped.pr?.url} (#${shipped.pr?.number}, draft ${shipped.pr?.draft}, head ${shipped.pr?.headSha.slice(0, 7)})`,
    );
    if (values["fix-ci"] && shipped.worktree) await fixCiRound(shipped);
  }
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
    if (!values["fix-ci"]) await request("task.cleanup", { cwd, id: created.id, deleteBranches: false });
    console.log(`after Clean up:\n${execSync("git worktree list", { cwd, encoding: "utf8" })}`);
  }
  console.log(`\ngit status:\n${execSync("git status --short", { cwd, encoding: "utf8" })}`);
} finally {
  await client.close();
  if (!values.keep && !values.cwd) removeFixtureCopies();
}
