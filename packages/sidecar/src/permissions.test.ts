import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  addRule,
  alwaysUpdates,
  describeUpdates,
  listRules,
  localSettingsPath,
  removeRule,
  teamSettingsPath,
  userSettingsPath,
} from "./permissions.ts";
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

  it("saves always-allow rules where the user chose: the session, just me, or the team", () => {
    const destinations = (scope?: "session" | "workspace" | "team") => {
      const r = permissionResult(pending, { allow: true, always: true, ...(scope ? { scope } : {}) });
      return r.behavior === "allow" ? r.updatedPermissions?.map((u) => u.destination) : [];
    };
    assert.deepEqual(destinations(), ["localSettings", "localSettings"], "the workspace, just me, by default");
    assert.deepEqual(destinations("session"), ["session", "session"]);
    assert.deepEqual(destinations("team"), ["projectSettings", "projectSettings"]);
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

describe("rules shared with the team (.claude/settings.json)", () => {
  it("lists and removes team rules separately, and keeps every other setting", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ac-perms-team-"));
    try {
      mkdirSync(join(cwd, ".claude"));
      writeFileSync(localSettingsPath(cwd), JSON.stringify({ permissions: { allow: ["Read"] } }));
      const team = { hooks: { Stop: [] }, permissions: { allow: ["Bash(pnpm test)"], deny: ["Bash(rm -rf *)"] } };
      writeFileSync(teamSettingsPath(cwd), JSON.stringify(team));
      assert.deepEqual(listRules(cwd, "team"), { allow: ["Bash(pnpm test)"], ask: [], deny: ["Bash(rm -rf *)"] });
      assert.deepEqual(listRules(cwd, "workspace").allow, ["Read"]);

      removeRule(cwd, "allow", "Bash(pnpm test)", "team");
      const after = JSON.parse(readFileSync(teamSettingsPath(cwd), "utf8"));
      assert.deepEqual(after.hooks, { Stop: [] }, "other team settings stay");
      assert.deepEqual(after.permissions, { allow: [], deny: ["Bash(rm -rf *)"] });
      assert.deepEqual(listRules(cwd, "workspace").allow, ["Read"], "the local file is untouched");
      assert.throws(() => removeRule(cwd, "allow", "Read", "team"), /No allow rule Read/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("adding rules, and rules for every project (UX-19, ADR-0013)", () => {
  const temp = () => mkdtempSync(join(tmpdir(), "ac-perm-"));

  it("adds a rule once and keeps the file's other settings", () => {
    const cwd = temp();
    try {
      mkdirSync(join(cwd, ".claude"));
      writeFileSync(
        join(cwd, ".claude", "settings.local.json"),
        '{"env":{"A":"1"},"permissions":{"deny":["Bash(rm:*)"]}}',
      );
      addRule(cwd, "allow", "Bash(npm test:*)", "workspace");
      addRule(cwd, "allow", "Bash(npm test:*)", "workspace");
      const saved = JSON.parse(readFileSync(join(cwd, ".claude", "settings.local.json"), "utf8"));
      assert.deepEqual(saved, { env: { A: "1" }, permissions: { deny: ["Bash(rm:*)"], allow: ["Bash(npm test:*)"] } });
      addRule(cwd, "ask", "WebFetch", "team");
      assert.deepEqual(listRules(cwd, "team"), { allow: [], ask: ["WebFetch"], deny: [] });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps rules for every project in the CLI's user settings, written through a link that stays a link", () => {
    const cwd = temp();
    const config = temp();
    const dotfiles = temp();
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      assert.equal(userSettingsPath(), join(config, "settings.json"));
      addRule(cwd, "deny", "Read(.env)", "user");
      assert.deepEqual(listRules(cwd, "user").deny, ["Read(.env)"]);
      // A user settings file kept with dotfiles, linked in.
      const real = join(dotfiles, "claude-settings.json");
      writeFileSync(real, '{"model":"opus"}');
      rmSync(join(config, "settings.json"));
      symlinkSync(real, join(config, "settings.json"));
      addRule(cwd, "allow", "Bash(git status)", "user");
      assert.ok(lstatSync(join(config, "settings.json")).isSymbolicLink(), "still a link");
      assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), {
        model: "opus",
        permissions: { allow: ["Bash(git status)"] },
      });
      removeRule(cwd, "allow", "Bash(git status)", "user");
      assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).permissions.allow, []);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
      for (const d of [cwd, config, dotfiles]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("doesn't write a workspace's rule file through a link", () => {
    const cwd = temp();
    const elsewhere = temp();
    try {
      mkdirSync(join(cwd, ".claude"));
      writeFileSync(join(elsewhere, "settings.json"), "{}");
      symlinkSync(join(elsewhere, "settings.json"), join(cwd, ".claude", "settings.local.json"));
      assert.throws(() => addRule(cwd, "allow", "Bash", "workspace"), /link/);
      assert.equal(readFileSync(join(elsewhere, "settings.json"), "utf8"), "{}");
    } finally {
      for (const d of [cwd, elsewhere]) rmSync(d, { recursive: true, force: true });
    }
  });
});
