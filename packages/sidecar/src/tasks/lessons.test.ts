import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { type GateRun, resultEnglish, resultText, setLanguage } from "@agentchainer/protocol";
import { listRuns, rollback } from "../bootstrap/apply.ts";
import { copyFixture, removeFixtureCopies } from "../detect/fixture-copy.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import type { Evidence } from "./evidence.ts";
import {
  applyLessons,
  dismissedLessons,
  dismissLessons,
  isDuplicate,
  lessonSignals,
  previewLessons,
  storedLessons,
  suggestLessons,
  withLessons,
} from "./lessons.ts";

after(() => removeFixtureCopies());

const gate = (kind: GateRun["kind"], round: number, exitCode: number, over: Partial<GateRun> = {}): GateRun => ({
  kind,
  command: kind === "typecheck" ? "pnpm typecheck" : kind,
  package: ".",
  exitCode,
  timedOut: false,
  durationMs: 10,
  tail: exitCode ? "src/a.ts(3,1): error TS2304: Cannot find name 'x'." : "",
  round,
  at: "2026-11-03T00:00:00.000Z",
  ...over,
});

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    version: 1,
    generatedAt: "2026-11-03T00:00:00.000Z",
    task: {
      id: "2026-11-03-0000aaaa",
      request: "Fix the totals",
      objective: "Totals add up",
      tier: "S",
      proposed: "S",
      budgetUsd: 1,
    },
    outcome: { state: "done", text: "Done." },
    files: [],
    subtasks: [],
    merges: [],
    gates: { baseline: [], runs: [], notRun: [], preexisting: [], fixedByTask: [] },
    criteria: [],
    review: null,
    noReview: null,
    security: {
      guardBlocks: [],
      approvals: [],
      secrets: { ran: false, findings: [] },
    } as unknown as Evidence["security"],
    risks: { contract: [], fromImplementer: [], manual: [] },
    cost: { steps: [], runUsd: 0, totalUsd: 0 },
    ...over,
  };
}

const rich = () =>
  evidence({
    gates: {
      baseline: [gate("test", 0, 1)],
      runs: [
        gate("typecheck", 0, 2),
        gate("typecheck", 1, 0),
        gate("test", 0, 1),
        gate("test", 1, 1),
        gate("format", 0, 0, { changed: ["src/a.ts", "src/b.ts"] }),
      ],
      notRun: [],
      preexisting: ["test"],
      fixedByTask: [],
    },
    review: {
      verdict: "changes-requested",
      findings: [
        { severity: "must-fix", file: "src/cart.js", text: "Rounds half down; the spec says half up." },
        { severity: "note", text: "Nice tests." },
      ],
      criteria: [],
    },
    security: {
      guardBlocks: [{ stepId: "implement", tool: "Bash", target: "rm -rf dist", reason: "a recursive delete", at: "" }],
      approvals: [
        {
          stepId: "implement",
          label: "Implement",
          tool: "Bash",
          target: "npm publish",
          risk: "high",
          reasons: [],
          allowed: false,
          always: false,
        },
        {
          stepId: "implement",
          label: "Implement",
          tool: "Bash",
          target: "npm test",
          risk: "low",
          reasons: [],
          allowed: true,
          always: false,
        },
      ],
      secrets: { ran: false, findings: [] },
    } as unknown as Evidence["security"],
    risks: { contract: [], fromImplementer: ["The cart module has no types."], manual: [] },
  });

describe("lesson signals (M8-06)", () => {
  it("finds a gate fixed in a later round, a formatter's rewrite, review findings, blocks, denials and notes", () => {
    const signals = lessonSignals(rich());
    assert.deepEqual(
      signals.map((s) => s.ref),
      ["gate:typecheck", "format:format", "review:1", "guard:1", "approval:1", "notes:1"],
    );
    assert.match(signals[0]?.text ?? "", /`pnpm typecheck` failed, then passed after a fix:\n.*TS2304/);
    assert.match(signals[1]?.text ?? "", /rewrote 2 file\(s\): src\/a\.ts, src\/b\.ts/);
    assert.ok(!signals.some((s) => s.ref === "gate:test"), "a gate failing before the task isn't a lesson");
    assert.ok(!signals.some((s) => s.text.includes("Nice tests")), "a note-level finding isn't one");
  });

  it("finds nothing in a clean run", () => {
    assert.deepEqual(lessonSignals(evidence()), []);
  });

  it("gives the app's own signals a ref that says in English what the text says; the implementer's words have none", async () => {
    const signals = lessonSignals(rich());
    for (const s of signals.filter((s) => s.source !== "notes")) {
      assert.ok(s.textRef, s.ref);
      assert.equal(resultEnglish(s.textRef), s.text, s.ref);
    }
    assert.equal(signals.find((s) => s.source === "notes")?.textRef, undefined);
    await setLanguage("id");
    try {
      assert.deepEqual(
        signals.map((s) => (s.textRef ? resultText(s.textRef) : s.text)),
        [
          "`pnpm typecheck` gagal, lalu lulus setelah diperbaiki:\nsrc/a.ts(3,1): error TS2304: Cannot find name 'x'.",
          "Formatter menulis ulang 2 file: src/a.ts, src/b.ts",
          "must-fix di src/cart.js: Rounds half down; the spec says half up.",
          "Bash `rm -rf dist` diblokir: a recursive delete",
          "Anda menolak Bash `npm publish`",
          "The cart module has no types.",
        ],
      );
    } finally {
      await setLanguage("en");
    }
  });

  it("clips a long signal and its ref alike, or drops the ref when the cut can't be said the same way", () => {
    const long = "x".repeat(400);
    const e = rich();
    e.gates.runs = [gate("typecheck", 0, 2, { tail: long }), gate("typecheck", 1, 0)];
    e.security.approvals = [{ ...e.security.approvals[0], target: long } as (typeof e.security.approvals)[number]];
    const signals = lessonSignals(e);
    const fixed = signals.find((s) => s.source === "gate");
    assert.equal(fixed?.text.length, 301);
    assert.ok(fixed?.text.endsWith("x…"));
    assert.ok(fixed?.textRef, "the cut falls in git's output, which ends the message");
    assert.equal(resultEnglish(fixed.textRef), fixed.text);
    const denied = signals.find((s) => s.source === "approval");
    assert.equal(denied?.text.length, 301);
    assert.equal(denied?.textRef, undefined, "the cut falls before the closing backtick");
  });
});

describe("lesson duplicates (M8-06)", () => {
  it("drops what CLAUDE.md already says or was dismissed, in other words or case", () => {
    assert.equal(
      isDuplicate("Run pnpm typecheck before finishing.", ["Always run `pnpm typecheck` before finishing a task"]),
      true,
    );
    assert.equal(isDuplicate("Round money half up in src/cart.js.", ["Run pnpm typecheck before finishing."]), false);
    assert.equal(isDuplicate("Never run npm publish from a task.", ["Never run npm publish."]), true);
    assert.equal(
      isDuplicate("Use pnpm, not npm, for every script in this repository.", ["Use pnpm."]),
      false,
      "a short line",
    );
  });
});

describe("lessons in CLAUDE.md (M8-06)", () => {
  it("adds a Lessons section at the end, or bullets to the one there, keeping the rest as it was", () => {
    const from = "task “Fix”, 2026-11-03";
    assert.equal(
      withLessons("", [{ text: "Run the tests." }], from),
      `## Lessons\n\n- Run the tests. (from ${from})\n`,
    );
    const md = "# App\n\nUse pnpm.\n\n## Lessons\n\n- Old one.\n\n## Later\n\nMore.\n";
    assert.equal(
      withLessons(md, [{ text: "New one." }], from),
      `# App\n\nUse pnpm.\n\n## Lessons\n\n- Old one.\n- New one. (from ${from})\n\n## Later\n\nMore.\n`,
    );
  });

  it("previews, applies as a History run that rolls back, and dismisses the lessons not picked", () => {
    const root = copyFixture("sample-app");
    const id = "2026-11-03-0000aaaa";
    writeFileSync(path.join(root, "CLAUDE.md"), "# Sample\n\nUse node --test.\n");
    const dir = path.join(root, ".agentchainer", "tasks", id);
    // Suggestions as a model call would have stored them, in a workspace that has dismissed nothing yet.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "lessons.json"),
      JSON.stringify({
        lessons: [
          { id: "a1", text: "Round money half up.", why: "Review", sources: [] },
          { id: "b2", text: "Never publish from a task.", why: "Denied", sources: [] },
        ],
      }),
    );
    const preview = previewLessons(root, id, ["a1"], "task “Fix”, 2026-11-03");
    assert.equal(preview.path, "CLAUDE.md");
    assert.match(preview.after, /## Lessons\n\n- Round money half up\. \(from task “Fix”, 2026-11-03\)\n$/);
    const { runId } = applyLessons(root, id, ["a1"], "task “Fix”, 2026-11-03", "v1");
    assert.match(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /Round money half up/);
    assert.deepEqual(dismissedLessons(root), ["Never publish from a task."]);
    assert.deepEqual(storedLessons(root, id), []);
    assert.equal(listRuns(root)[0]?.runId, runId);
    assert.equal(listRuns(root)[0]?.actions[0]?.title, "Add 1 lesson to CLAUDE.md");
    const undone = rollback(root, runId, { cli: null });
    assert.ok(
      undone.every((r) => r.status === "rolled-back"),
      JSON.stringify(undone),
    );
    assert.ok(!listRuns(root).some((r) => r.runId === runId), "the run is gone from History");
    assert.equal(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "# Sample\n\nUse node --test.\n");
  });

  it("refuses a lesson with a home-folder path or a key", () => {
    const root = copyFixture("sample-app");
    const id = "2026-11-03-0000bbbb";
    dismissLessons(root, id, []);
    const dir = path.join(root, ".agentchainer", "tasks", id);
    const one = (text: string) =>
      writeFileSync(
        path.join(dir, "lessons.json"),
        JSON.stringify({ lessons: [{ id: "x", text, why: "", sources: [] }] }),
      );
    one("Read C:\\Users\\me\\notes.txt first.");
    assert.throws(() => previewLessons(root, id, ["x"], "t"), /home-folder path/);
    one("Use the key ghp_abcdefghijklmnopqrstuvwxyz0123456789.");
    assert.throws(() => previewLessons(root, id, ["x"], "t"), /key or token/);
    // The shared redaction patterns (X-03): fine-grained tokens, URL credentials and private-key variables too.
    for (const text of [
      "Push with github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz.",
      "The test database is postgres://admin:hunter2@localhost/app.",
      "Set DEPLOY_PRIVATE_KEY=abc123xyz before deploying.",
    ]) {
      one(text);
      assert.throws(() => previewLessons(root, id, ["x"], "t"), /key or token/, text);
    }
    assert.equal(existsSync(path.join(root, ".agentchainer", "lessons.json")), true);
  });
});

describe("suggesting lessons (M8-06)", () => {
  /** A stand-in model that answers with `lessons`, and counts its calls. */
  function fakeModel(lessons: unknown[]) {
    const calls: string[] = [];
    const sdk = {
      query: ({ prompt }: { prompt: string }) => {
        calls.push(prompt);
        return (async function* () {
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: 0.004,
            structured_output: { lessons },
            result: "",
          };
        })();
      },
    } as unknown as AgentSdkModule;
    return { claude: { sdk, claudePath: "claude" }, calls };
  }

  it("makes no model call when nothing in the run points at a lesson", async () => {
    const root = copyFixture("sample-app");
    const { claude, calls } = fakeModel([]);
    const r = await suggestLessons(claude, root, "2026-11-03-0000cccc", evidence());
    assert.deepEqual([r.lessons, r.costUsd, calls.length], [[], 0, 0]);
    assert.match(r.note ?? "", /Nothing in this run/);
    // The note is live, never stored: it comes in the app's language.
    await setLanguage("id");
    try {
      const again = await suggestLessons(claude, root, "2026-11-03-0000cccc", evidence());
      assert.match(again.note ?? "", /^Tidak ada yang mengarah ke pelajaran dalam run ini/);
    } finally {
      await setLanguage("en");
    }
  });

  it("keeps the model's new lessons with their sources, and drops ones CLAUDE.md or a dismissal already has", async () => {
    const root = copyFixture("sample-app");
    writeFileSync(path.join(root, "CLAUDE.md"), "# Sample\n\n- Always run pnpm typecheck before finishing.\n");
    const id = "2026-11-03-0000dddd";
    dismissLessons(root, id, []);
    writeFileSync(
      path.join(root, ".agentchainer", "lessons.json"),
      JSON.stringify({ dismissed: ["Never run npm publish."] }),
    );
    const { claude, calls } = fakeModel([
      { text: "Run pnpm typecheck before finishing.", why: "It failed once.", sources: ["gate:typecheck"] },
      { text: "Never run npm publish from a task.", why: "Denied.", sources: ["approval:1"] },
      { text: "Round money half up, as the spec says.", why: "Review must-fix.", sources: ["review:1", "nope"] },
    ]);
    const r = await suggestLessons(claude, root, id, rich());
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /\[gate:typecheck\]/);
    assert.match(calls[0] ?? "", /Always run pnpm typecheck/);
    assert.deepEqual(
      r.lessons.map((l) => [l.text, l.sources.map((s) => s.ref)]),
      [["Round money half up, as the spec says.", ["review:1"]]],
    );
    assert.equal(r.costUsd, 0.004);
    assert.deepEqual(
      storedLessons(root, id).map((l) => l.text),
      ["Round money half up, as the spec says."],
    );
    // A source's ref is stored with it, so the lesson's sources show in the app's language when read back.
    const source = storedLessons(root, id)[0]?.sources[0];
    assert.equal(source?.textRef?.key, "lessons.signal.reviewIn");
    assert.deepEqual(source, r.lessons[0]?.sources[0]);
  });
});
