import assert from "node:assert/strict";
import { test } from "node:test";
import { withTax } from "../src/cart.js";

test("eval: withTax adds the percentage and rounds halves up", () => {
  assert.equal(withTax(1000, 8.25), 1083);
  assert.equal(withTax(1000, 10), 1100);
  assert.equal(withTax(999, 0), 999);
  assert.equal(withTax(250, 5), 263);
});
