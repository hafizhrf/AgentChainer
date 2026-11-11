import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AgentEventSchema,
  agentProblems,
  CriterionCheckSchema,
  FeedbackCommentSchema,
  GitNameSchema,
  imageType,
  MemoryPathSchema,
  methodSchemas,
  PERMISSION_MODES,
  PermissionRequestSchema,
  TaskIdSchema,
} from "./index.ts";
import { schemaFileText } from "./schema-export.ts";

describe("protocol schemas", () => {
  it("never offers bypassPermissions", () => {
    assert.deepEqual([...PERMISSION_MODES], ["default", "acceptEdits", "auto", "plan"]);
  });

  it("accepts the events the sidecar emits and rejects malformed ones", () => {
    assert.ok(AgentEventSchema.safeParse({ type: "text.delta", text: "hi" }).success);
    assert.ok(
      AgentEventSchema.safeParse({
        type: "tool.started",
        toolUseId: "t1",
        name: "Bash",
        input: { command: "ls" },
        parentToolUseId: null,
      }).success,
    );
    assert.equal(AgentEventSchema.safeParse({ type: "text.delta" }).success, false, "missing text");
    assert.equal(AgentEventSchema.safeParse({ type: "unknown.event" }).success, false);
  });

  it("validates request params", () => {
    const sessionId = "6f1c0b3e-8d2a-4c5b-9e7f-0a1b2c3d4e5f";
    assert.ok(methodSchemas["session.start"].params.safeParse({ cwd: "/repo", model: "haiku" }).success);
    assert.ok(methodSchemas["session.start"].params.safeParse({ cwd: "/repo", resume: sessionId }).success);
    assert.equal(methodSchemas["session.start"].params.safeParse({ cwd: "" }).success, false);
    assert.equal(methodSchemas["session.start"].params.safeParse({ cwd: "/r", resume: "../x" }).success, false);
    const respond = methodSchemas["permission.respond"].params;
    assert.equal(respond.safeParse({ sessionId, requestId: "r", allow: "yes" }).success, false);
    assert.equal(
      methodSchemas["session.rename"].params.safeParse({ cwd: "/r", sessionId, title: "  " }).success,
      false,
    );
    assert.equal(
      methodSchemas["session.tag"].params.parse({ cwd: "/r", sessionId, tag: " wip " }).tag,
      "wip",
      "tags are trimmed",
    );
  });

  it("checks task contracts: criterion checks, task ids and tiers", () => {
    for (const ok of ["gate:test", "gate:smoke", "review", "manual"])
      assert.ok(CriterionCheckSchema.safeParse(ok).success, ok);
    for (const bad of ["gate:", "gate:install", "gate:test ", "Review", ""]) {
      assert.equal(CriterionCheckSchema.safeParse(bad).success, false, bad);
    }
    assert.ok(TaskIdSchema.safeParse("2026-10-30-1a2b3c4d").success);
    for (const bad of ["../2026-10-30-1a2b3c4d", "2026-10-30-1A2B3C4D", "2026-10-30-1a2b3c4d/x"]) {
      assert.equal(TaskIdSchema.safeParse(bad).success, false, bad);
    }
    const approve = methodSchemas["task.approve"].params;
    const contract = {
      task: "x",
      objective: "y",
      acceptanceCriteria: [{ id: "c1", text: "done", check: "manual" }],
      constraints: [],
      outOfScope: [],
      risks: [],
      affectedAreas: [],
      openQuestions: [],
    };
    const base = { cwd: "/r", id: "2026-10-30-1a2b3c4d", contract, tier: "M", budgetUsd: 3 };
    assert.ok(approve.safeParse(base).success);
    assert.equal(approve.safeParse({ ...base, tier: "XXL" }).success, false);
    assert.equal(approve.safeParse({ ...base, budgetUsd: 0 }).success, false);
    assert.equal(
      approve.safeParse({
        ...base,
        contract: { ...contract, acceptanceCriteria: [{ id: "c1", text: "", check: "manual" }] },
      }).success,
      false,
      "empty criterion",
    );
  });

  it("requires a tool input object on permission requests", () => {
    const base = { sessionId: "s", requestId: "r", toolName: "Write", toolUseId: "t", alwaysRules: [] };
    assert.ok(PermissionRequestSchema.safeParse({ ...base, input: { file_path: "a" } }).success);
    assert.equal(PermissionRequestSchema.safeParse({ ...base, input: "a" }).success, false);
  });
});

describe("schema/protocol.schema.json", () => {
  it("is up to date (run: pnpm --filter @agentchainer/protocol export-schema)", () => {
    const committed = readFileSync(new URL("../schema/protocol.schema.json", import.meta.url), "utf8");
    assert.equal(committed, schemaFileText());
  });
});

describe("agentProblems (M8-04)", () => {
  const ok = { name: "reviewer", description: "Reviews", prompt: "You review.", tools: "Read, Grep, mcp__github__*" };

  it("passes a valid agent, with known tools and MCP entries", () => {
    assert.deepEqual(agentProblems(ok), []);
    assert.deepEqual(agentProblems({ ...ok, tools: "mcp__db, mcp__db__query", model: "claude-opus-5-5" }), []);
    assert.deepEqual(agentProblems({ ...ok, tools: undefined, model: "inherit" }), []);
  });

  it("names every problem: name, taken name, empty fields, model, unknown and repeated tools", () => {
    assert.deepEqual(
      agentProblems(
        { name: "Bad Name", description: " ", prompt: "", tools: "Read, Fly, mcp__, Read", model: "gpt-4" },
        [],
      ).map((p) => p.split(":")[0]),
      ["Name", "Description", "Prompt", "Model", "Tools", "Tools"],
    );
    assert.match(agentProblems(ok, ["reviewer"])[0] ?? "", /already exists/);
    assert.match(agentProblems({ ...ok, tools: "Fly, Swim" }).join(), /Fly, Swim aren't a known tool/);
  });
});

describe("imageType (UX-21)", () => {
  it("names the images the viewer shows, by extension, in any case", () => {
    assert.equal(imageType("assets/logo.png"), "image/png");
    assert.equal(imageType("Photo.JPEG"), "image/jpeg");
    assert.equal(imageType("public/favicon.ico"), "image/x-icon");
    assert.equal(imageType("icons/a.svg"), "image/svg+xml");
    assert.equal(imageType("notes.txt"), null);
    assert.equal(imageType("png"), null);
    assert.equal(imageType("dir.png/readme"), null);
  });
});

describe("MemoryPathSchema (CP-03)", () => {
  it("allows only a CLAUDE.md the editor may write, inside the workspace", () => {
    for (const ok of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md", "packages/api/CLAUDE.md"]) {
      assert.ok(MemoryPathSchema.safeParse(ok).success, ok);
    }
    for (const bad of [
      "../CLAUDE.md",
      "a/../CLAUDE.md",
      "/etc/CLAUDE.md",
      "notes.md",
      "CLAUDE.md.bak",
      "a\\b/CLAUDE.md",
    ]) {
      assert.equal(MemoryPathSchema.safeParse(bad).success, false, bad);
    }
  });
});

describe("a task's git names and comments (CP-05)", () => {
  it("never takes a branch or commit git could read as an option", () => {
    for (const ok of ["main", "agentchainer/2026-11-11-0a1b2c3d", "feature/x-1", "3f2a9c0d", "release@v1"]) {
      assert.ok(GitNameSchema.safeParse(ok).success, ok);
    }
    for (const bad of ["", "--output=/tmp/x", "-c", "a b", "main\n--force", "\tmain"]) {
      assert.equal(GitNameSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it("takes a comment with lines from 1 and words in it, and no more than 50 a round", () => {
    const c = { path: "src/a.ts", side: "new", start: 1, end: 2, quote: "x", text: " Why? " };
    assert.equal(FeedbackCommentSchema.parse(c).text, "Why?");
    assert.equal(FeedbackCommentSchema.safeParse({ ...c, text: "   " }).success, false);
    assert.equal(FeedbackCommentSchema.safeParse({ ...c, start: 0 }).success, false);
    const params = methodSchemas["task.feedback"].params;
    const ref = { cwd: "/w", id: "2026-11-11-0a1b2c3d" };
    assert.equal(params.safeParse({ ...ref, comments: [] }).success, false);
    assert.equal(params.safeParse({ ...ref, comments: Array(51).fill(c) }).success, false);
    assert.ok(params.safeParse({ ...ref, comments: Array(50).fill(c), note: "Also a test." }).success);
  });
});
