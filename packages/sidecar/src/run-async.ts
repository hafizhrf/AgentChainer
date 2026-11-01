import { spawn } from "node:child_process";

export type RunResult = { status: number | null; stdout: string; stderr: string };

/**
 * Runs a program without blocking the sidecar's event loop. The UI pings the sidecar every 20 s and restarts it when a
 * ping goes unanswered for 5 s (M1-01), so anything that can take longer, a push or a `gh` call over the network, a
 * scanner, must not use `spawnSync`. On timeout the process is killed and `status` is null.
 */
export function runAsync(
  bin: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; input?: string; timeoutMs?: number; maxBytes?: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const max = opts.maxBytes ?? 64 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      done({ status: null, stdout, stderr: `${stderr}\ntimed out after ${(opts.timeoutMs ?? 60_000) / 1000} s` });
    }, opts.timeoutMs ?? 60_000);
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      if (stdout.length < max) stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < max) stderr += d;
    });
    child.on("error", (err) => done({ status: null, stdout, stderr: `${stderr}${String(err)}` }));
    child.on("close", (code) => done({ status: code, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}
