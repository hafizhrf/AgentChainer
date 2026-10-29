import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Item } from "../catalog/schema.ts";
import { ensureTool, findTool, platformKey, systemTar, toolPath } from "./tools.ts";

/** Release binaries (M2-15): a tar.gz built here, served by a fake fetch. No network. */

const work = mkdtempSync(join(tmpdir(), "ac-tools-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

const name = process.platform === "win32" ? "demo-tool.exe" : "demo-tool";
const pkg = join(work, "pkg");
mkdirSync(join(pkg, "demo_1.0.0"), { recursive: true });
writeFileSync(join(pkg, "demo_1.0.0", name), "#!/bin/sh\necho demo 1.0.0\n");
writeFileSync(join(pkg, "demo_1.0.0", "LICENSE"), "MIT\n");
const archive = join(work, "demo_1.0.0.tar.gz");
execFileSync(systemTar(), ["-czf", archive, "-C", pkg, "demo_1.0.0"]);
const bytes = readFileSync(archive);
const digest = createHash("sha256").update(bytes).digest("hex");

const key = platformKey() ?? "linux-x64";
const item = (sha256 = digest): Item => ({
  id: "demo-tool",
  name: "Demo tool",
  kind: "tool",
  tier: "verified-vendor",
  license: "MIT",
  summary: "",
  why: "",
  source: {
    type: "release-asset",
    repo: "https://example.com/demo",
    version: "1.0.0",
    assets: { [key]: { url: "https://example.com/releases/demo_1.0.0.tar.gz", sha256 } },
  },
  platforms: ["darwin", "linux", "win32"],
  requires: [],
  risk: "low",
  permissions: [],
  secrets: [],
  install: { scope: "local", steps: [{ "download-binary": { binary: "demo-tool" } }] },
  reviews: [],
});

function fakeFetch(): typeof fetch & { calls: number } {
  const f = (async () => {
    f.calls++;
    return new Response(new Uint8Array(bytes));
  }) as unknown as typeof fetch & { calls: number };
  f.calls = 0;
  return f;
}

describe("ensureTool", () => {
  it("downloads, checks the sha256, unpacks the binary into <tools>/<id>/<version>, then reuses it", async () => {
    const dir = join(work, "tools-a");
    const fetchImpl = fakeFetch();
    const first = await ensureTool(item(), { dir, fetchImpl, key });
    assert.equal(first.source, "download");
    assert.equal(first.path, toolPath(dir, item()));
    assert.ok(existsSync(first.path));
    assert.match(readFileSync(first.path, "utf8"), /echo demo 1\.0\.0/);
    assert.equal(first.archiveSha256, digest);

    const second = await ensureTool(item(), { dir, fetchImpl, key });
    assert.equal(second.source, "cache");
    assert.equal(fetchImpl.calls, 1, "the cached copy is used");
    assert.equal(findTool("demo-tool", dir, { PATH: "" }), first.path);
  });

  it("downloads again when the cached binary was changed", async () => {
    const dir = join(work, "tools-b");
    const fetchImpl = fakeFetch();
    const { path } = await ensureTool(item(), { dir, fetchImpl, key });
    writeFileSync(path, "tampered");
    const again = await ensureTool(item(), { dir, fetchImpl, key });
    assert.equal(again.source, "download");
    assert.match(readFileSync(path, "utf8"), /echo demo/);
  });

  it("refuses an archive whose sha256 doesn't match, and leaves nothing behind", async () => {
    const dir = join(work, "tools-c");
    await assert.rejects(
      ensureTool(item("0".repeat(64)), { dir, fetchImpl: fakeFetch(), key }),
      /failed its sha256 check/,
    );
    assert.ok(!existsSync(join(dir, "demo-tool")));
  });

  it("says so when there's no build for this platform", async () => {
    await assert.rejects(
      ensureTool(item(), { dir: join(work, "tools-d"), fetchImpl: fakeFetch(), key: null }),
      /no build/,
    );
  });
});
