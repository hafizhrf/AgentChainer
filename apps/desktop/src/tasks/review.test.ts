import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../transcript.ts";
import { reviewIn } from "./review.ts";

const review = {
  verdict: "approve",
  findings: [{ file: "src/a.js", severity: "note", text: "Fine." }],
  criteria: [{ id: "c1", met: "yes", why: "Shown." }],
};
const read: Item = { kind: "tool", id: "t1", name: "Read", input: { file_path: "a.js" }, status: "done" };

test("finds the review an agy or Codex reviewer answered as JSON (M9-05)", () => {
  const answer: Item = { kind: "assistant", id: 2, text: `${JSON.stringify(review)}\n`, open: false };
  const found = reviewIn([read, answer]);
  assert.equal(found?.review.verdict, "approve");
  assert.equal(found?.item, answer);
});

test("finds the review Claude handed in through StructuredOutput", () => {
  const handed: Item = { kind: "tool", id: "t2", name: "StructuredOutput", input: review, status: "done" };
  assert.equal(reviewIn([read, handed])?.item, handed);
});

test("leaves an answer that isn't a review as it is", () => {
  assert.equal(reviewIn([{ kind: "assistant", id: 3, text: "All good, no changes.", open: false }]), null);
  assert.equal(reviewIn([{ kind: "assistant", id: 4, text: '{"verdict":"maybe"}', open: false }]), null);
  assert.equal(reviewIn([read]), null);
});
