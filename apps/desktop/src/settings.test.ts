import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldersFor, type Settings, withSessionFolders } from "./settings.ts";

const base: Settings = {
  claudePath: null,
  defaultModel: null,
  defaultMode: null,
  editor: null,
  defaultEffort: null,
  budgetUsd: null,
  showThinking: null,
  theme: null,
  autoApply: null,
  tasksPreview: null,
  recentWorkspaces: [],
  workspaces: [{ id: "w", name: "Shop", primary: "D:\\work\\app", folders: ["D:\\work\\api"] }],
  sessionFolders: [],
};

describe("a session's folders (M8-07)", () => {
  it("resumes a stored session across the folders it ran with", () => {
    const s = withSessionFolders(base, "s1", ["D:\\work\\api", "D:\\work\\docs"]);
    assert.deepEqual(foldersFor(s, "s1", "D:\\work\\app"), ["D:\\work\\api", "D:\\work\\docs"]);
  });

  it("falls back to the named workspace whose primary folder the session ran in", () => {
    assert.deepEqual(foldersFor(base, "unknown", "d:/work/app/"), ["D:\\work\\api"]);
    assert.deepEqual(foldersFor(base, "unknown", "D:\\elsewhere"), []);
    assert.deepEqual(foldersFor(null, "unknown", "D:\\work\\app"), []);
  });

  it("keeps the newest record first, once, and forgets a session that's single-folder now", () => {
    let s = withSessionFolders(base, "s1", ["/a"]);
    s = withSessionFolders(s, "s2", ["/b"]);
    s = withSessionFolders(s, "s1", ["/c"]);
    assert.deepEqual(
      s.sessionFolders.map((e) => [e.sessionId, e.folders]),
      [
        ["s1", ["/c"]],
        ["s2", ["/b"]],
      ],
    );
    s = withSessionFolders(s, "s2", []);
    assert.deepEqual(
      s.sessionFolders.map((e) => e.sessionId),
      ["s1"],
    );
    // A session with no record (single-folder when it ran) falls back to its named workspace's folders, as the spec says.
    assert.deepEqual(foldersFor(withSessionFolders(base, "s3", []), "s3", "D:\\work\\app"), ["D:\\work\\api"]);
  });
});
