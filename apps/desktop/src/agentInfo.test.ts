import assert from "node:assert/strict";
import { test } from "node:test";
import type { EnvCheck } from "@agentchainer/protocol";
import { agentStatuses, installCommand, nextStep } from "./agentInfo.ts";

const env = (over: Partial<EnvCheck> = {}): EnvCheck => ({
  platform: "darwin",
  node: "v24",
  claude: { path: "/usr/local/bin/claude", version: "2.1.293 (Claude Code)", minVersion: "2.1.0", versionOk: true },
  auth: { loggedIn: true, method: "claude.ai", provider: "firstParty" },
  git: { version: "2.50" },
  ready: true,
  ...over,
});

test("reads each agent's status from the readiness check and the other CLIs' (UX-23)", () => {
  const clis = {
    codex: { installed: true, version: "codex-cli 0.153.4", signedIn: false },
    agy: { installed: false, signedIn: false },
  };
  const [claude, codex, agy] = agentStatuses(env(), clis);
  assert.deepEqual(claude, {
    id: "claude",
    installed: true,
    version: "2.1.293",
    signedIn: true,
    path: "/usr/local/bin/claude",
  });
  assert.deepEqual(codex, { id: "codex", installed: true, version: "0.153.4", signedIn: false });
  assert.deepEqual(agy, { id: "agy", installed: false, signedIn: null });
  assert.deepEqual(
    [claude, codex, agy].map((s) => (s ? nextStep(s) : null)),
    [null, "signIn", "install"],
  );
});

test("says when Claude is missing or too old, and knows nothing before the check", () => {
  const missing = agentStatuses(
    env({ claude: { path: null, version: null, minVersion: "2.1.0", versionOk: false }, auth: null }),
    null,
  )[0];
  assert.equal(missing && nextStep(missing), "install");
  const old = agentStatuses(
    env({ claude: { path: "/x/claude", version: "1.0.0", minVersion: "2.1.0", versionOk: false } }),
    null,
  )[0];
  assert.equal(old && nextStep(old), "update");
  assert.deepEqual(agentStatuses(null, null)[0], { id: "claude", installed: false, signedIn: null });
});

test("shows the install command for the platform, or none where the docs are the way", () => {
  assert.match(installCommand("claude", "win32") ?? "", /install\.ps1/);
  assert.match(installCommand("claude", "linux") ?? "", /install\.sh/);
  assert.equal(installCommand("codex", "darwin"), "npm install -g @openai/codex");
  assert.equal(installCommand("agy", "darwin"), null);
});
