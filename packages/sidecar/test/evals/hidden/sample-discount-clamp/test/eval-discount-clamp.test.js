import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount } from "../src/cart.js";

test("eval: applyDiscount clamps the percentage", () => {
  assert.equal(applyDiscount(1000, -20), 1000);
  assert.equal(applyDiscount(1000, 150), 0);
  assert.equal(applyDiscount(1000, 100), 0);
  assert.equal(applyDiscount(999, 10), 899);
});
