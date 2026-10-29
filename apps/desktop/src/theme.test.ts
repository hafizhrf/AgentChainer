import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asTheme, resolveTheme } from "./theme.ts";

describe("theme", () => {
  it("follows the OS for system, and the setting otherwise", () => {
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("dark", false), "dark");
  });

  it("treats unknown or missing settings as system", () => {
    assert.deepEqual([asTheme(null), asTheme("blue"), asTheme("dark")], ["system", "system", "dark"]);
  });
});
