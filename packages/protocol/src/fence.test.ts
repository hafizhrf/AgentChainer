import assert from "node:assert/strict";
import { test } from "node:test";
import { fenced, fenceFor, fenceLanguage } from "./fence.ts";

test("a fence outlasts any backticks in the text, so the text stays as it is (CP-05)", () => {
  assert.equal(fenceFor("no ticks"), "```");
  assert.equal(fenceFor("```js\nx\n```"), "````");
  assert.equal(fenceFor("a `b` ``c``````"), "```````");
  assert.equal(fenced("x"), "```\nx\n```");
  assert.equal(fenced("```\ny\n```", "diff"), "````diff\n```\ny\n```\n````");
});

test("names a path's language by its extension, and none without one", () => {
  assert.equal(fenceLanguage("src/cart.JS"), "js");
  assert.equal(fenceLanguage("Makefile"), "");
  assert.equal(fenceLanguage("dir.d/.env"), "");
});
