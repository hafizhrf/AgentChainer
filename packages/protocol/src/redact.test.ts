import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vectors from "../test/redact-vectors.json" with { type: "json" };
import { hasKeyShape, hasSecret, redactForLog, redactSecrets, redactValue } from "./redact.ts";

/** The shared redaction vectors (X-03); `diagnostics.rs` runs the same file. */
describe("redaction", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const out = "home" in c && c.home ? redactForLog(c.in, c.home) : redactSecrets(c.in);
      assert.equal(out, c.out);
    });
  }

  it("is the same when run twice", () => {
    for (const c of vectors.cases) assert.equal(redactSecrets(c.out), c.out, c.name);
  });

  it("tells a secret apart from an email address or ordinary text", () => {
    assert.equal(hasSecret("token ghp_0123456789abcdefghijABCD"), true);
    assert.equal(hasSecret("DEPLOY_PRIVATE_KEY=abc123xyz"), true);
    assert.equal(hasSecret("-----BEGIN EC PRIVATE KEY-----"), true);
    assert.equal(hasSecret("ask me@example.com"), false);
    assert.equal(hasSecret("Run the tests before you push."), false);
    // The global patterns keep no state between calls.
    assert.equal(hasSecret("token ghp_0123456789abcdefghijABCD"), true);
  });

  it("finds keys by their shape, not documentation that names one (CP-03)", () => {
    assert.equal(hasKeyShape("token ghp_0123456789abcdefghijABCD"), true);
    assert.equal(hasKeyShape("ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop"), true);
    assert.equal(hasKeyShape("-----BEGIN EC PRIVATE KEY-----"), true);
    assert.equal(hasKeyShape("Set `ANTHROPIC_API_KEY=` in .env"), false);
    assert.equal(hasKeyShape("ANTHROPIC_API_KEY=your-key-here"), false);
    assert.equal(hasKeyShape("postgres://app:app@localhost:5432/app"), false);
    assert.equal(hasKeyShape("Ask me@example.com"), false);
  });

  it("masks a tool's input for display and keeps its shape", () => {
    const input = {
      command: "export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop && npm test",
      env: { GITHUB_TOKEN: "abc", RETRIES: "3", api_key: 42 },
      edits: [{ old_string: "x", new_string: "password: hunter22" }],
      file_path: "/repo/.env",
    };
    assert.deepEqual(redactValue(input), {
      command: "export ANTHROPIC_API_KEY=[redacted key] && npm test",
      env: { GITHUB_TOKEN: "[redacted]", RETRIES: "3", api_key: 42 },
      edits: [{ old_string: "x", new_string: "password: [redacted]" }],
      file_path: "/repo/.env",
    });
    assert.equal(redactValue(null), null);
  });
});
