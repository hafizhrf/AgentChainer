import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

export type FetchedTree = { dir: string; cleanup: () => void };
export type FetchTree = (repo: string, ref: string, subpath: string) => Promise<FetchedTree>;

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
    const tar = spawnSync("tar", ["-xzf", archive, "-C", work], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`Extracting the source failed: ${tar.stderr.trim()}`);
    const top = readdirSync(work).find((n) => n !== "source.tar.gz");
    if (!top) throw new Error("The source archive was empty.");
    const dir = path.join(work, top, ...subpath.split("/").filter((p) => p && p !== "."));
    if (path.relative(path.join(work, top), dir).startsWith("..")) throw new Error(`Bad source path: ${subpath}`);
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
};
