import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startBase, taskDiff } from "./runner.ts";

describe("a run's base and diff", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-diff-")));
  after(() => rmSync(root, { recursive: true, force: true }));
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd: root,
      encoding: "utf8",
    });

  it("counts only what changed after the start: not the user's uncommitted edits or untracked files", () => {
    writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
    g("init", "-q", "-b", "main");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    // The user's own work in progress, before the task starts.
    writeFileSync(join(root, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "notes.txt"), "mine\n");

    const { base, untrackedAtStart } = startBase(root);
    assert.ok(base);
    assert.notEqual(base, g("rev-parse", "HEAD").trim(), "a snapshot of the dirty tree, not HEAD");
    assert.deepEqual(untrackedAtStart, ["notes.txt"]);
    assert.equal(g("status", "--porcelain"), " M app.ts\n?? notes.txt\n", "taking the base changes nothing");

    // The task's changes.
    writeFileSync(join(root, "app.ts"), "export const a = 3;\n");
    writeFileSync(join(root, "counter.ts"), "export const counter = 0;\n");
    const diff = taskDiff(root, base, untrackedAtStart);
    assert.match(diff, /-export const a = 2;\n\+export const a = 3;/);
    assert.doesNotMatch(diff, /a = 1/);
    assert.match(diff, /new file\n--- \/dev\/null\n\+\+\+ b\/counter\.ts\n\+export const counter = 0;/);
    assert.doesNotMatch(diff, /notes\.txt/);
  });

  it("uses HEAD for a clean tree, and nothing outside git", () => {
    g("add", "-A");
    g("commit", "-q", "-m", "more");
    assert.equal(startBase(root).base, g("rev-parse", "HEAD").trim());
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "ac-plain-")));
    assert.deepEqual(startBase(plain), { base: null, untrackedAtStart: [] });
    assert.equal(taskDiff(plain, null, []), "");
    rmSync(plain, { recursive: true, force: true });
  });
});
