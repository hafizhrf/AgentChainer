import assert from "node:assert/strict";
import { test } from "node:test";
import { variantAgents, variantLabel, variantRows } from "./bestOf.ts";

const cli = (installed: boolean, signedIn: boolean) => ({ installed, signedIn, version: "1" });

test("offers Claude, and Codex or Antigravity only when installed and signed in (CP-06)", () => {
  assert.deepEqual(variantAgents(null), ["claude"]);
  assert.deepEqual(variantAgents({ codex: cli(true, true), agy: cli(true, false) }), ["claude", "codex"]);
});

test("starts with two rows that differ: another agent when there is one, else another Claude model", () => {
  assert.deepEqual(variantRows(["claude", "agy"]), [
    { agent: "claude", model: "" },
    { agent: "agy", model: "" },
  ]);
  assert.deepEqual(variantRows(["claude", "codex"], "codex"), [
    { agent: "codex", model: "" },
    { agent: "claude", model: "" },
  ]);
  assert.deepEqual(variantRows(["claude"]), [
    { agent: "claude", model: "" },
    { agent: "claude", model: "haiku" },
  ]);
});

test("names a variant by its agent and model", () => {
  assert.equal(variantLabel({ agent: "codex" }), "Codex");
  assert.equal(variantLabel({ agent: "claude", model: "haiku" }), "Claude · haiku");
});
