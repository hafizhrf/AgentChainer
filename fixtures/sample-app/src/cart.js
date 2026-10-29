/** Total price of a cart, in cents. Each item has a unit `price` (cents) and a `quantity`. */
export function total(items) {
  let sum = 0;
  for (const item of items) sum += item.price;
  return sum;
}

/** Applies a percentage discount, rounded to whole cents. */
export function applyDiscount(cents, percent) {
  return Math.round(cents * (1 - percent / 100));
}
