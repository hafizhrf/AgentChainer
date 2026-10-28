import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editPairs, lineDiff } from "./textdiff.ts";

describe("lineDiff", () => {
  it("keeps common lines and marks removals and additions", () => {
    assert.deepEqual(lineDiff("a\nb\nc", "a\nB\nc\nd"), [
      { op: " ", text: "a" },
      { op: "-", text: "b" },
      { op: "+", text: "B" },
      { op: " ", text: "c" },
      { op: "+", text: "d" },
    ]);
    assert.deepEqual(lineDiff("", "new"), [{ op: "+", text: "new" }]);
  });

  it("falls back to remove-all / add-all for large inputs", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const diff = lineDiff(big, `${big}\nmore`);
    assert.equal(diff.filter((l) => l.op === "-").length, 500);
    assert.equal(diff.filter((l) => l.op === "+").length, 501);
  });
});

describe("editPairs", () => {
  it("reads Edit, MultiEdit and Write inputs", () => {
    assert.deepEqual(editPairs("Edit", { old_string: "x", new_string: "y" }), [{ before: "x", after: "y" }]);
    assert.deepEqual(editPairs("MultiEdit", { edits: [{ old_string: "1", new_string: "2" }] }), [
      { before: "1", after: "2" },
    ]);
    assert.deepEqual(editPairs("Write", { content: "c" }), [{ before: "", after: "c" }]);
    assert.equal(editPairs("Bash", { command: "ls" }), null);
  });
});
