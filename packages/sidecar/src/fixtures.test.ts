import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodePath, type Identity, leaks, sanitizeForFixture } from "./fixtures.ts";

const id: Identity = { cwd: "/tmp/scratch/ws", home: "/Users/jane.doe", username: "jane.doe" };

describe("sanitizeForFixture", () => {
  it("replaces plain and encoded paths and the username", () => {
    const out = sanitizeForFixture(
      {
        type: "system",
        subtype: "task_notification",
        output_file: `/private/tmp/claude/${encodePath("/Users/jane.doe/project")}/tasks/a.output`,
        note: "cwd /tmp/scratch/ws and home /Users/jane.doe/.claude, user jane.doe",
      },
      id,
    );
    assert.ok(out);
    assert.deepEqual(leaks(JSON.stringify(out), id), []);
    assert.match(String(out.note), /\/workspace/);
  });

  it("drops hook output, rate limits and status messages", () => {
    assert.equal(sanitizeForFixture({ type: "system", subtype: "hook_response", output: "secret" }, id), null);
    assert.equal(sanitizeForFixture({ type: "rate_limit_event" }, id), null);
    assert.equal(sanitizeForFixture({ type: "system", subtype: "status" }, id), null);
  });

  it("empties the init message's machine inventory", () => {
    const out = sanitizeForFixture(
      {
        type: "system",
        subtype: "init",
        model: "m",
        mcp_servers: [{ name: "private-server" }],
        memory_paths: { auto: "/x" },
      },
      id,
    );
    assert.deepEqual(out?.mcp_servers, []);
    assert.equal(out?.memory_paths, "<redacted>");
    assert.equal(out?.model, "m");
  });
});
