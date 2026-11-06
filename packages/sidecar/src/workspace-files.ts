import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { t } from "./i18n/index.ts";

/**
 * Workspace files the app reads or writes itself (setup fixes, catalog items, generated files, its own folder) must
 * stay in the workspace. A cloned repository can commit symbolic links, such as `.claude -> ~/.claude` or
 * `CLAUDE.md -> ~/.gitconfig`, which plain reads and writes would follow out of it (security review, 2026-11-04).
 */

/** The first part of `rel` under `root` that's a symbolic link, as a relative path, or null when there's none. */
export function linkIn(root: string, rel: string): string | null {
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
  let at = root;
  for (const [i, part] of parts.entries()) {
    at = path.join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return parts.slice(0, i + 1).join("/");
    } catch {
      return null; // Not there yet, so nothing below it is a link either.
    }
  }
  return null;
}

/** Throws when `rel` goes through a symbolic link, before the app writes, backs up or deletes it. */
export function refuseLinks(root: string, rel: string): void {
  const link = linkIn(root, rel);
  if (link) throw new Error(t("git.files.symlink", { path: link }));
}

/** Previews read at most this much of a file. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * A workspace file's text for a preview or a check: "" when it's missing, and also when it's reached through a link,
 * isn't a regular file, or is larger than `max`. Applying a change to such a file then fails in `refuseLinks`, with a
 * reason, instead of reading something outside the workspace (or a device that never ends).
 */
export function readWorkspaceText(root: string, rel: string, max = MAX_PREVIEW_BYTES): string {
  if (linkIn(root, rel)) return "";
  const file = path.join(root, ...rel.split(/[\\/]+/));
  try {
    const st = lstatSync(file);
    return st.isFile() && st.size <= max ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}
