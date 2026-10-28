import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const exe = process.platform === "win32" ? "claude.exe" : "claude";

/**
 * Finds the user's own `claude` binary (ADR-0002): PATH first, then the documented install locations.
 * Login-shell env resolution for GUI launches is M1-03; in dev the app inherits the terminal's PATH.
 */
export function findClaude(): string | null {
  const fromPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, exe));
  const known = [
    join(homedir(), ".local", "bin", exe),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return [...fromPath, ...known].find((candidate) => existsSync(candidate)) ?? null;
}

/** Returns the `claude --version` output, e.g. "2.1.293 (Claude Code)", or null if it can't run. */
export function claudeVersion(path: string): string | null {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}
