import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderKey, folderProblems } from "./folders.ts";

describe("a multi-folder workspace's folders (M8-01)", () => {
  it("takes separate absolute folders", () => {
    assert.deepEqual(folderProblems(["C:\\work\\app", "C:\\work\\api"], "C:\\Users\\me"), []);
    assert.deepEqual(folderProblems(["/work/app", "/work/api"], "/home/me"), []);
  });

  it("refuses a relative path, a drive or root, the home folder, a repeat, and a folder inside another", () => {
    const p = folderProblems(
      ["C:\\work\\app", "api", "D:\\", "C:\\Users\\Me\\", "c:/work/app/", "C:\\work\\app\\packages\\ui"],
      "C:\\Users\\me",
    );
    assert.equal(p.length, 5, p.join("\n"));
    assert.match(p[0] ?? "", /api: use a full path/);
    assert.match(p[1] ?? "", /whole drive/);
    assert.match(p[2] ?? "", /home folder/);
    assert.match(p[3] ?? "", /twice/);
    assert.match(p[4] ?? "", /inside C:\\work\\app/);
    assert.match(folderProblems(["/work/app", "/"], "/home/me")[0] ?? "", /whole drive/);
  });

  it("treats Windows paths as the same folder whatever their case or slashes", () => {
    assert.equal(folderKey("C:\\Work\\App\\"), folderKey("c:/work/app"));
    assert.notEqual(folderKey("/Work/App"), folderKey("/work/app"));
  });
});
