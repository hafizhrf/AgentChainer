// Release assets (R1-01, R1-04), used by .github/workflows/release.yml:
// - `collect` copies one runner's installers (and their updater signatures) out of target/release/bundle under names
//   that don't collide between runners: the macOS updater archive gets its version and architecture.
// - `finalize` writes SHA256SUMS for every asset of the release, and the updater manifest latest.json for the ones
//   that carry a signature. Without the signing key there are no .sig files, and no latest.json.
//
// Usage: node scripts/release-assets.mjs collect <bundle dir> <out dir> [--version x.y.z]
//        node scripts/release-assets.mjs finalize <assets dir> <tag> [--notes notes.md] [--repo owner/name]
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

const ARCH = { arm64: "aarch64", x64: "x86_64" };

/** The app version, from the crate (tauri.conf.json has none, so Tauri uses this one too). */
export function crateVersion() {
  const toml = readFileSync(new URL("../apps/desktop/src-tauri/Cargo.toml", import.meta.url), "utf8");
  const version = /^version\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!version) throw new Error("No version in apps/desktop/src-tauri/Cargo.toml");
  return version;
}

/** Installers by bundle folder; each may have a `.sig` beside it. */
const BUNDLES = [
  ["dmg", (f) => f.endsWith(".dmg")],
  ["macos", (f) => f.endsWith(".app.tar.gz")],
  ["msi", (f) => f.endsWith(".msi")],
  ["nsis", (f) => f.endsWith("-setup.exe")],
  ["deb", (f) => f.endsWith(".deb")],
  ["rpm", (f) => f.endsWith(".rpm")],
  ["appimage", (f) => f.endsWith(".AppImage")],
];

/** Copies one runner's installers into `out`. Returns the copied file names. */
export function collect(bundleDir, out, { version = crateVersion(), arch = ARCH[process.arch] ?? process.arch } = {}) {
  mkdirSync(out, { recursive: true });
  const copied = [];
  for (const [folder, matches] of BUNDLES) {
    const dir = join(bundleDir, folder);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(matches)) {
      // Both macOS runners produce AgentChainer.app.tar.gz.
      const name = file.endsWith(".app.tar.gz")
        ? file.replace(/\.app\.tar\.gz$/, `_${version}_${arch}.app.tar.gz`)
        : file;
      for (const [from, to] of [
        [file, name],
        [`${file}.sig`, `${name}.sig`],
      ]) {
        if (!existsSync(join(dir, from))) continue;
        copyFileSync(join(dir, from), join(out, to));
        copied.push(to);
      }
    }
  }
  if (!copied.length) throw new Error(`No installers in ${bundleDir}`);
  return copied;
}

const archOf = (name) => (/aarch64|arm64/.test(name) ? "aarch64" : /x86_64|x64|amd64/.test(name) ? "x86_64" : null);

/**
 * The updater platform key of an asset: `{os}-{arch}-{installer}`, which the updater looks up first. There are no
 * `{os}-{arch}` fallbacks for Windows and Linux: an app installed from a .deb must never be handed an AppImage.
 */
export function platformKeys(name) {
  const arch = archOf(name);
  if (!arch) return [];
  if (name.endsWith(".app.tar.gz")) return [`darwin-${arch}-app`, `darwin-${arch}`];
  if (name.endsWith(".msi")) return [`windows-${arch}-msi`];
  if (name.endsWith("-setup.exe")) return [`windows-${arch}-nsis`];
  if (name.endsWith(".AppImage")) return [`linux-${arch}-appimage`];
  if (name.endsWith(".deb")) return [`linux-${arch}-deb`];
  if (name.endsWith(".rpm")) return [`linux-${arch}-rpm`];
  return [];
}

/** Writes SHA256SUMS and, when assets are signed, latest.json into `dir`. Returns what was written. */
export function finalize(dir, tag, { notes = "", repo = "hafizhrf/AgentChainer", now = new Date() } = {}) {
  const generated = new Set(["SHA256SUMS", "latest.json"]);
  const files = readdirSync(dir)
    .filter((f) => !generated.has(f))
    .sort();
  const assets = files.filter((f) => !f.endsWith(".sig"));
  const sums = assets.map(
    (f) =>
      `${createHash("sha256")
        .update(readFileSync(join(dir, f)))
        .digest("hex")}  ${f}`,
  );
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  const written = ["SHA256SUMS"];

  const platforms = {};
  for (const f of assets) {
    if (!files.includes(`${f}.sig`)) continue;
    const signature = readFileSync(join(dir, `${f}.sig`), "utf8").trim();
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(f)}`;
    for (const key of platformKeys(f)) {
      if (platforms[key]) throw new Error(`Two assets for ${key}: ${platforms[key].url} and ${url}`);
      platforms[key] = { signature, url };
    }
  }
  if (Object.keys(platforms).length) {
    const manifest = { version: tag.replace(/^v/, ""), notes, pub_date: now.toISOString(), platforms };
    writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    written.push("latest.json");
  }
  return written;
}

if (process.argv[1] && basename(process.argv[1]) === "release-assets.mjs") {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { version: { type: "string" }, notes: { type: "string" }, repo: { type: "string" } },
  });
  const [command, a, b] = positionals;
  if (command === "collect" && a && b) {
    const copied = collect(a, b, values.version ? { version: values.version } : {});
    console.log(copied.join("\n"));
  } else if (command === "finalize" && a && b) {
    const written = finalize(a, b, {
      ...(values.notes ? { notes: readFileSync(values.notes, "utf8").trim() } : {}),
      ...(values.repo ? { repo: values.repo } : {}),
    });
    console.log(
      `wrote ${written.join(", ")}${written.includes("latest.json") ? "" : " (no signatures: no updater manifest)"}`,
    );
  } else {
    console.error("usage: release-assets.mjs collect <bundle dir> <out dir> | finalize <assets dir> <tag>");
    process.exit(2);
  }
}
