import assert from "node:assert/strict";
import { test } from "node:test";
import { appendToDraft, type DiffComment, feedbackMessage, isStale, toFeedback } from "./diffComments.ts";

const c = (over: Partial<DiffComment>): DiffComment => ({
  id: "1",
  path: "src/cart.js",
  side: "new",
  start: 3,
  end: 4,
  quote: "a\nb",
  text: "Why?",
  ...over,
});
const labels = {
  header: "Feedback on the changes:",
  where: (x: DiffComment) => `${x.path} ${x.side === "old" ? "removed " : ""}${x.start}-${x.end}:`,
};

test("puts the comments in one message, by file, old lines first, then top to bottom (CP-05)", () => {
  const message = feedbackMessage(
    [
      c({ id: "a", start: 10, end: 10, quote: "x", text: "Second" }),
      c({ id: "b", path: "README.md", start: 1, end: 1, quote: "# T", text: " Title? " }),
      c({ id: "c", start: 2, end: 2, quote: "y", text: "First" }),
      c({ id: "d", side: "old", start: 5, end: 5, quote: "gone", text: "Keep this" }),
    ],
    labels,
  );
  assert.equal(
    message,
    [
      "Feedback on the changes:",
      "src/cart.js removed 5-5:\n```js\ngone\n```\nKeep this",
      "src/cart.js 2-2:\n```js\ny\n```\nFirst",
      "src/cart.js 10-10:\n```js\nx\n```\nSecond",
      "README.md 1-1:\n```md\n# T\n```\nTitle?",
    ].join("\n\n"),
  );
});

test("fences a quote that has backticks of its own, and a file with no extension plainly", () => {
  const m = feedbackMessage([c({ path: "Makefile", quote: "````" })], labels);
  assert.match(m, /\n`````\n````\n`````\n/);
});

test("knows when the quoted lines changed since", () => {
  assert.equal(isStale(c({}), "1\n2\na\nb\n5"), false);
  assert.equal(isStale(c({}), "1\n2\na\nB\n5"), true);
  assert.equal(isStale(c({ start: 9, end: 9, quote: "z" }), "1\n2"), true);
});

test("adds to a draft a blank line after it, or fills an empty one", () => {
  assert.equal(appendToDraft("", "x"), "x");
  assert.equal(appendToDraft("  \n", "x"), "x");
  assert.equal(appendToDraft("Please also:\n\n", "x"), "Please also:\n\nx");
});

test("sends a task's comments without their ids, naming another folder's file by its folder (CP-05 part 2)", () => {
  assert.deepEqual(toFeedback([c({ text: " Why? " }), c({ id: "2", dir: "api", path: "x.ts", side: "old" })]), [
    { path: "src/cart.js", side: "new", start: 3, end: 4, quote: "a\nb", text: "Why?" },
    { path: "x.ts", folder: "api", side: "old", start: 3, end: 4, quote: "a\nb", text: "Why?" },
  ]);
});
