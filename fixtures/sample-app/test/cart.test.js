import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount, total } from "../src/cart.js";

test("total counts each item's quantity", () => {
  assert.equal(
    total([
      { price: 250, quantity: 2 },
      { price: 100, quantity: 3 },
    ]),
    800,
  );
});

test("applyDiscount rounds to whole cents", () => {
  assert.equal(applyDiscount(999, 10), 899);
});
