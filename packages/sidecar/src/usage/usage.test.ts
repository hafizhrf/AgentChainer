import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { Task } from "@agentchainer/protocol";
import { claudeCostUsd, claudePriceOf } from "./claude-prices.ts";
import { parseAccount } from "./codex-account.ts";
import { type AgentRun, readRuns, recordRun } from "./ledger.ts";
import { clearUsageCache, familyOf, type StoredSession, tallySession, usageFile, usageReport } from "./report.ts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("Claude's API prices (CP-01)", () => {
  it("prices a model by its id or the longest one it extends", () => {
    assert.equal(claudePriceOf("claude-opus-5-5")?.input, 4);
    assert.equal(claudePriceOf("claude-opus-5")?.input, 5);
    assert.equal(claudePriceOf("claude-opus-4-5-20251101")?.output, 25);
    assert.equal(claudePriceOf("claude-sonnet-4-6[1m]")?.input, 3);
    assert.equal(claudePriceOf("claude-instant-1"), null);
  });

  it("charges cache reads and both kinds of cache writes at their own rates", () => {
    // Opus 5.5: input $4, output $20, cache reads $0.20, 5m writes $5, 1h writes $8, per million.
    const usd = claudeCostUsd("claude-opus-5-5", {
      input: 1000,
      output: 100,
      cacheRead: 10_000,
      cacheWrite: 3000,
      cacheWrite1h: 1000,
    });
    assert.ok(close(usd ?? 0, (1000 * 4 + 100 * 20 + 10_000 * 0.2 + 2000 * 5 + 1000 * 8) / 1e6));
  });

  it("prices a Haiku 5.5 request over 100,000 prompt tokens higher", () => {
    const short = claudeCostUsd("claude-haiku-5-5", { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 }) ?? 0;
    const long = claudeCostUsd("claude-haiku-5-5", { input: 1000, output: 0, cacheRead: 100_000, cacheWrite: 0 }) ?? 0;
    assert.ok(close(short, (1000 * 0.1) / 1e6));
    assert.ok(close(long, (1000 * 0.5 + 100_000 * 0.05) / 1e6));
  });
});

const assistant = (id: string, model: string, input: number, output: number, cacheRead = 0) => ({
  message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead } },
});

describe("a session's tokens (CP-01)", () => {
  it("counts each response once, though history splits it into a message per block", () => {
    const tally = tallySession([
      { message: { role: "user", content: "hi" } },
      assistant("msg_1", "claude-haiku-5-5", 100, 20),
      assistant("msg_1", "claude-haiku-5-5", 100, 20),
      assistant("msg_2", "claude-opus-5-5", 50, 10, 1000),
      { message: { id: "msg_3", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } },
    ]);
    assert.deepEqual([...tally.keys()], ["claude-haiku-5-5", "claude-opus-5-5"]);
    assert.equal(tally.get("claude-haiku-5-5")?.input, 100);
    assert.equal(tally.get("claude-opus-5-5")?.cacheRead, 1000);
  });

  it("puts each model in a fixed family", () => {
    assert.deepEqual(
      [
        "claude-opus-5-5",
        "claude-sonnet-4-6",
        "claude-haiku-5-5",
        "claude-fable-5-1",
        "gpt-6-luna",
        "gemini-3.8-flash-low",
        "x",
      ].map(familyOf),
      ["opus", "sonnet", "haiku", "fable", "codex", "agy", "other"],
    );
  });
});

describe("the usage report (CP-01)", () => {
  beforeEach(() => clearUsageCache());
  const now = new Date("2026-11-10T12:00:00");
  const day = (d: number) => new Date(`2026-11-${String(d).padStart(2, "0")}T10:00:00`).getTime();
  const sessions: StoredSession[] = [
    { sessionId: "s1", summary: "Fix the cart", lastModified: day(9), cwd: "/w/shop" },
    { sessionId: "s2", summary: "Old work", lastModified: day(1), cwd: "/w/shop" },
    { sessionId: "s3", summary: "Docs", customTitle: "Write docs", lastModified: day(10), cwd: "/w/site" },
  ];
  const messages: Record<string, { message: unknown }[]> = {
    s1: [assistant("a", "claude-opus-5-5", 1000, 100)],
    s2: [assistant("b", "claude-haiku-5-5", 1000, 100)],
    s3: [assistant("c", "claude-haiku-5-5", 2000, 200), assistant("d", "mystery-model", 10, 5)],
  };
  const task = {
    id: "2026-11-10-aaaaaaaa",
    title: "Count quantity",
    request: "Count quantity",
    run: {
      steps: [
        {
          id: "plan",
          step: "plan",
          label: "Plan",
          kind: "agent",
          status: "done",
          agent: "claude",
          costUsd: 0.01,
          startedAt: "2026-11-10T09:00:00.000Z",
        },
        {
          id: "implement",
          step: "implement",
          label: "Implement",
          kind: "agent",
          status: "done",
          agent: "codex",
          model: "gpt-6-luna",
          costKind: "estimate",
          tokens: { input: 5000, output: 100 },
          costUsd: 0.002,
          sessionId: "thread-1",
          startedAt: "2026-11-10T09:01:00.000Z",
          endedAt: "2026-11-10T09:02:00.000Z",
        },
      ],
    },
  } as unknown as Task;
  const src = {
    sessions: async () => sessions,
    messages: async (s: StoredSession) => messages[s.sessionId] ?? [],
    tasks: (root: string) => (root === "/w/shop" ? [task] : []),
    runs: () => [] as AgentRun[],
  };

  it("sums the period's sessions and the tasks' Codex steps by model, project and day", async () => {
    const r = await usageReport(src, { sinceDays: 7, workspaces: ["/w/shop"], now });
    assert.equal(r.totals.sessions, 3, "s1, s3 and the Codex step; s2 is older than a week");
    assert.deepEqual(
      r.byModel.map((m) => m.model),
      ["claude-opus-5-5", "gpt-6-luna", "claude-haiku-5-5", "mystery-model"],
    );
    const mystery = r.byModel.find((m) => m.model === "mystery-model");
    assert.equal(mystery?.costUsd, 0);
    assert.equal(mystery?.unpricedTokens, 15);
    assert.equal(r.totals.unpricedTokens, 15);
    assert.deepEqual(
      r.byProject.map((p) => [p.project, p.sessions]),
      [
        ["/w/shop", 2],
        ["/w/site", 1],
      ],
    );
    assert.deepEqual(
      r.byDay.map((d) => d.day),
      ["2026-11-09", "2026-11-10"],
    );
    assert.ok(close(r.byDay[1]?.costUsd.codex ?? 0, 0.002));
    assert.equal(r.sessions.find((s) => s.source === "codex")?.title, "Count quantity · Implement");
    assert.equal(r.sessions.find((s) => s.id === "s3")?.title, "Write docs");
  });

  it("covers all time without a period, and reads an unchanged session once", async () => {
    let reads = 0;
    const counting = {
      ...src,
      messages: async (s: StoredSession) => {
        reads++;
        return messages[s.sessionId] ?? [];
      },
    };
    const all = await usageReport(counting, { sinceDays: null, workspaces: [], now });
    await usageReport(counting, { sinceDays: null, workspaces: [], now });
    assert.equal(all.totals.sessions, 3);
    assert.equal(reads, 3);
  });

  it("exports every row as CSV, quoting and defusing cells, or the whole report as JSON", async () => {
    const r = await usageReport(
      { ...src, sessions: async () => [{ sessionId: "s9", summary: '=SUM(A1), "quoted"', lastModified: day(10) }] },
      { sinceDays: null, workspaces: [], now },
    );
    const messagesFor = r;
    assert.equal(messagesFor.sessions.length, 0, "a session with no responses isn't listed");
    const withRow = await usageReport(
      {
        ...src,
        sessions: async () => [{ sessionId: "s1", summary: '=SUM(A1), "quoted"', lastModified: day(10), cwd: "/w" }],
      },
      { sinceDays: null, workspaces: [], now },
    );
    const csv = usageFile(withRow, "csv");
    assert.equal(csv.rows, 1);
    const [head, row] = csv.text.trim().split("\n");
    assert.equal(head, "day,source,project,title,models,tokens,unpriced_tokens,est_cost_usd,id");
    assert.match(row ?? "", /^2026-11-10,claude,\/w,"'=SUM\(A1\), ""quoted""",claude-opus-5-5,1100,0,/);
    assert.deepEqual(JSON.parse(usageFile(withRow, "json").text).totals.sessions, 1);
  });
});

describe("the app's record of Codex and agy runs (CP-01)", () => {
  it("appends a line per turn, skips a broken one, and records nothing without a folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ac-usage-"));
    try {
      const env = { AGENTCHAINER_USAGE_DIR: path.join(dir, "usage") };
      const run = { agent: "codex" as const, model: "gpt-6-luna", input: 1000, output: 50, cwd: "/w", sessionId: "t1" };
      recordRun({ ...run, costUsd: 0.0001, costKind: "estimate" }, env);
      appendFileSync(path.join(dir, "usage", "agent-runs.jsonl"), '{"at":"cut short\n');
      recordRun({ ...run, agent: "agy", model: "agy", costUsd: 0, sessionId: "c1" }, env);
      const runs = readRuns(env);
      assert.deepEqual(
        runs.map((r) => [r.agent, r.sessionId, r.costKind]),
        [
          ["codex", "t1", "estimate"],
          ["agy", "c1", "unknown"],
        ],
      );
      recordRun({ ...run, costUsd: 0 }, {});
      assert.deepEqual(readRuns({}), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts recorded runs on their own days, as one session row, and doesn't count a task step twice", async () => {
    clearUsageCache();
    const now = new Date("2026-11-10T12:00:00");
    const runs: AgentRun[] = [
      {
        at: "2026-11-09T10:00:00",
        agent: "codex",
        model: "gpt-6-luna",
        input: 1000,
        output: 10,
        costUsd: 0.001,
        costKind: "estimate",
        cwd: "/tmp/fixture",
        sessionId: "thread-1",
        title: "Count quantity · Implement",
      },
      {
        at: "2026-11-10T10:00:00",
        agent: "codex",
        model: "gpt-6-luna",
        input: 2000,
        output: 20,
        costUsd: 0.002,
        costKind: "estimate",
        cwd: "/tmp/fixture",
        sessionId: "thread-1",
        title: "Count quantity · Implement",
      },
      {
        at: "2026-11-10T11:00:00",
        agent: "agy",
        model: "agy",
        input: 500,
        output: 5,
        costUsd: 0,
        costKind: "unknown",
        cwd: "/w/shop",
        sessionId: "conv-1",
      },
    ];
    const step = {
      id: "implement",
      step: "implement",
      label: "Implement",
      kind: "agent",
      status: "done",
      agent: "codex",
      model: "gpt-6-luna",
      costKind: "estimate",
      tokens: { input: 3000, output: 30 },
      costUsd: 0.003,
      sessionId: "thread-1",
      startedAt: "2026-11-10T09:00:00.000Z",
    };
    const r = await usageReport(
      {
        sessions: async () => [],
        messages: async () => [],
        tasks: () => [
          {
            id: "2026-11-10-bbbbbbbb",
            title: "Count quantity",
            request: "x",
            run: { steps: [step] },
          } as unknown as Task,
        ],
        runs: () => runs,
      },
      { sinceDays: 7, workspaces: ["/w/shop"], now },
    );
    assert.equal(r.totals.sessions, 2, "thread-1 once, conv-1; the task's step is the recorded thread");
    assert.ok(close(r.totals.costUsd, 0.003));
    assert.equal(r.totals.unpricedTokens, 505);
    assert.deepEqual(
      r.byDay.map((d) => [d.day, Number((d.costUsd.codex ?? 0).toFixed(3))]),
      [
        ["2026-11-09", 0.001],
        ["2026-11-10", 0.002],
      ],
    );
    const thread = r.sessions.find((s) => s.id === "thread-1");
    assert.deepEqual([thread?.day, thread?.tokens, thread?.source], ["2026-11-10", 3030, "codex"]);
  });
});

describe("Codex's account usage (CP-01)", () => {
  it("keeps daily tokens, the lifetime total and each quota window, and drops account details", () => {
    const usage = parseAccount(
      {
        id: 2,
        result: {
          summary: { lifetimeTokens: 550_356_042, peakDailyTokens: 155_199_772 },
          dailyUsageBuckets: [
            { startDate: "2026-10-29", tokens: 47_060_094 },
            { startDate: "2026-10-30", tokens: 21_344_658 },
          ],
          threadUsage: null,
        },
      },
      {
        id: 3,
        result: {
          accountId: "acct-secret",
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 4, windowDurationMins: 43_200, resetsAt: 1_796_485_138 },
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              planType: "free",
              primary: { usedPercent: 4, windowDurationMins: 43_200, resetsAt: 1_796_485_138 },
              secondary: null,
            },
          },
        },
      },
    );
    assert.equal(usage.available, true);
    assert.equal(usage.plan, "free");
    assert.equal(usage.lifetimeTokens, 550_356_042);
    assert.deepEqual(
      usage.daily?.map((d) => d.day),
      ["2026-10-29", "2026-10-30"],
    );
    assert.deepEqual(usage.limits, [
      {
        name: "codex",
        which: "primary",
        usedPercent: 4,
        windowMins: 43_200,
        resetsAt: new Date(1_796_485_138_000).toISOString(),
      },
    ]);
    assert.doesNotMatch(JSON.stringify(usage), /acct-secret/);
  });

  it("says when the login can't read account usage", () => {
    const usage = parseAccount(
      { id: 2, error: { message: "chatgpt authentication required to read token usage" } },
      { id: 3 },
    );
    assert.deepEqual(usage, { available: false, reason: "needsChatgpt" });
  });
});
