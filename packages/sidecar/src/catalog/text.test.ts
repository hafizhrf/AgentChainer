import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setLanguage } from "@agentchainer/protocol";
import { reviewOf } from "../plugins.ts";
import shipped from "../tasks/library.json" with { type: "json" };
import { LibrarySchema } from "../tasks/library.ts";
import { tierWorkflows } from "../tasks/project-workflows.ts";
import { catalog } from "./index.ts";
import { itemText, profileText, workflowText } from "./text.ts";

afterEach(() => setLanguage("en"));

const gitleaks = catalog.items.find((i) => i.id === "gitleaks");
const baseline = catalog.profiles.find((p) => p.id === "baseline");

test("an item and a profile in the app's language, the English otherwise (X-13)", async () => {
  assert.ok(gitleaks && baseline);
  assert.equal(itemText(gitleaks).name, "Secret scan before each commit (gitleaks)");
  assert.deepEqual(itemText(gitleaks).permissions, gitleaks.permissions);
  await setLanguage("id");
  assert.equal(itemText(gitleaks).name, "Pemindaian secret sebelum setiap commit (gitleaks)");
  assert.equal(itemText(gitleaks).permissions.length, gitleaks.permissions.length);
  assert.match(itemText(gitleaks).permissions[0] ?? "", /tidak ada yang dikirim/);
  assert.equal(profileText(baseline).name, "Dasar");
  // The review records stay as their reviewers wrote them.
  const review = reviewOf(gitleaks);
  assert.equal(review.summary, gitleaks.i18n?.id.summary);
  assert.equal(review.reviews[0]?.notes, gitleaks.reviews[0]?.notes);
});

test("a workflow's description and labels in the app's language; a project's untranslated file as written", async () => {
  const library = LibrarySchema.parse(shipped);
  await setLanguage("id");
  const s = library.workflows.S;
  assert.ok(s);
  assert.equal(workflowText(s).label("implement", "Implement"), "Implementasi");
  assert.equal(workflowText({ description: "Ours" }).description, "Ours");
  assert.equal(workflowText({ description: "Ours" }).label("implement", "Implement"), "Implement");
  const listed = tierWorkflows({ library, origins: {} } as never);
  assert.equal(listed.find((w) => w.tier === "S")?.description, s.i18n?.id.description);
});
