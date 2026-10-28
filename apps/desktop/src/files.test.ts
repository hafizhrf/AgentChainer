import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentEdits, buildTree, joinPath, relativeTo } from "./files.ts";
import type { Item, ToolItem } from "./transcript.ts";

describe("buildTree", () => {
  it("nests paths, puts folders first, and counts changes per folder", () => {
    const tree = buildTree([
      { path: "z.txt" },
      { path: "src/b.ts", status: "modified" },
      { path: "src/a.ts" },
      { path: "src/lib/c.ts", status: "untracked" },
      { path: "README.md" },
    ]);
    assert.deepEqual(
      tree.map((n) => [n.name, n.changes]),
      [
        ["src", 2],
        ["README.md", 0],
        ["z.txt", 0],
      ],
    );
    const src = tree[0]?.children ?? [];
    assert.deepEqual(
      src.map((n) => n.path),
      ["src/lib", "src/a.ts", "src/b.ts"],
    );
  });
});

describe("paths", () => {
  it("joins with the workspace's own separator", () => {
    assert.equal(joinPath("/repo/", "src/a.ts"), "/repo/src/a.ts");
    assert.equal(joinPath("C:\\code\\app", "src/a.ts"), "C:\\code\\app\\src\\a.ts");
  });

  it("makes paths relative only inside the workspace", () => {
    assert.equal(relativeTo("/repo", "/repo/src/a.ts"), "src/a.ts");
    assert.equal(relativeTo("C:\\code\\app", "C:\\code\\app\\src\\a.ts"), "src/a.ts");
    assert.equal(relativeTo("/repo", "/repo-other/a.ts"), null);
    assert.equal(relativeTo("/repo", "/etc/hosts"), null);
  });
});

describe("agentEdits", () => {
  const tool = (id: string, name: string, file: string, status: "done" | "error" = "done"): ToolItem => ({
    kind: "tool",
    id,
    name,
    input: { file_path: file },
    status,
  });

  it("groups successful file-tool edits by user turn, including subagents", () => {
    const items: Item[] = [
      { kind: "user", id: 1, text: "first" },
      tool("t1", "Read", "/repo/a.ts"),
      tool("t2", "Edit", "/repo/a.ts"),
      tool("t3", "Edit", "/repo/a.ts"),
      tool("t4", "Write", "/repo/b.ts", "error"),
      { kind: "user", id: 2, text: "second (no edits)" },
      { kind: "user", id: 3, text: "third" },
      {
        kind: "agent",
        id: "A",
        description: "sub",
        status: "done",
        children: [tool("t5", "Write", "/repo/c.ts"), tool("t6", "Edit", "/tmp/outside.ts")],
      },
    ];
    assert.deepEqual(agentEdits(items, "/repo"), [
      { prompt: "first", files: ["a.ts"] },
      { prompt: "third", files: ["c.ts", "/tmp/outside.ts"] },
    ]);
  });
});
