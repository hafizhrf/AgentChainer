import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { collect, crateVersion, finalize, platformKeys } from "./release-assets.mjs";

const work = mkdtempSync(join(tmpdir(), "ac-release-assets-"));
after(() => rmSync(work, { recursive: true, force: true }));

function bundle(name, files) {
  const dir = join(work, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe("collect", () => {
  it("names the macOS updater archive after its version and architecture, so two runners don't collide", () => {
    const out = join(work, "out-mac");
    const dir = bundle("mac", {
      "dmg/AgentChainer_0.2.0_aarch64.dmg": "dmg",
      "macos/AgentChainer.app.tar.gz": "tar",
      "macos/AgentChainer.app.tar.gz.sig": "sig",
      "macos/AgentChainer.app/Contents/Info.plist": "plist",
    });
    assert.deepEqual(collect(dir, out, { version: "0.2.0", arch: "aarch64" }).sort(), [
      "AgentChainer_0.2.0_aarch64.app.tar.gz",
      "AgentChainer_0.2.0_aarch64.app.tar.gz.sig",
      "AgentChainer_0.2.0_aarch64.dmg",
    ]);
  });

  it("fails when a runner built nothing", () => {
    assert.throws(() => collect(bundle("empty", { "x.txt": "" }), join(work, "out-empty")), /No installers/);
  });
});

describe("finalize", () => {
  it("writes SHA256SUMS for every asset and latest.json for the signed ones", () => {
    const dir = bundle("release", {
      "AgentChainer_0.2.0_aarch64.app.tar.gz": "mac",
      "AgentChainer_0.2.0_aarch64.app.tar.gz.sig": "c2lnLW1hYw==\n",
      "AgentChainer_0.2.0_aarch64.dmg": "dmg",
      "AgentChainer_0.2.0_x64_en-US.msi": "msi",
      "AgentChainer_0.2.0_x64_en-US.msi.sig": "c2lnLW1zaQ==",
      "AgentChainer_0.2.0_x64-setup.exe": "exe",
      "AgentChainer_0.2.0_x64-setup.exe.sig": "c2lnLWV4ZQ==",
      "AgentChainer_0.2.0_amd64.AppImage": "appimage",
      "AgentChainer_0.2.0_amd64.AppImage.sig": "c2lnLWFp",
      "AgentChainer_0.2.0_amd64.deb": "deb",
    });
    const now = new Date("2026-11-01T00:00:00Z");
    assert.deepEqual(finalize(dir, "v0.2.0", { notes: "Fixes", now }), ["SHA256SUMS", "latest.json"]);

    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.equal(sums.length, 6, "one line per asset, none for .sig files");
    const sha = createHash("sha256").update("dmg").digest("hex");
    assert.ok(sums.includes(`${sha}  AgentChainer_0.2.0_aarch64.dmg`), "sha256sum -c format");

    const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.notes, "Fixes");
    assert.equal(manifest.pub_date, "2026-11-01T00:00:00.000Z");
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "darwin-aarch64-app",
      "linux-x86_64-appimage",
      "windows-x86_64-msi",
      "windows-x86_64-nsis",
    ]);
    assert.deepEqual(manifest.platforms["windows-x86_64-msi"], {
      signature: "c2lnLW1zaQ==",
      url: "https://github.com/hafizhrf/AgentChainer/releases/download/v0.2.0/AgentChainer_0.2.0_x64_en-US.msi",
    });
    assert.equal(manifest.platforms["darwin-aarch64-app"].signature, "c2lnLW1hYw==", "trimmed");
  });

  it("writes no updater manifest when nothing is signed, and running it again changes nothing", () => {
    const dir = bundle("unsigned", { "AgentChainer_0.2.0_aarch64.dmg": "dmg" });
    assert.deepEqual(finalize(dir, "v0.2.0"), ["SHA256SUMS"]);
    const first = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    finalize(dir, "v0.2.0");
    assert.equal(readFileSync(join(dir, "SHA256SUMS"), "utf8"), first, "SHA256SUMS doesn't list itself");
    assert.deepEqual(readdirSync(dir).sort(), ["AgentChainer_0.2.0_aarch64.dmg", "SHA256SUMS"]);
  });
});

describe("platformKeys", () => {
  it("never gives Windows or Linux a generic fallback", () => {
    assert.deepEqual(platformKeys("AgentChainer_0.2.0_amd64.deb"), ["linux-x86_64-deb"]);
    assert.deepEqual(platformKeys("AgentChainer-0.2.0-1.x86_64.rpm"), ["linux-x86_64-rpm"]);
    assert.deepEqual(platformKeys("AgentChainer_0.2.0_x86_64.app.tar.gz"), ["darwin-x86_64-app", "darwin-x86_64"]);
    assert.deepEqual(platformKeys("notes.txt"), []);
  });
});

it("reads the version from the crate", () => {
  assert.match(crateVersion(), /^\d+\.\d+\.\d+/);
});
