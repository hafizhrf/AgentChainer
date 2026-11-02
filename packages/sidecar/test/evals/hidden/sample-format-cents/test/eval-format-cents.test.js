import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents } from "../src/cart.js";

test("eval: formatCents shows dollars and cents", () => {
  assert.equal(formatCents(1234), "$12.34");
  assert.equal(formatCents(5), "$0.05");
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(-5), "-$0.05");
  assert.equal(formatCents(100000), "$1000.00");
});
