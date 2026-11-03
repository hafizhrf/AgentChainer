import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FleetItem } from "@agentchainer/protocol";
import { ago, fleetGroups, workspaceOf } from "./fleet.ts";

const item = (sessionId: string, cwd: string, status: FleetItem["status"], since = "2026-11-03T10:00:00.000Z") => ({
  sessionId,
  cwd,
  status,
  waiting: status === "waiting" ? 1 : 0,
  costUsd: 0,
  startedAt: since,
  since,
});

describe("the fleet view (M8-02)", () => {
  it("puts the workspaces and rows that need the person first, then working, idle and ended", () => {
    const groups = fleetGroups([
      item("a", "/w/api", "idle"),
      item("b", "/w/app", "working"),
      item("c", "/w/api", "waiting"),
      item("d", "/w/app", "ended"),
      item("e", "/w/app", "working", "2026-11-03T11:00:00.000Z"),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.cwd, g.items.map((i) => i.sessionId)]),
      [
        ["/w/api", ["c", "a"]],
        ["/w/app", ["e", "b", "d"]],
      ],
    );
  });

  it("says how long ago, in seconds, minutes or hours", () => {
    const at = Date.parse("2026-11-03T10:00:00.000Z");
    assert.equal(ago("2026-11-03T09:59:48.000Z", at), "12 s");
    assert.equal(ago("2026-11-03T09:56:00.000Z", at), "4 min");
    assert.equal(ago("2026-11-03T08:00:00.000Z", at), "2 h");
  });

  it("files a task step under its workspace, not its worktree", () => {
    assert.equal(workspaceOf("C:\\w\\app\\.agentchainer\\worktrees\\2026-11-03-e1eeb160"), "C:\\w\\app");
    assert.equal(workspaceOf("/w/app/.agentchainer/worktrees/2026-11-03-e1eeb160/packages/api"), "/w/app");
    assert.equal(workspaceOf("/w/app"), "/w/app");
    assert.deepEqual(
      fleetGroups([item("s", "/w/app/.agentchainer/worktrees/t1", "working"), item("c", "/w/app", "idle")]).map((g) => [
        g.cwd,
        g.items.length,
      ]),
      [["/w/app", 2]],
    );
  });
});
