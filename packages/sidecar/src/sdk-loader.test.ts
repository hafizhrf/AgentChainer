import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { ensureSdk, sriOf } from "./sdk-loader.ts";
import type { SdkPin } from "./sdk-pin.ts";

// A tiny stand-in for the npm tarball: package/sdk.mjs, packed with the system tar like npm does.
const work = mkdtempSync(join(tmpdir(), "ac-sdk-test-"));
mkdirSync(join(work, "src", "package"), { recursive: true });
writeFileSync(join(work, "src", "package", "sdk.mjs"), 'export const query = () => "fake-sdk";\n');
spawnSync("tar", ["-czf", join(work, "sdk.tgz"), "-C", join(work, "src"), "package"]);
const tarball = readFileSync(join(work, "sdk.tgz"));
const pin: SdkPin = {
  name: "fake-sdk",
  version: "1.2.3",
  tarball: "https://registry.test/fake.tgz",
  integrity: sriOf(tarball),
};

const serve = (body: Uint8Array, status = 200) => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

describe("ensureSdk", () => {
  after(() => rmSync(work, { recursive: true, force: true }));

  it("downloads, verifies, extracts and then reuses the cached copy", async () => {
    const root = join(work, "data-ok");
    const { fetchImpl, calls } = serve(tarball);
    const first = await ensureSdk(root, pin, fetchImpl);
    assert.equal(first.source, "download");
    const entry = first.entry;
    const sdk = (await import(pathToFileURL(entry).href)) as { query: () => string };
    assert.equal(sdk.query(), "fake-sdk");
    assert.equal((await ensureSdk(root, pin, fetchImpl)).source, "cache");
    assert.equal(calls.length, 1, "second call uses the verified cache");
  });

  it("refuses a tarball whose hash doesn't match the pin", async () => {
    const tampered = new Uint8Array(tarball);
    tampered[tampered.length - 10] = (tampered[tampered.length - 10] ?? 0) ^ 0xff;
    const { fetchImpl } = serve(tampered);
    await assert.rejects(ensureSdk(join(work, "data-bad"), pin, fetchImpl), /integrity check/);
  });

  it("explains network and HTTP failures", async () => {
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(ensureSdk(join(work, "data-offline"), pin, offline), /offline or blocked/);
    await assert.rejects(ensureSdk(join(work, "data-404"), pin, serve(tarball, 404).fetchImpl), /HTTP 404/);
  });

  it("gives up on a stalled download instead of hanging", async () => {
    // Never answers, but honours the abort signal like the real fetch does.
    const stalled = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as typeof fetch;
    await assert.rejects(ensureSdk(join(work, "data-stalled"), pin, stalled, 50), /timed out after 0 s/);
  });
});
