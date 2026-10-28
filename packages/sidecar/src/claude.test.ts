import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAtLeast, parseAuthStatus, parseVersion } from "./claude.ts";

describe("parseVersion / isAtLeast", () => {
  it("reads the CLI's version string", () => {
    assert.deepEqual(parseVersion("2.1.293 (Claude Code)"), [2, 1, 293]);
    assert.equal(parseVersion("not a version"), null);
  });

  it("compares numerically, not as text", () => {
    assert.equal(isAtLeast("2.1.293 (Claude Code)", "2.1.293"), true);
    assert.equal(isAtLeast("2.1.300", "2.1.293"), true);
    assert.equal(isAtLeast("2.10.0", "2.9.999"), true);
    assert.equal(isAtLeast("2.1.99", "2.1.293"), false);
    assert.equal(isAtLeast("garbage", "2.1.293"), false);
  });
});

describe("parseAuthStatus", () => {
  // Shapes observed in spike S5 (values here are made up).
  it("keeps only loggedIn, method and provider, never account identity", () => {
    const state = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "someone@example.com",
        orgId: "org-123",
        orgName: "Example Org",
        subscriptionType: "team",
      }),
    );
    assert.deepEqual(state, { loggedIn: true, method: "claude.ai", provider: "firstParty" });
    assert.equal(JSON.stringify(state).includes("example.com"), false);
  });

  it("handles logged-out, API key and cloud provider states", () => {
    assert.deepEqual(parseAuthStatus('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'), {
      loggedIn: false,
      method: "none",
      provider: "firstParty",
    });
    assert.equal(
      parseAuthStatus('{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}')?.method,
      "api_key",
    );
    assert.equal(
      parseAuthStatus('{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}')?.provider,
      "bedrock",
    );
  });

  it("rejects output it doesn't understand", () => {
    assert.equal(parseAuthStatus("Not logged in."), null);
    assert.equal(parseAuthStatus('{"authMethod":"none"}'), null);
  });
});
