import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findTool, onPath, toolsDir } from "../bootstrap/tools.ts";
import { type RunResult, runAsync } from "../run-async.ts";

/**
 * Provider CLIs for deploys (M6, docs/design/deploy-and-canvas.md §3): the user's own `vercel`, `wrangler`, …, signed
 * in by them (ADR-0002). They run with an argument array and never through a shell. On Windows, npm installs them as
 * `.cmd` shims, which Node can't spawn without one, so a shim is read and its script run with `node` instead.
 */

export type Cli = { bin: string; prefix: string[] };
/** Runs a CLI in `cwd`; tests pass a stand-in. */
export type RunCli = (args: string[], cwd: string, opts?: { timeoutMs?: number }) => Promise<RunResult>;

/** The script an npm `.cmd` shim runs: `"%dp0%\node_modules\vercel\dist\vc.js" %*`, relative to the shim's folder. */
export function scriptFromNpmShim(text: string, dir: string): string | null {
  const m = /"%~?dp0%?\\([^"]+\.[cm]?js)"/i.exec(text);
  return m?.[1] ? path.win32.join(dir, ...m[1].split("\\")) : null;
}

/** `node` itself, for the shim case: on PATH only (the sidecar's own executable isn't a Node a CLI can run on). */
export const findNodeOrTool = (n: string) => (n === "node" ? onPath("node") : findTool(n, toolsDir()));

/** The CLI `name` as something to spawn: the binary, or `node` plus a shim's script. Null when it isn't installed. */
export function resolveCli(
  name: string,
  find: (n: string) => string | null = findNodeOrTool,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
  exists: (p: string) => boolean = existsSync,
): Cli | null {
  const found = find(name);
  if (!found) return null;
  if (!/\.(cmd|bat)$/i.test(found)) return { bin: found, prefix: [] };
  const script = scriptFromNpmShim(read(found), path.win32.dirname(found));
  const node = find("node");
  return script && node && exists(script) ? { bin: node, prefix: [script] } : null;
}

/**
 * No prompts (there's no terminal to answer), no colours, and the providers' telemetry off: the app's own calls
 * shouldn't report usage on the user's behalf.
 */
const QUIET = {
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  VERCEL_TELEMETRY_DISABLED: "1",
  WRANGLER_SEND_METRICS: "false",
};

export function cliRunner(cli: Cli): RunCli {
  return (args, cwd, opts = {}) =>
    runAsync(cli.bin, [...cli.prefix, ...args], { cwd, env: QUIET, timeoutMs: opts.timeoutMs ?? 120_000 });
}
