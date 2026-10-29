import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { catalog as shipped } from "../catalog/index.ts";
import type { Catalog } from "../catalog/schema.ts";
import { auditWorkspace } from "../detect/audit.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { copyFixture, FIXTURE_SETUPS, removeFixtureCopies } from "../detect/fixture-copy.ts";
import { applyActions, rollback } from "./apply.ts";
import { fakeCli } from "./fake-cli.ts";
import { buildPlan, type PlanEnv, planEnv } from "./plan.ts";

/**
 * M2 exit criteria E1 and E3, end to end on every fixture: the default bootstrap plus every catalog item is applied,
 * then rolled back, and the workspace must come back byte for byte with a clean `git status`. Real downloads (git
 * sources, release binaries) and a stand-in for the `claude` CLI; generators are left out (they need a model).
 * Needs network, so it runs only with AC_EXIT_E2E=1: in CI on macOS, Windows and Ubuntu (.github/workflows/ci.yml).
 */

const enabled = process.env.AC_EXIT_E2E === "1";
const tools = mkdtempSync(path.join(tmpdir(), "ac-exit-tools-"));
after(() => {
  removeFixtureCopies();
  rmSync(tools, { recursive: true, force: true });
});

// Every item counts as reviewed here, so every installer path runs (the shipped plan offers them once reviewed).
const reviewed: Catalog = {
  ...shipped,
  items: shipped.items.map((i) => ({
    ...i,
    reviews: [
      { by: "exit-test", date: "2026-10-29", ref: "e2e" },
      { by: "exit-test-2", date: "2026-10-29", ref: "e2e" },
    ],
  })),
};
const allProfiles = reviewed.profiles.map((p) => p.id);

/** sha256 of every file in the workspace, with .git left out except its hooks (git's own files churn). */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (childRel === ".git") {
        if (existsSync(path.join(childAbs, "hooks"))) walk(path.join(childAbs, "hooks"), ".git/hooks");
        continue;
      }
      const st = lstatSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else out.set(childRel, createHash("sha256").update(readFileSync(childAbs)).digest("hex"));
    }
  };
  walk(dir, "");
  return out;
}

const status = (dir: string) =>
  existsSync(path.join(dir, ".git"))
    ? execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })
    : "";

describe("M2 exit: bootstrap and full rollback on every fixture", {
  skip: enabled ? false : "set AC_EXIT_E2E=1 (network)",
}, () => {
  for (const name of Object.keys(FIXTURE_SETUPS)) {
    it(name, async () => {
      const dir = copyFixture(name);
      const before = tree(dir);
      const statusBefore = status(dir);
      const env: PlanEnv = { ...planEnv(dir), hasTool: () => true, toolsDir: tools };
      const profile = detectWorkspace(dir);
      const plan = buildPlan(dir, profile, auditWorkspace(dir, profile), reviewed, env, allProfiles);
      // The default selection, plus every catalog item that can be applied here (community items aren't pre-selected).
      const ids = plan.actions
        .filter((a) => a.kind !== "generator" && (a.state === "recommended" || a.state === "optional"))
        .filter((a) => a.selected || a.kind === "catalog")
        .map((a) => a.id);
      assert.ok(ids.length > 0, "something to apply");

      const ctx = {
        catalog: reviewed,
        env,
        cli: fakeCli(dir, { marketplaces: ["claude-plugins-official"] }),
        optIn: allProfiles,
      };
      const { runId, results } = await applyActions(dir, ids, ctx);
      const failed = results.filter((r) => r.status !== "applied");
      assert.deepEqual(
        failed.map((r) => `${r.id}: ${r.status} ${r.message ?? ""}`),
        [],
        `every action applies on ${process.platform}`,
      );

      const undone = rollback(dir, runId, ctx);
      assert.ok(
        undone.every((r) => r.status === "rolled-back"),
        undone.map((r) => `${r.id}: ${r.status} ${r.message ?? ""}`).join("\n"),
      );
      assert.equal(status(dir), statusBefore, "git status is as before");
      assert.deepEqual([...tree(dir)].sort(), [...before].sort(), "every file is byte-identical");
    });
  }
});
