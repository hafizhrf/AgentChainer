import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AuthState, EnvCheck } from "@agentchainer/protocol";

/** Oldest Claude Code CLI version verified with this app (spikes S2/S3/S5 ran on 2.1.293). */
export const MIN_CLAUDE_VERSION = "2.1.293";

/** Where npm puts the real binary relative to its bin shims: the package's `bin` is `bin/claude.exe` on every OS. */
const NPM_EXE = ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"];

type Platform = NodeJS.Platform;

/**
 * Finds the user's own `claude` binary (ADR-0002).
 * 1. `AGENTCHAINER_CLAUDE_PATH` (the app's "Claude CLI path" setting) wins.
 * 2. Then each PATH entry. The Rust core resolves the login-shell PATH for GUI launches (M1-03).
 * 3. Then the documented install locations.
 */
export function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = process.platform,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
  readText: (p: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  const override = env.AGENTCHAINER_CLAUDE_PATH;
  if (override) return exists(override) ? override : null;

  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  if (platform !== "win32") {
    const known = [p.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
    return [...dirs.map((d) => p.join(d, "claude")), ...known].find(exists) ?? null;
  }

  // Windows: the native installer puts claude.exe on PATH. An npm install puts a claude.cmd shim there instead
  // (spike S6, CI), and Node can't spawn .cmd files without a shell, so resolve the shim to the real exe.
  const appData = env.APPDATA ?? p.join(home, "AppData", "Roaming");
  for (const dir of [...dirs, p.join(home, ".local", "bin"), p.join(appData, "npm")]) {
    const native = p.join(dir, "claude.exe");
    if (exists(native)) return native;
    const shim = p.join(dir, "claude.cmd");
    if (exists(shim)) {
      const target = exeFromNpmShim(readText(shim), dir, p) ?? p.join(dir, ...NPM_EXE);
      if (exists(target)) return target;
    }
  }
  return null;
}

/** npm's cmd-shim launches `"%dp0%\…\claude.exe"`, where %dp0% is the shim's own folder. */
export function exeFromNpmShim(text: string, dir: string, p: path.PlatformPath = path.win32): string | null {
  const match = /"%~?dp0%?\\([^"]*claude\.exe)"/i.exec(text);
  return match?.[1] ? p.join(dir, ...match[1].split("\\")) : null;
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
