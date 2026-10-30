// Triage benchmark (M3-E1, docs/design/planner.md §4): runs triage over the tasks in test/triage-benchmark.json, on
// copies of fixtures/, and reports how often it agrees with the human labels (`label`). The signals need no model; the
// classification is one haiku call per task, a few cents for the whole set.
//
// Usage: node scripts/benchmark-triage.ts [--signals-only] [--draft [--model sonnet]] [--only id,id] [--json out.json]
//   --signals-only  no model calls: how far the deterministic floor alone gets
//   --draft         draft each contract live (read-only session) instead of using the written one; costs more
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Tier } from "@agentchainer/protocol";
import { findClaude } from "../src/claude.ts";
import { detectWorkspace } from "../src/detect/detect.ts";
import { copyFixture, removeFixtureCopies } from "../src/detect/fixture-copy.ts";
import { loadSdk } from "../src/sdk-loader.ts";
import { availableGates, draftContract, normalizeContract } from "../src/tasks/contract.ts";
import { classify, classifyPrompt, signals, triageRecord } from "../src/tasks/triage.ts";
import { listFiles } from "../src/workspace.ts";
import benchmark from "../test/triage-benchmark.json" with { type: "json" };

const { values } = parseArgs({
  options: {
    "signals-only": { type: "boolean", default: false },
    draft: { type: "boolean", default: false },
    model: { type: "string" },
    only: { type: "string" },
    json: { type: "string" },
  },
});
const offline = values["signals-only"];
if (offline && values.draft) {
  console.error("--draft needs model calls; drop --signals-only");
  process.exit(2);
}
const claudePath = offline ? null : findClaude();
if (!offline && !claudePath) {
  console.error("claude not found: install the CLI and sign in, or use --signals-only");
  process.exit(2);
}
const sdk = offline ? null : (await loadSdk()).sdk;
const only = values.only?.split(",");
const tasks = benchmark.tasks.filter((t) => !only || only.includes(t.id));

type Row = {
  id: string;
  label: Tier | null;
  suggested: Tier;
  floor: Tier;
  model: Tier | null;
  proposed: Tier;
  signals: string[];
  rationale: string;
  costUsd: number;
  error?: string;
};
const rows: Row[] = [];
const copies = new Map<string, string>();

try {
  for (const t of tasks) {
    const dir = copies.get(t.fixture) ?? copyFixture(t.fixture);
    copies.set(t.fixture, dir);
    const profile = detectWorkspace(dir);
    let costUsd = 0;
    let contract = normalizeContract(t.request, t.contract, availableGates(profile));
    if (values.draft && sdk && claudePath) {
      const d = await draftContract(
        sdk,
        claudePath,
        dir,
        t.request,
        profile,
        values.model ? { model: values.model } : {},
      );
      costUsd += d.costUsd;
      if (!d.contract) {
        console.log(`  ! ${t.id}: drafting failed (${d.error}); using the written contract`);
      } else contract = d.contract;
    }
    const listing = listFiles(dir);
    const found = signals({
      request: t.request,
      contract,
      profile,
      files: listing.files.map((f) => f.path),
      truncated: listing.truncated,
    });
    const model =
      sdk && claudePath
        ? await classify(sdk, claudePath, dir, classifyPrompt(t.request, contract, found.signals))
        : { model: null, costUsd: 0 };
    costUsd += model.costUsd;
    const record = triageRecord(found, model);
    const row: Row = {
      id: t.id,
      label: (t.label as Tier | null) ?? null,
      suggested: t.suggested as Tier,
      floor: record.floor,
      model: record.model?.tier ?? null,
      proposed: record.proposed,
      signals: found.signals.filter((s) => s.floor).map((s) => `${s.signal}→${s.floor}`),
      rationale: record.model?.rationale ?? "",
      costUsd,
      ...(record.modelError ? { error: record.modelError } : {}),
    };
    rows.push(row);
    const reference = row.label ?? row.suggested;
    console.log(
      `${row.proposed === reference ? "✓" : "✗"} ${row.id.padEnd(28)} ${row.label ? "label" : "sugg."} ${reference.padEnd(2)}` +
        `  floor ${row.floor.padEnd(2)}  model ${(row.model ?? "–").padEnd(2)}  → ${row.proposed.padEnd(2)}` +
        `  ${row.signals.join(" ")}${row.error ? `  (${row.error})` : ""}`,
    );
  }
} finally {
  removeFixtureCopies();
}

const labeled = rows.filter((r) => r.label);
const reference = (r: Row) => (labeled.length ? r.label : r.suggested);
const scored = labeled.length ? labeled : rows;
const pct = (key: "floor" | "model" | "proposed") => {
  const rated = scored.filter((r) => r[key] !== null);
  if (!rated.length) return "n/a";
  const agree = rated.filter((r) => r[key] === reference(r)).length;
  return `${agree}/${rated.length} (${Math.round((100 * agree) / rated.length)}%)`;
};

console.log("");
if (!labeled.length) {
  console.log("No task has a human label yet (`label` in test/triage-benchmark.json); comparing with `suggested`.");
} else if (labeled.length < rows.length) {
  console.log(`${rows.length - labeled.length} task(s) without a label are left out of the scores.`);
}
console.log(`Agreement  floor alone: ${pct("floor")}  model alone: ${pct("model")}  triage: ${pct("proposed")}`);
const tiers: Tier[] = ["S", "M", "L", "XL"];
console.log(`\n${"ref \\ got".padEnd(10)}${tiers.map((t) => t.padStart(4)).join("")}`);
for (const ref of tiers) {
  const counts = tiers.map((got) => scored.filter((r) => reference(r) === ref && r.proposed === got).length);
  console.log(`${ref.padEnd(10)}${counts.map((c) => String(c).padStart(4)).join("")}`);
}
const cost = rows.reduce((sum, r) => sum + r.costUsd, 0);
console.log(`\nModel spend: ≈$${cost.toFixed(4)}. M3-E1 target: triage agrees with the human label in ≥ 80% of tasks.`);
if (values.json) writeFileSync(values.json, `${JSON.stringify(rows, null, 2)}\n`);
