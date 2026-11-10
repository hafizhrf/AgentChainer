import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Cli } from "../deploy/cli.ts";
import type { AgyHost } from "./agy.ts";
import type { CodexHost } from "./codex.ts";
import type { LiveSession } from "./types.ts";

/**
 * The user's own Codex CLI for task steps (M9-04): `AGENTCHAINER_CODEX_PATH` when set, else `codex` on PATH (an npm
 * shim is run with `node`, as for deploy CLIs). Null when it isn't installed or doesn't answer `--version`.
 */
export function codexHost(
  resolve: (name: string) => Cli | null,
  registry: { register(session: LiveSession): void; unregister(sessionId: string): void },
  env: NodeJS.ProcessEnv = process.env,
): CodexHost | null {
  const set = env.AGENTCHAINER_CODEX_PATH;
  const cli: Cli | null = set ? { bin: set, prefix: [] } : resolve("codex");
  if (!cli) return null;
  try {
    const version = execFileSync(cli.bin, [...cli.prefix, "--version"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    }).trim();
    return { cli, version, ...registry };
  } catch {
    return null;
  }
}

/**
 * The user's own Antigravity CLI for task steps (M9-05): `AGENTCHAINER_AGY_PATH` when set, else `agy` on PATH, else
 * where its Windows installer puts it (`%LOCALAPPDATA%\agy\bin\agy.exe`), which a running app's PATH may not have
 * yet. Null when it isn't installed or doesn't answer `--version`.
 */
export function agyHost(
  onPath: (name: string) => string | null,
  registry: { register(session: LiveSession): void; unregister(sessionId: string): void },
  env: NodeJS.ProcessEnv = process.env,
): AgyHost | null {
  const installed = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : null;
  const bin = env.AGENTCHAINER_AGY_PATH ?? onPath("agy") ?? (installed && existsSync(installed) ? installed : null);
  if (!bin) return null;
  try {
    const version = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true }).trim();
    return { cli: { bin, prefix: [] }, version, ...registry };
  } catch {
    return null;
  }
}
