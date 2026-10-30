import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, parseStatus, repoOf } from "../workspace.ts";

/**
 * Keeps commands from changing the workspace behind the user's back (M2-20). Generators and the verifier run the
 * project's own commands, and those can write: pnpm installs before `pnpm run` and rewrites the lockfile, test
 * runners write snapshots. The guard records git's view of the workspace before, and afterwards reverts every change
 * the commands made to files git sees (tracked or not ignored). Files that were already modified are restored from a
 * copy. Ignored files (node_modules, dist, coverage) are left alone.
 */

type Entry = { code: string; hash: string | null; content: Buffer | null };

function snapshot(top: string): Map<string, Entry> {
  const raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], top).stdout;
  const entries = new Map<string, Entry>();
  for (const [file, e] of parseStatus(raw)) {
    const abs = path.join(top, ...file.split("/"));
    const content = existsSync(abs) ? readFileSync(abs) : null;
    entries.set(file, {
      code: `${e.status}:${e.staged}:${e.unstaged}`,
      hash: content ? createHash("sha256").update(content).digest("hex") : null,
      content,
    });
  }
  return entries;
}

/** Runs `fn`, then reverts what it changed in the git-visible workspace. Returns the reverted paths. */
export async function guarded<T>(root: string, fn: () => Promise<T>): Promise<{ result: T; reverted: string[] }> {
  const repo = repoOf(root);
  if (!repo) return { result: await fn(), reverted: [] };
  const top = repo.top;
  const before = snapshot(top);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // Revert even when fn threw, so a failed generator leaves nothing behind either.
  const reverted = restore(top, before);
  if (!outcome.ok) throw outcome.error;
  return { result: outcome.value, reverted };
}

function restore(top: string, before: Map<string, Entry>): string[] {
  const after = snapshot(top);
  const reverted: string[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const file of paths) {
    const b = before.get(file);
    const a = after.get(file);
    if (b && a && b.code === a.code && b.hash === a.hash) continue;
    const abs = path.join(top, ...file.split("/"));
    if (b) {
      // The file was already modified (or new) before: put back exactly what was there.
      if (b.content) {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, b.content);
      } else {
        rmSync(abs, { force: true });
      }
    } else if (a?.code.startsWith("untracked")) {
      rmSync(abs, { force: true });
    } else {
      // Clean before: back to the index (staged state untouched).
      git(["checkout", "-q", "--", file], top);
    }
    reverted.push(file);
  }
  return reverted.sort();
}

/**
 * Each git-visible changed file with a hash of its content (null when deleted). Comparing two fingerprints tells what
 * a command changed, e.g. the files a formatter rewrote. Empty outside git.
 */
export function fingerprint(root: string): Map<string, string | null> {
  const repo = repoOf(root);
  if (!repo) return new Map();
  return new Map([...snapshot(repo.top)].map(([file, e]) => [file, e.hash]));
}

/** The files whose content differs between two fingerprints. */
export function changedBetween(before: Map<string, string | null>, after: Map<string, string | null>): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter((f) => (before.get(f) ?? "clean") !== (after.get(f) ?? "clean")).sort();
}
