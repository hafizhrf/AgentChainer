import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { asMenuCommand, MENU_COMMANDS } from "./useMenuCommands.ts";

test("known menu ids map to commands, anything else is ignored", () => {
  assert.equal(asMenuCommand("toggle-terminal"), "toggle-terminal");
  assert.equal(asMenuCommand("help-report-issue"), null);
  assert.equal(asMenuCommand(42), null);
});

test("the UI handles exactly the ids the Rust menu sends", () => {
  const rust = readFileSync(new URL("../src-tauri/src/menu.rs", import.meta.url), "utf8");
  const block = /UI_COMMANDS: &\[&str\] = &\[([^\]]*)\]/.exec(rust)?.[1] ?? "";
  const ids = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...ids].sort(), [...MENU_COMMANDS].sort());
});
