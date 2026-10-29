import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { guarded } from "./workspace-guard.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ac-guard-")));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

describe("workspace guard", () => {
  it("reverts what commands changed and keeps the user's own edits and ignored files", async () => {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "lock.yaml"), "v1\n");
    writeFileSync(join(dir, "kept.txt"), "committed\n");
    writeFileSync(join(dir, ".gitignore"), "out/\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(dir, "kept.txt"), "my edit in progress\n");
    writeFileSync(join(dir, "draft.md"), "my new file\n");

    const { result, reverted } = await guarded(dir, async () => {
      // What a careless command does: rewrite a lockfile, add a config, touch the user's files, write build output.
      writeFileSync(join(dir, "lock.yaml"), "v2\n");
      writeFileSync(join(dir, "workspace.yaml"), "x\n");
      writeFileSync(join(dir, "kept.txt"), "clobbered\n");
      rmSync(join(dir, "draft.md"));
      mkdirSync(join(dir, "out"), { recursive: true });
      writeFileSync(join(dir, "out", "bundle.js"), "//\n");
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(reverted, ["draft.md", "kept.txt", "lock.yaml", "workspace.yaml"]);
    assert.equal(readFileSync(join(dir, "lock.yaml"), "utf8"), "v1\n");
    assert.equal(existsSync(join(dir, "workspace.yaml")), false);
    assert.equal(readFileSync(join(dir, "kept.txt"), "utf8"), "my edit in progress\n", "the user's edit is back");
    assert.equal(readFileSync(join(dir, "draft.md"), "utf8"), "my new file\n");
    assert.ok(existsSync(join(dir, "out", "bundle.js")), "ignored output is left alone");
  });

  it("reverts even when the guarded work fails", async () => {
    await assert.rejects(
      guarded(dir, async () => {
        writeFileSync(join(dir, "lock.yaml"), "half-written\n");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(readFileSync(join(dir, "lock.yaml"), "utf8"), "v1\n");
  });
});
