import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/cart.js";

test("eval: total multiplies price by quantity", () => {
  assert.equal(total([{ price: 199, quantity: 3 }]), 597);
  assert.equal(
    total([
      { price: 50, quantity: 1 },
      { price: 25, quantity: 4 },
    ]),
    150,
  );
  assert.equal(total([]), 0);
});
