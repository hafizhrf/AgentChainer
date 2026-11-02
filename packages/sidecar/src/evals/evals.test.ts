import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Task } from "@agentchainer/protocol";
import { removeFixtureCopies } from "../detect/fixture-copy.ts";
import { WORKFLOWS_DIR } from "../tasks/project-workflows.ts";
import type { SidecarClient } from "./client.ts";
import {
  delta,
  type EvalReport,
  libraryInputs,
  meanDiff,
  rateDiff,
  renderMarkdown,
  sha256,
  summarize,
  wilson,
} from "./report.ts";
import { type CaseRun, runCase } from "./run-case.ts";
import { type EvalCase, parseVariant, readSuite, type Variant } from "./suite.ts";

after(() => removeFixtureCopies());

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const evalsDir = fileURLToPath(new URL("../../test/evals/", import.meta.url));
const suite = readSuite(path.join(evalsDir, "suite.json"));
const app: Variant = { name: "app", model: "haiku", workflows: {}, workflowsFrom: null };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-4;

/**
 * A stand-in for the sidecar: the run "ends" Done after `work` changes the workspace, the way an agent would. Every
 * request is recorded.
 */
function fakeClient(work: (cwd: string) => void, cost = 0.05) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const listeners = new Set<(t: Task) => void>();
  const task = (cwd: string, over: Partial<Task>) => ({ id: "t-1", costUsd: cost, cwd, ...over }) as unknown as Task;
  const client = {
    calls,
    onUpdate(f: (t: Task) => void) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    ended(id: string) {
      return new Promise<Task>((resolve) => {
        const f = (t: Task) => t.id === id && t.state === "done" && resolve(t);
        listeners.add(f);
      });
    },
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      const cwd = params.cwd as string;
      if (method === "task.retriage") {
        return task(cwd, {
          contract: params.contract as Task["contract"],
          triage: { proposed: "S", budgetUsd: 1 } as Task["triage"],
        });
      }
      if (method === "task.start") {
        work(cwd);
        setImmediate(() => {
          for (const f of listeners) {
            f(task(cwd, { state: "done", run: { gates: [], fixRounds: 1 } as unknown as Task["run"] }));
          }
        });
      }
      return task(cwd, { state: "draft" });
    },
  };
  return client;
}

const caseOf = (id: string) => suite.cases.find((c) => c.id === id) as EvalCase;
const hiddenRoot = path.join(evalsDir, "hidden");

describe("eval suite (M7-02)", () => {
  it("parses, and every hidden case has its hidden files", () => {
    assert.ok(suite.cases.length >= 6);
    for (const c of suite.cases) {
      assert.equal(existsSync(path.join(hiddenRoot, c.id)), c.hidden, c.id);
    }
  });

  it("passes a run whose change makes the hidden checks pass, after copying them in", async () => {
    const client = fakeClient((cwd) => {
      const file = path.join(cwd, "src/cart.js");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("sum += item.price;", "sum += item.price * item.quantity;"),
      );
    });
    const row = await runCase(client as unknown as SidecarClient, caseOf("sample-quantity"), app, {
      hiddenRoot,
      cancelAbove: 5,
    });
    assert.deepEqual(
      [row.passed, row.state, row.costUsd, row.fixRounds, row.checks],
      [
        true,
        "done",
        0.05,
        1,
        [
          { name: "fixture tests", exitCode: 0 },
          { name: "hidden test", exitCode: 0 },
        ],
      ],
    );
    // Approved as written, at the case's tier, run with the variant's model.
    const approve = client.calls.find((c) => c.method === "task.approve")?.params;
    assert.equal(approve?.tier, "S");
    assert.equal(client.calls.find((c) => c.method === "task.start")?.params.model, "haiku");
  });

  it("fails a run the hidden checks catch, even when the task says Done", async () => {
    // Clamps only the top end: the hidden test also checks a negative percentage.
    const client = fakeClient((cwd) => {
      const file = path.join(cwd, "src/cart.js");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("(1 - percent / 100)", "(1 - Math.min(percent, 100) / 100)"),
      );
    });
    const row = await runCase(client as unknown as SidecarClient, caseOf("sample-discount-clamp"), app, {
      hiddenRoot,
      cancelAbove: 5,
    });
    assert.equal(row.state, "done");
    assert.equal(row.passed, false);
    assert.notEqual(row.checks[0]?.exitCode, 0);
  });

  it("puts a variant's workflows in the fixture copy before the run", async () => {
    let seen = "";
    const client = fakeClient((cwd) => {
      seen = readFileSync(path.join(cwd, WORKFLOWS_DIR, "s.yaml"), "utf8");
    });
    const variant = parseVariant("main:workflows-ref=HEAD,model=sonnet", repoRoot);
    await runCase(client as unknown as SidecarClient, caseOf("sample-with-tax"), variant, {
      hiddenRoot,
      cancelAbove: 5,
    });
    assert.equal(seen, variant.workflows["s.yaml"]);
    assert.equal(client.calls.find((c) => c.method === "task.start")?.params.model, "sonnet");
  });
});

describe("variants", () => {
  it("parses names, models and workflow sources", () => {
    assert.deepEqual(parseVariant("app", repoRoot), app);
    assert.equal(parseVariant("big:model=sonnet", repoRoot).model, "sonnet");
    const dir = mkdtempSync(path.join(tmpdir(), "ac-eval-wf-"));
    writeFileSync(path.join(dir, "s.yaml"), "id: tier-s\n");
    assert.deepEqual(Object.keys(parseVariant(`mine:workflows=${dir}`, repoRoot).workflows), ["s.yaml"]);
    const ref = parseVariant("main:workflows-ref=HEAD", repoRoot);
    assert.deepEqual(Object.keys(ref.workflows), ["s.yaml", "m.yaml", "l.yaml", "xl.yaml"]);
    assert.equal(ref.workflowsFrom, "catalog/workflows@HEAD");
  });

  it("refuses unknown keys, empty values and odd names", () => {
    assert.throws(() => parseVariant("a:temperature=1", repoRoot), /unknown key/);
    assert.throws(() => parseVariant("a:model=", repoRoot), /no value/);
    assert.throws(() => parseVariant("a b", repoRoot), /name it/);
  });
});

describe("report", () => {
  it("gives Wilson and Newcombe intervals", () => {
    assert.equal(wilson(0, 0), null);
    const w = wilson(5, 10) ?? [0, 0];
    assert.ok(close(w[0], 0.2366) && close(w[1], 0.7634), String(w));
    const all = wilson(3, 3) ?? [0, 0];
    assert.ok(close(all[1], 1) && all[0] > 0.4 && all[0] < 0.5, String(all));
    const d = rateDiff(19, 20, 10, 20);
    assert.ok(d && close(d.diff, 0.45) && d.interval[0] > 0 && d.interval[1] < 1, JSON.stringify(d));
    assert.ok((rateDiff(2, 3, 1, 3)?.interval[0] ?? 0) < 0, "a small N straddles 0");
  });

  it("gives a mean difference with an interval only from two samples a side", () => {
    assert.deepEqual(meanDiff([0.2], [0.1]), { diff: 0.2 - 0.1, interval: null });
    const d = meanDiff([0.1, 0.1, 0.1], [0.2, 0.2, 0.2]);
    assert.ok(d?.interval && close(d.diff, -0.1) && close(d.interval[0], -0.1) && close(d.interval[1], -0.1));
  });

  it("sums a variant and reads its delta against the baseline", () => {
    const row = (variant: string, c: string, passed: boolean, costUsd: number): CaseRun => ({
      case: c,
      variant,
      passed,
      state: passed ? "done" : "failed",
      gatesPassed: passed,
      failedGates: passed ? [] : ["test `npm test`"],
      costUsd,
      durationMs: 60_000,
      fixRounds: passed ? 0 : 1,
      checks: [{ name: "hidden test", exitCode: passed ? 0 : 1 }],
    });
    const runs: CaseRun[] = [
      row("app", "a", true, 0.1),
      row("app", "a", false, 0.3),
      row("app", "b", true, 0.1),
      row("new", "a", true, 0.05),
      row("new", "a", true, 0.06),
      { ...row("new", "b", true, 0.05), state: "failed" as const, failedGates: ["lint `golangci-lint run`"] },
    ];
    const base = summarize(app, runs, ["a", "b"]);
    assert.deepEqual([base.runs, base.passes, base.fixRounds], [3, 2, 1]);
    assert.ok(close(base.costPerPass ?? 0, 0.25), "failed runs' cost counts against the passes");
    assert.deepEqual(base.cases[0], {
      case: "a",
      runs: 2,
      passes: 1,
      costUsd: 0.2,
      durationMs: 60_000,
      fixRounds: 1,
    });
    const next = summarize({ ...app, name: "new", workflows: { "s.yaml": "x" } }, runs, ["a", "b"]);
    assert.equal(next.workflows["s.yaml"], sha256("x"));
    const d = delta(next, base, runs);
    assert.match(d.verdict, /no clear difference in passes.*may be noise/);
    const report: EvalReport = {
      version: 1,
      generatedAt: "2026-11-03T00:00:00.000Z",
      app: { commit: "abc", dirty: false },
      suite: { file: "test/evals/suite.json", cases: ["a", "b"] },
      n: 2,
      maxUsd: 3,
      spentUsd: 0.66,
      skipped: 0,
      inputs: { "catalog/workflows/s.yaml": sha256("s") },
      variants: [base, next],
      deltas: [d],
      runs,
    };
    const md = renderMarkdown(report);
    assert.match(md, /\| app \| haiku \| the app's \| 2\/3 \(67%\) \|/);
    assert.match(md, /## Against app/);
    assert.match(md, /- app \/ a: failed; hidden test → 1/);
    assert.match(md, /- new \/ b: failed; failed gates: lint `golangci-lint run`/);
    assert.match(md, /`catalog\/workflows\/s\.yaml` [0-9a-f]{12}/);
  });

  it("hashes the tier workflows and the role prompts, with LF line ends", () => {
    const inputs = libraryInputs(repoRoot);
    assert.ok("catalog/workflows/s.yaml" in inputs && "agents/ac-implementer.md" in inputs);
    const text = readFileSync(path.join(repoRoot, "catalog/workflows/s.yaml"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(inputs["catalog/workflows/s.yaml"], sha256(text));
  });
});
