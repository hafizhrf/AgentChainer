import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PANEL_TABS, parseHidden, pickTab, serializeHidden, toggleHidden, visibleTabs } from "./panelTabs.ts";

describe("right panel tabs", () => {
  it("shows every tab that isn't hidden, in order, and never none", () => {
    assert.deepEqual(visibleTabs([]), [...PANEL_TABS]);
    assert.deepEqual(visibleTabs(["git", "files"]), ["changes", "setup"]);
    assert.deepEqual(visibleTabs([...PANEL_TABS]), [...PANEL_TABS]);
  });

  it("hides and shows a tab, but keeps the last one", () => {
    assert.deepEqual(toggleHidden([], "git"), ["git"]);
    assert.deepEqual(toggleHidden(["git"], "git"), []);
    const allButSetup = ["changes", "files", "git"] as const;
    assert.deepEqual(toggleHidden(allButSetup, "setup"), [...allButSetup], "setup is the last visible tab");
  });

  it("falls back to the first visible tab when the open one is hidden", () => {
    assert.equal(pickTab("git", ["changes", "git"]), "git");
    assert.equal(pickTab("git", ["files", "setup"]), "files");
  });

  it("reads back what it stored, and ignores junk", () => {
    assert.deepEqual(parseHidden(serializeHidden(["git", "setup"])), ["git", "setup"]);
    assert.deepEqual(parseHidden(""), []);
    assert.deepEqual(parseHidden("git,permissions,git,nonsense"), ["git"], "Rules left the panel; duplicates go");
    assert.deepEqual(parseHidden("changes,files,git,setup"), [], "everything hidden means nothing hidden");
  });
});
