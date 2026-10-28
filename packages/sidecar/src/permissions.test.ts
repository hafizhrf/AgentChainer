import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { alwaysUpdates, describeUpdates, listRules, localSettingsPath, removeRule } from "./permissions.ts";
import { permissionResult } from "./session.ts";

const suggestions: PermissionUpdate[] = [
  {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
    behavior: "allow",
    destination: "session",
  },
  { type: "addDirectories", directories: ["/data"], destination: "session" },
  { type: "setMode", mode: "acceptEdits", destination: "session" },
  { type: "addRules", rules: [{ toolName: "WebFetch" }], behavior: "deny", destination: "session" },
];

describe("always-allow updates", () => {
  it("keeps allow rules and folders, saved to the project's local settings, and drops mode switches", () => {
    const updates = alwaysUpdates(suggestions);
    assert.deepEqual(
      updates.map((u) => [u.type, u.destination]),
      [
        ["addRules", "localSettings"],
        ["addDirectories", "localSettings"],
      ],
    );
    assert.deepEqual(describeUpdates(updates), ["Bash(npm test:*)", "Access to /data"]);
    assert.deepEqual(alwaysUpdates(undefined), []);
  });
});

describe("permissionResult", () => {
  const pending = { toolName: "Bash", always: alwaysUpdates(suggestions) };

  it("allows once, always, or with edited input", () => {
    assert.deepEqual(permissionResult(pending, { allow: true }), { behavior: "allow" });
    const always = permissionResult(pending, { allow: true, always: true });
    assert.equal(always.behavior === "allow" && always.updatedPermissions?.length, 2);
    assert.deepEqual(permissionResult(pending, { allow: true, updatedInput: { command: "npm test" } }), {
      behavior: "allow",
      updatedInput: { command: "npm test" },
    });
  });

  it("denies with the user's message, or a default one", () => {
    assert.deepEqual(permissionResult(pending, { allow: false, message: " use pnpm " }), {
      behavior: "deny",
      message: "use pnpm",
    });
    assert.equal(permissionResult(pending, { allow: false }).behavior, "deny");
  });

  it("switches mode only when approving a plan", () => {
    const plan = permissionResult({ toolName: "ExitPlanMode", always: [] }, { allow: true, mode: "acceptEdits" });
    assert.deepEqual(plan, {
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    assert.deepEqual(permissionResult(pending, { allow: true, mode: "auto" }), { behavior: "allow" });
  });
});

describe("rules in .claude/settings.local.json", () => {
  it("lists and removes rules and keeps every other setting", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ac-perms-"));
    try {
      assert.deepEqual(listRules(cwd), { allow: [], ask: [], deny: [] }, "no file yet");
      mkdirSync(join(cwd, ".claude"));
      const settings = {
        env: { TOKEN: "keep-me" },
        permissions: { allow: ["Bash(npm test:*)", "Read"], deny: ["WebFetch"], defaultMode: "default" },
      };
      writeFileSync(localSettingsPath(cwd), JSON.stringify(settings));
      assert.deepEqual(listRules(cwd), { allow: ["Bash(npm test:*)", "Read"], ask: [], deny: ["WebFetch"] });

      removeRule(cwd, "allow", "Read");
      const saved = JSON.parse(readFileSync(localSettingsPath(cwd), "utf8"));
      assert.deepEqual(saved, {
        env: { TOKEN: "keep-me" },
        permissions: { allow: ["Bash(npm test:*)"], deny: ["WebFetch"], defaultMode: "default" },
      });
      assert.throws(() => removeRule(cwd, "deny", "Read"), /No deny rule/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
