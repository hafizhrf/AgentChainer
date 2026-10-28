import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AgentEventSchema, methodSchemas, PERMISSION_MODES, PermissionRequestSchema } from "./index.ts";
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
