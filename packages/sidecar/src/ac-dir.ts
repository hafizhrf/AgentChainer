import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { refuseLinks } from "./workspace-files.ts";

/** AgentChainer's folder in a workspace. */
export const AC_DIR = ".agentchainer";

/**
 * Adds `entry` to `.agentchainer/.gitignore` when it's missing, so derived or local data (the profile, task files)
 * stays out of git. Creates the folder and the file as needed.
 */
export function ensureIgnored(root: string, entry: string): void {
  // A cloned repo's `.agentchainer` could be a link elsewhere; the app's own files never go through one.
  refuseLinks(root, `${AC_DIR}/.gitignore`);
  const dir = path.join(root, AC_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (current.split("\n").includes(entry)) return;
  writeFileSync(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
}
