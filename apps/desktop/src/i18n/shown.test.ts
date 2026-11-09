import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resultRef, setLanguage } from "@agentchainer/protocol";
import { localized } from "./shown.ts";

afterEach(() => setLanguage("en"));

test("a task result shows in the app's language when it has a ref, and as stored otherwise (X-13)", async () => {
  const ref = resultRef("run.outcome.budgetBeforePrReview");
  assert.equal(
    localized("The task's budget ran out before the review of the PR.", ref),
    "The task's budget ran out before the review of the PR.",
  );
  await setLanguage("id");
  assert.equal(localized("stored English", ref), "Anggaran task habis sebelum tinjauan PR.");
  assert.equal(localized("Written before refs.", undefined), "Written before refs.");
  assert.equal(localized(undefined, undefined), undefined);
});
