import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AuthState, EnvCheck } from "@agentchainer/protocol";

/** Oldest Claude Code CLI version verified with this app (spikes S2/S3/S5 ran on 2.1.293). */
export const MIN_CLAUDE_VERSION = "2.1.293";

const exe = process.platform === "win32" ? "claude.exe" : "claude";

/**
 * Finds the user's own `claude` binary (ADR-0002): PATH first, then the documented install locations.
 * Login-shell env resolution for GUI launches is M1-03; in dev the app inherits the terminal's PATH.
 */
export function findClaude(): string | null {
  const fromPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const known = [join(homedir(), ".local", "bin", exe), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return [...fromPath, ...known].find((candidate) => existsSync(candidate)) ?? null;
}

/** Returns the `claude --version` output, e.g. "2.1.293 (Claude Code)", or null if it can't run. */
export function claudeVersion(path: string): string | null {
  const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Extracts [major, minor, patch] from strings like "2.1.293 (Claude Code)". */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch >= bPatch;
}

/**
 * Keeps only the fields ADR-0002 allows. `claude auth status --json` also returns email and org details;
 * those never leave this function.
 */
export function parseAuthStatus(json: string): AuthState | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.loggedIn !== "boolean") return null;
    return {
      loggedIn: raw.loggedIn,
      method: typeof raw.authMethod === "string" ? raw.authMethod : "unknown",
      provider: typeof raw.apiProvider === "string" ? raw.apiProvider : "unknown",
    };
  } catch {
    return null;
  }
}

/** `claude auth status --json` exits 1 when logged out but still prints JSON, so read stdout either way. */
export function readAuthStatus(path: string): AuthState | null {
  const r = spawnSync(path, ["auth", "status", "--json"], { encoding: "utf8", timeout: 15_000 });
  return r.stdout ? parseAuthStatus(r.stdout) : null;
}

export function gitVersion(): string | null {
  const r = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Readiness check behind the onboarding screen (spike S5). Takes ~0.5 s, dominated by `claude auth status`. */
export function checkEnvironment(): EnvCheck {
  const path = findClaude();
  const version = path ? claudeVersion(path) : null;
  const versionOk = version !== null && isAtLeast(version, MIN_CLAUDE_VERSION);
  const auth = path && version ? readAuthStatus(path) : null;
  const git = gitVersion();
  return {
    platform: process.platform,
    node: process.version,
    claude: { path, version, minVersion: MIN_CLAUDE_VERSION, versionOk },
    auth,
    git: { version: git },
    ready: versionOk && auth?.loggedIn === true && git !== null,
  };
}

/** Runs the user's CLI non-interactively (used by the installer, spike S6). */
export function runClaude(
  path: string,
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(path, args, { cwd, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
