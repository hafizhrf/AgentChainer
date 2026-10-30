import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { oneLine } from "./listText.ts";

describe("list rows", () => {
  it("keep pasted text on one line", () => {
    assert.equal(oneLine("Keep the layout\n  responsive\r\ndown to 320px"), "Keep the layout responsive down to 320px");
    assert.equal(oneLine("no breaks  here"), "no breaks  here", "spaces inside a line stay");
  });
});
