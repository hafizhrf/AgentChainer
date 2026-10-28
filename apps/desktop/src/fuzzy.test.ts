import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuzzyFilter, fuzzyScore, tokenAt } from "./fuzzy.ts";

describe("fuzzy", () => {
  it("needs the query's characters in order", () => {
    assert.equal(fuzzyScore("abc", "a/b/c.ts") !== null, true);
    assert.equal(fuzzyScore("cba", "a/b/c.ts"), null);
  });

  it("ranks file-name and word-start matches first", () => {
    const files = ["src/components/Button.tsx", "src/app.ts", "docs/about-buttons.md", "test/bt.ts"];
    assert.deepEqual(fuzzyFilter("button", files, 2), ["src/components/Button.tsx", "docs/about-buttons.md"]);
    assert.equal(fuzzyFilter("app", files)[0], "src/app.ts");
  });
});

describe("tokenAt", () => {
  it("finds an @mention or a leading slash command at the cursor", () => {
    assert.deepEqual(tokenAt("fix @src/ap", 11), { kind: "@", query: "src/ap", start: 4 });
    assert.deepEqual(tokenAt("@", 1), { kind: "@", query: "", start: 0 });
    assert.deepEqual(tokenAt("/rev", 4), { kind: "/", query: "rev", start: 0 });
    assert.equal(tokenAt("email a@b.c", 11), null, "not after a word character");
    assert.equal(tokenAt("run /tmp", 8), null, "slash commands only at the start");
    assert.equal(tokenAt("/review this", 12), null);
  });
});
