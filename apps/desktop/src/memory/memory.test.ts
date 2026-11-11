import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryFile, MemoryProject } from "@agentchainer/protocol";
import { approxTokens, firstFile, groupFiles, sortProjects } from "./memory.ts";

const file = (path: string, kind: MemoryFile["kind"]): MemoryFile => ({ path, kind, exists: true, lines: 1, bytes: 4 });

test("estimates tokens at about four bytes each (CP-03)", () => {
  assert.equal(approxTokens(0), 0);
  assert.equal(approxTokens(4000), 1000);
});

test("groups the files in the order Claude loads them, leaving out empty groups", () => {
  const files = [file("~/.claude/CLAUDE.md", "user"), file("api/CLAUDE.md", "folder"), file("CLAUDE.md", "project")];
  assert.deepEqual(
    groupFiles(files).map((g) => [g.kind, g.files.map((f) => f.path)]),
    [
      ["project", ["CLAUDE.md"]],
      ["folder", ["api/CLAUDE.md"]],
      ["user", ["~/.claude/CLAUDE.md"]],
    ],
  );
  assert.equal(firstFile(files)?.path, "CLAUDE.md");
  assert.equal(firstFile([]), undefined);
});

test("puts the projects that need a look first", () => {
  const p = (cwd: string, status: MemoryProject["status"]): MemoryProject => ({
    cwd,
    status,
    folders: 0,
    local: false,
  });
  assert.deepEqual(
    sortProjects([p("/b", "ok"), p("/a", "ok"), p("/c", "long"), p("/d", "missing"), p("/e", "gone")]).map(
      (x) => x.cwd,
    ),
    ["/d", "/c", "/e", "/a", "/b"],
  );
});
