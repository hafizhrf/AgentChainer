import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { TaskContract, Tier, WorkspaceProfile } from "@agentchainer/protocol";
import benchmark from "../../test/triage-benchmark.json" with { type: "json" };
import { detectWorkspace } from "../detect/detect.ts";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { listFiles } from "../workspace.ts";
import { availableGates, normalizeContract } from "./contract.ts";
import { classify, maxTier, signals, staticPrefix, triageRecord } from "./triage.ts";

const profile = (packages: { path: string; test?: boolean }[]): WorkspaceProfile => ({
  stacks: ["node"],
  monorepo: packages.length > 1 ? "pnpm-workspace" : null,
  packages: packages.map((p) => ({
    path: p.path,
    stack: "node",
    packageManager: "pnpm",
    frameworks: [],
    testFrameworks: [],
    commands: p.test === false ? {} : { test: { run: "pnpm test", source: "package.json", confidence: "high" } },
  })),
  ci: [],
});

const contract = (over: Partial<TaskContract> = {}): TaskContract => ({
  task: "",
  objective: "",
  acceptanceCriteria: [],
  constraints: [],
  outOfScope: [],
  risks: [],
  affectedAreas: [],
  openQuestions: [],
  ...over,
});

const FILES = ["README.md", "package.json", "src/a.ts", "src/b.ts", "test/a.test.ts", "docs/x.md", "scripts/y.ts"];
const run = (request: string, c: Partial<TaskContract>, files = FILES, p = profile([{ path: "." }])) =>
  signals({ request, contract: contract(c), profile: p, files, truncated: false });
const floorOf = (r: ReturnType<typeof signals>, name: string) => r.signals.find((s) => s.signal === name)?.floor;

describe("triage signals", () => {
  it("reads the folder a path or glob names", () => {
    assert.equal(staticPrefix("src/**/*.ts"), "src");
    assert.equal(staticPrefix("./src/a.ts"), "src/a.ts");
    assert.equal(staticPrefix("src/"), "src");
    assert.equal(staticPrefix("*.md"), "");
    assert.equal(staticPrefix("src\\comp*\\x"), "src");
  });

  it("sets an L floor for risk keywords, as whole words with common endings", () => {
    assert.equal(run("Store login tokens", {}).floor, "L");
    assert.equal(run("Add a deploy job", {}).floor, "L");
    assert.equal(run("Restyle the app", { objective: "Theme tokens follow Material 3" }).floor, "S", "design tokens");
    assert.equal(run("Rotate access tokens daily", {}).floor, "L");
    assert.equal(run("Read the API key from the environment", {}).floor, "L");
    assert.equal(run("Show the author's name", {}).floor, "S", "author isn't auth");
    assert.equal(run("Fix the typo", { affectedAreas: ["src/auth/session.ts"] }).floor, "L", "paths count");
    assert.equal(run("Fix the typo", { risks: ["Could corrupt the database"] }).floor, "L");
  });

  it("ignores keywords in constraints and out-of-scope, which name what the task won't touch", () => {
    const r = run("Rename a button", { constraints: ["Don't touch the database schema"], outOfScope: ["auth"] });
    assert.equal(r.floor, "S");
  });

  it("sets an L floor for breadth, from the request and objective only", () => {
    assert.equal(floorOf(run("Rename the helper everywhere", {}), "breadth"), "L");
    assert.equal(floorOf(run("Migrate to ESM", {}), "breadth"), "L");
    assert.equal(floorOf(run("Fix it", { risks: ["used everywhere"] }), "breadth"), undefined);
  });

  it("scales the scope floor with the top-level parts and files touched", () => {
    assert.equal(floorOf(run("x", { affectedAreas: ["src/a.ts", "src/b.ts"] }), "scope"), null);
    assert.equal(floorOf(run("x", { affectedAreas: ["src/a.ts", "docs/x.md"] }), "scope"), "M");
    assert.equal(floorOf(run("x", { affectedAreas: ["src/a.ts", "test/a.test.ts"] }), "scope"), null, "tests");
    assert.equal(floorOf(run("x", { affectedAreas: ["README.md", "package.json"] }), "scope"), null, "root files");
    const four = run("x", { affectedAreas: ["src/", "docs/", "scripts/", "package.json"] });
    assert.equal(floorOf(four, "scope"), "L");
    const many = Array.from({ length: 45 }, (_, i) => `lib/f${i}.ts`);
    assert.equal(floorOf(run("x", { affectedAreas: ["lib/"] }, many), "scope"), "L");
  });

  it("counts monorepo packages, not their shared top folder, as parts", () => {
    const p = profile([{ path: "." }, { path: "packages/ui" }, { path: "packages/core" }]);
    const files = ["packages/ui/src/a.ts", "packages/core/src/b.ts"];
    const one = run("x", { affectedAreas: ["packages/ui/src/a.ts", "packages/ui/src/c.ts"] }, files, p);
    assert.equal(floorOf(one, "scope"), null);
    const two = run("x", { affectedAreas: ["packages/ui/src/a.ts", "packages/core/src/b.ts"] }, files, p);
    assert.equal(floorOf(two, "scope"), "M");
  });

  it("reports new areas, a large repo and missing tests", () => {
    const r = run("x", { affectedAreas: ["src/new.ts", "src/a.ts"] });
    assert.match(r.signals.find((s) => s.signal === "new-areas")?.detail ?? "", /src\/new\.ts/);
    const big = signals({
      request: "x",
      contract: contract(),
      profile: profile([{ path: ".", test: false }]),
      files: FILES,
      truncated: true,
    });
    assert.equal(floorOf(big, "repo-size"), "M");
    assert.equal(floorOf(big, "tests"), null);
  });
});

describe("triage record", () => {
  const found = { signals: [], floor: "L" as Tier };
  it("never proposes below the floor, and defaults the choice and the budget to the proposal", () => {
    const t = triageRecord(found, { model: { tier: "S", rationale: "tiny", confidence: "high" } });
    assert.deepEqual([t.proposed, t.chosen, t.budgetUsd], ["L", "L", 8]);
    const up = triageRecord(found, { model: { tier: "XL", rationale: "epic", confidence: "low" } });
    assert.equal(up.proposed, "XL");
  });

  it("falls back to the floor when the model failed", () => {
    const t = triageRecord({ signals: [], floor: "M" }, { model: null, error: "no login" });
    assert.deepEqual([t.proposed, t.modelError], ["M", "no login"]);
  });

  it("orders tiers", () => {
    assert.equal(maxTier("S", "M"), "M");
    assert.equal(maxTier("XL", "L"), "XL");
  });
});

describe("classify", () => {
  /** A stand-in SDK whose query yields the given messages (or throws). */
  const sdk = (messages: unknown[] | Error) =>
    ({
      query: () =>
        (async function* () {
          if (messages instanceof Error) throw messages;
          yield* messages;
        })(),
    }) as unknown as AgentSdkModule;
  const result = (extra: object) => ({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.002,
    result: "",
    ...extra,
  });

  it("reads structured output, or a JSON reply", async () => {
    const answer = { tier: "M", rationale: "One module.", confidence: "high" };
    assert.deepEqual((await classify(sdk([result({ structured_output: answer })]), "claude", "/", "p")).model, answer);
    const text = await classify(sdk([result({ result: `Here: ${JSON.stringify(answer)}` })]), "claude", "/", "p");
    assert.deepEqual([text.model, text.costUsd], [answer, 0.002]);
  });

  it("returns errors instead of throwing, unless cancelled", async () => {
    const bad = await classify(sdk([result({ structured_output: { tier: "XXL" } })]), "claude", "/", "p");
    assert.equal(bad.model, null);
    assert.match(bad.error ?? "", /valid/);
    const stopped = await classify(
      sdk([{ type: "result", subtype: "error_max_turns", total_cost_usd: 0 }]),
      "c",
      "/",
      "p",
    );
    assert.match(stopped.error ?? "", /error_max_turns/);
    assert.match((await classify(sdk(new Error("spawn failed")), "c", "/", "p")).error ?? "", /spawn failed/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(classify(sdk(new Error("aborted")), "c", "/", "p", controller), /aborted/);
  });
});

describe("triage benchmark (no model calls)", () => {
  after(removeFixtureCopies);
  const ORDER: Record<Tier, number> = { S: 0, M: 1, L: 2, XL: 3 };
  const copies = new Map<string, string>();

  it("has at least 20 tasks over every tier", () => {
    assert.ok(benchmark.tasks.length >= 20);
    for (const tier of ["S", "M", "L", "XL"])
      assert.ok(
        benchmark.tasks.some((t) => t.suggested === tier),
        tier,
      );
    assert.equal(new Set(benchmark.tasks.map((t) => t.id)).size, benchmark.tasks.length, "unique ids");
  });

  it("never sets a floor above the suggested tier (the rules must not over-trigger)", () => {
    for (const t of benchmark.tasks) {
      const dir = copies.get(t.fixture) ?? copyFixture(t.fixture);
      copies.set(t.fixture, dir);
      const p = detectWorkspace(dir);
      const listing = listFiles(dir);
      const r = signals({
        request: t.request,
        contract: normalizeContract(t.request, t.contract, availableGates(p)),
        profile: p,
        files: listing.files.map((f) => f.path),
        truncated: listing.truncated,
      });
      const why = r.signals.map((s) => `${s.signal}=${s.floor}: ${s.detail}`).join("; ");
      assert.ok(ORDER[r.floor] <= ORDER[t.suggested as Tier], `${t.id}: floor ${r.floor} > ${t.suggested} (${why})`);
    }
  });
});
