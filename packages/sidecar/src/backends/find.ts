import { execFileSync } from "node:child_process";
import type { Cli } from "../deploy/cli.ts";
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
