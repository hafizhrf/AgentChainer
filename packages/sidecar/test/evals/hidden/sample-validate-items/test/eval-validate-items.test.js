import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/cart.js";

test("eval: total rejects bad items with a TypeError", () => {
  for (const item of [
    { price: -1, quantity: 1 },
    { price: 1.5, quantity: 1 },
    { price: 100, quantity: 0 },
    { price: 100, quantity: -2 },
    { price: 100, quantity: 1.5 },
  ]) {
    assert.throws(() => total([item]), TypeError, JSON.stringify(item));
  }
});

test("eval: total still adds up valid items", () => {
  assert.equal(
    total([
      { price: 100, quantity: 1 },
      { price: 0, quantity: 1 },
    ]),
    100,
  );
});
