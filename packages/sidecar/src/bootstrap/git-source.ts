import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { systemTar } from "./tools.ts";

/**
 * Pinned git sources for catalog items (M2-13, ADR-0005): a GitHub tarball at a full commit SHA, verified against
 * the catalog's sha256 of the normalized tree before anything is copied. No upstream script ever runs.
 */

/**
 * sha256 of a folder's content, independent of timestamps, permissions and archive format: one line per file,
 * `<path>\0<sha256 of its bytes>\n`, sorted by `/`-separated path. Symlinks are refused (they could point anywhere).
 */
export function treeHash(dir: string): string {
  const lines: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isSymbolicLink()) throw new Error(`refusing a symlink in a catalog source: ${childRel}`);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile())
        lines.push(`${childRel}\0${createHash("sha256").update(readFileSync(childAbs)).digest("hex")}\n`);
    }
  };
  walk(dir, "");
  return createHash("sha256").update(lines.sort().join("")).digest("hex");
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatSync(childAbs);
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push(childRel);
    }
  };
  walk(dir, "");
  return out;
}

/** `dir` is the folder at the source's path; `root` is the repository's top folder, for its license file. */
export type FetchedTree = { dir: string; root: string; cleanup: () => void };
export type FetchTree = (repo: string, ref: string, subpath: string) => Promise<FetchedTree>;

/**
 * The bytes of a source's pinned license file (M2-29), read from the fetched repository: a regular file inside it
 * whose sha256 matches the catalog's, or an error.
 */
export function readLicense(root: string, license: { path: string; sha256: string }, id: string): Buffer {
  const file = path.join(root, ...license.path.split("/"));
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`Bad license path for ${id}: ${license.path}`);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    throw new Error(`${id}'s license file ${license.path} isn't in the source. Not installed.`);
  }
  if (!st.isFile()) throw new Error(`${id}'s license file ${license.path} isn't a regular file. Not installed.`);
  const bytes = readFileSync(file);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== license.sha256) {
    throw new Error(`Hash mismatch for ${id}'s license: expected ${license.sha256}, got ${got}. Not installed.`);
  }
  return bytes;
}

/** Downloads `repo` (a github.com URL) at `ref` and returns the folder at `subpath` inside it. */
export const fetchGitHubTree: FetchTree = async (repo, ref, subpath) => {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/.exec(repo);
  if (!m) throw new Error(`Only github.com sources are supported: ${repo}`);
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`Not a full commit SHA: ${ref}`);
  const res = await fetch(`https://codeload.github.com/${m[1]}/${m[2]}/tar.gz/${ref}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Downloading ${repo}@${ref.slice(0, 7)} failed: HTTP ${res.status}`);
  const work = mkdtempSync(path.join(tmpdir(), "ac-source-"));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  try {
    const archive = path.join(work, "source.tar.gz");
    writeFileSync(archive, new Uint8Array(await res.arrayBuffer()));
    // System tar (bsdtar on macOS and Windows 10+, GNU tar on Linux) refuses absolute and `..` entry paths.
    const tar = spawnSync(systemTar(), ["-xzf", archive, "-C", work], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`Extracting the source failed: ${tar.stderr.trim()}`);
    const top = readdirSync(work).find((n) => n !== "source.tar.gz");
    if (!top) throw new Error("The source archive was empty.");
    const root = path.join(work, top);
    const dir = path.join(root, ...subpath.split("/").filter((p) => p && p !== "."));
    if (path.relative(root, dir).startsWith("..")) throw new Error(`Bad source path: ${subpath}`);
    return { dir, root, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
};
