import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Item } from "../catalog/schema.ts";
import { compareVersions } from "../catalog/updates.ts";

/**
 * Pinned release binaries (M2-15, ADR-0005): downloaded from the catalog's URL, checked against its sha256, unpacked
 * with the system tar, and kept in an app-managed folder, `<tools>/<item>/<version>/<binary>`. No upstream installer
 * ever runs. The folder is a cache shared by workspaces, so rollbacks leave binaries in place.
 */

/**
 * The system tar: bsdtar on macOS and Windows 10+ (which also reads zip), GNU tar on Linux. On Windows, Git's GNU tar
 * can come first on PATH and reads `C:\…` as a remote host, so Windows' own is used by its full path.
 */
export function systemTar(): string {
  if (process.platform !== "win32") return "tar";
  const own = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(own) ? own : "tar";
}

export const PLATFORM_KEYS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export function platformKey(platform: string = process.platform, arch: string = process.arch): PlatformKey | null {
  return PLATFORM_KEYS.find((k) => k === `${platform}-${arch}`) ?? null;
}

/** The app's tools folder: set by the Rust core for every sidecar it starts. */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AGENTCHAINER_TOOLS_DIR) return env.AGENTCHAINER_TOOLS_DIR;
  return env.AGENTCHAINER_DATA_DIR ? path.join(env.AGENTCHAINER_DATA_DIR, "tools") : null;
}

/** The binary an item's `download-binary` step names, or null for items without one. */
export function binaryName(item: Item): string | null {
  for (const step of item.install.steps) if ("download-binary" in step) return step["download-binary"].binary;
  return null;
}

const exe = (name: string, platform: string) => (platform === "win32" ? `${name}.exe` : name);

/** Where an item's binary lives once installed. Known before downloading, so plans can show it. */
export function toolPath(dir: string, item: Item, platform: string = process.platform): string {
  const name = binaryName(item);
  if (!name || item.source.type !== "release-asset") throw new Error(`${item.id} has no release binary`);
  return path.join(dir, item.id, item.source.version, exe(name, platform));
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
/** Next to each installed binary: its archive's and its own sha256, checked before it's used (hooks check it too). */
export const MARKER = ".agentchainer-tool.json";
type Marker = { archiveSha256: string; binarySha256: string };

export type EnsuredTool = { path: string; version: string; archiveSha256: string; source: "cache" | "download" };

/** Returns the verified binary of a release-asset item, downloading and unpacking it first when needed. */
export async function ensureTool(
  item: Item,
  opts: {
    dir: string;
    key?: PlatformKey | null;
    platform?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<EnsuredTool> {
  const src = item.source;
  if (src.type !== "release-asset") throw new Error(`${item.id} isn't a release binary`);
  const platform = opts.platform ?? process.platform;
  const key = opts.key === undefined ? platformKey() : opts.key;
  const asset = key ? src.assets[key] : undefined;
  if (!key || !asset) throw new Error(`${item.name} has no build for ${key ?? `${process.platform}-${process.arch}`}.`);
  const name = binaryName(item);
  if (!name) throw new Error(`${item.id} doesn't name its binary`);

  const target = toolPath(opts.dir, item, platform);
  const versionDir = path.dirname(target);
  const cached = readMarker(versionDir);
  if (
    cached?.archiveSha256 === asset.sha256 &&
    existsSync(target) &&
    sha256(readFileSync(target)) === cached.binarySha256
  ) {
    return { path: target, version: src.version, archiveSha256: asset.sha256, source: "cache" };
  }

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let data: Uint8Array;
  try {
    const res = await (opts.fetchImpl ?? fetch)(asset.url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    const reason = signal.aborted
      ? `timed out after ${Math.round(timeoutMs / 1000)} s`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`Couldn't download ${item.name} ${src.version} (offline or blocked by a proxy?): ${reason}`);
  }
  const got = sha256(data);
  if (got !== asset.sha256) {
    throw new Error(
      `${item.name} ${src.version} failed its sha256 check (expected ${asset.sha256}, got ${got}). Not installed.`,
    );
  }

  // Unpack next to the final folder (same disk), then rename into place, so a crash never leaves a half-written tool.
  mkdirSync(opts.dir, { recursive: true });
  const work = path.join(opts.dir, `.tmp-${randomBytes(4).toString("hex")}`);
  try {
    const unpacked = path.join(work, "unpacked");
    mkdirSync(unpacked, { recursive: true });
    const archive = path.join(work, path.basename(new URL(asset.url).pathname));
    writeFileSync(archive, data);
    let found: string | null;
    if (/\.(tar\.gz|tgz|zip)$/i.test(archive)) {
      // bsdtar (macOS, Windows 10+) reads zip too; it and GNU tar refuse absolute and `..` entry paths.
      const tar = spawnSync(systemTar(), ["-xf", archive, "-C", unpacked], { encoding: "utf8" });
      if (tar.status !== 0) throw new Error(`Unpacking ${path.basename(archive)} failed: ${tar.stderr.trim()}`);
      found = findFile(unpacked, [name, `${name}.exe`], 4);
    } else {
      found = archive; // a bare binary
    }
    if (!found) throw new Error(`${path.basename(archive)} doesn't contain ${name}`);

    const staged = path.join(work, "version");
    mkdirSync(staged);
    const binary = path.join(staged, path.basename(target));
    copyFileSync(found, binary);
    chmodSync(binary, 0o755);
    // The license and third-party notices travel with the binary (catalog review, 2026-10-30).
    for (const notice of noticeFiles([path.dirname(found), unpacked])) {
      copyFileSync(notice, path.join(staged, path.basename(notice)));
    }
    if (platform === "darwin") adHocSign(binary);
    const marker: Marker = { archiveSha256: asset.sha256, binarySha256: sha256(readFileSync(binary)) };
    writeFileSync(path.join(staged, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    mkdirSync(path.dirname(versionDir), { recursive: true });
    rmSync(versionDir, { recursive: true, force: true });
    renameSync(staged, versionDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { path: target, version: src.version, archiveSha256: asset.sha256, source: "download" };
}

function readMarker(dir: string): Marker | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, MARKER), "utf8")) as Marker;
  } catch {
    return null;
  }
}

/** The first regular file named one of `names`, at most `depth` folders down. Symlinks are ignored. */
const NOTICE = /^(licen[sc]e|copying|notice|third[_-]party[_-]notices?)(\.[\w-]+)?$/i;

/** License and notice files directly in `dirs` (the binary's folder and the archive's root), without duplicates. */
function noticeFiles(dirs: string[]): string[] {
  const byName = new Map<string, string>();
  for (const dir of dirs) {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (NOTICE.test(entry) && lstatSync(p).isFile() && !byName.has(entry)) byName.set(entry, p);
    }
  }
  return [...byName.values()];
}

function findFile(dir: string, names: string[], depth: number): string | null {
  for (const entry of readdirSync(dir).sort()) {
    const p = path.join(dir, entry);
    const st = lstatSync(p);
    if (st.isFile() && names.includes(entry)) return p;
    if (st.isDirectory() && depth > 0) {
      const hit = findFile(p, names, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Apple Silicon only runs signed code. Most release binaries are (Go signs ad hoc); one that isn't gets an ad-hoc
 * signature, as the projects' own installers do. A failure here surfaces when the binary runs.
 */
function adHocSign(binary: string): void {
  if (spawnSync("codesign", ["-v", binary]).status === 0) return;
  spawnSync("codesign", ["--force", "--sign", "-", binary]);
}

/** An installed copy of a tool in the app's folder (the newest version), or the first one on PATH. */
export function findTool(name: string, dir: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const file = exe(name, process.platform);
  if (dir && existsSync(dir)) {
    for (const id of readdirSync(dir).filter((d) => !d.startsWith("."))) {
      const itemDir = path.join(dir, id);
      if (!lstatSync(itemDir).isDirectory()) continue;
      // Newest first by version, not by string: 1.7.12 is newer than 1.7.9.
      for (const version of readdirSync(itemDir).sort((a, b) => compareVersions(b, a))) {
        const p = path.join(itemDir, version, file);
        if (existsSync(p) && readMarker(path.dirname(p))) return p;
      }
    }
  }
  return onPath(name, env);
}

/** `name` on PATH (with PATHEXT on Windows), or null. */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const d of dirs) {
    for (const e of exts) {
      for (const candidate of [path.join(d, name + e.toLowerCase()), path.join(d, name + e)]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}
