import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { compactDuration, megabytes, minutesSeconds, thousands } from "./format.ts";
import { richParts, setPseudo, t } from "./index.ts";

afterEach(() => setPseudo(false));

test("fills in values and leaves unknown ones visible", () => {
  assert.equal(t("common.format.minutesSeconds", { m: 3, s: 4 }), "3 min 4 s");
  assert.equal(t("common.format.minutesSeconds", { m: 3 }), "3 min {{s}} s");
  assert.equal(t("menu.about", { app: "AgentChainer" }), "About AgentChainer");
});

test("an unknown key shows the key, so it's noticed", () => {
  assert.equal(t("no.such.key" as never), "no.such.key");
});

test("the formatters keep the shapes the UI showed before the catalogs", () => {
  assert.equal(minutesSeconds(12), "12 s");
  assert.equal(minutesSeconds(184), "3 min 4 s");
  assert.equal(compactDuration(45), "45s");
  assert.equal(compactDuration(125), "2m 05s");
  assert.equal(thousands(12), "12k");
  assert.equal(megabytes(1_500_000), "1.5 MB");
});

test("splits a message with markup into text and tagged parts, and never reads a value as markup", () => {
  assert.deepEqual(richParts("tasks.contractView.savedIn", { path: ".agentchainer/tasks/1/" }), [
    { text: "The task is saved in " },
    { text: ".agentchainer/tasks/1/", tag: "code" },
    { text: "." },
  ]);
  assert.deepEqual(richParts("menu.about", { app: "<b>X</b>" }), [{ text: "About <b>X</b>" }]);
});

test("the pseudo-locale accents letters and brackets every message, but not the values", () => {
  setPseudo(true);
  assert.equal(t("menu.about", { app: "AgentChainer" }), "⟦Åböüţ AgentChainer⟧");
  assert.equal(t("common.format.megabytes", { n: "1.5" }), "⟦1.5 MB⟧");
  const parts = richParts("menu.undo");
  assert.equal(parts[0]?.text, "⟦");
  assert.equal(parts.at(-1)?.text, "⟧");
});
