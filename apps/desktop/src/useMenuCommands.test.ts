import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { asMenuCommand, MENU_COMMANDS, MENU_SHORTCUTS } from "./useMenuCommands.ts";

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

test("the shortcuts the UI shows are the menu's accelerators", () => {
  const rust = readFileSync(new URL("../src-tauri/src/menu.rs", import.meta.url), "utf8");
  const NAMED: Record<string, string> = { Comma: ",", Backslash: "\\" };
  const accelerators = Object.fromEntries(
    [...rust.matchAll(/item\(\s*app,\s*"([\w-]+)",\s*"[^"]*",\s*Some\("CmdOrCtrl\+((?:Shift\+)?)(\w+)"\)/g)].map(
      ([, id = "", shift, key = ""]) => [id, { key: NAMED[key] ?? key, ...(shift ? { shift: true } : {}) }],
    ),
  );
  assert.deepEqual(accelerators, MENU_SHORTCUTS);
});
