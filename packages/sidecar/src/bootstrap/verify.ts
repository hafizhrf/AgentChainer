import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { detectWorkspace } from "../detect/detect.ts";
import { t } from "../i18n/index.ts";
import type { Check } from "./generate.ts";
import { STOP_SCRIPT } from "./stop-hook.ts";
import { guarded } from "./workspace-guard.ts";

/**
 * The verifier (M2-26): after generated files are applied, runs the command that proves they work, with a timeout,
 * and keeps the exit code and the end of the log. It never rolls back on its own; the report says what failed.
 */

const TAIL_LINES = 40;

export type CommandRun = { command: string; exitCode: number | null; timedOut: boolean; tail: string; ms: number };

/**
 * Stops a command and everything it started. Killing only the shell isn't enough: Linux's `sh` (dash) and Windows'
 * `cmd` run the command as a child, which would keep running and hold the output open.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Runs a project command through the shell (commands come from the project's own manifests) without blocking.
 * `signal` stops it early, like the timeout does.
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<CommandRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // Its own process group on POSIX, so stopping it can take its children too (see killTree).
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", ...env },
    });
    let out = "";
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString("utf8")).slice(-20_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const stop = () => killTree(child);
    signal?.addEventListener("abort", stop);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({
        command,
        exitCode,
        timedOut,
        tail: out.split("\n").slice(-TAIL_LINES).join("\n").trim(),
        ms: Date.now() - started,
      });
    };
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
}

/** Runs a verification command; whatever it changes in the workspace (lockfiles, snapshots) is reverted. */
export async function runGuarded(
  root: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<CommandRun & { reverted: string[] }> {
  const { result, reverted } = await guarded(root, () => runCommand(command, cwd, timeoutMs, env, signal));
  return reverted.length
    ? { ...result, tail: `${result.tail}\n(reverted changes the command made to ${reverted.join(", ")})`, reverted }
    : { ...result, reverted };
}

/** How a project script runs, by its extension: `scripts/smoke.mjs` → `node scripts/smoke.mjs`. */
export function scriptCommand(script: string): string {
  const ext = path.extname(script);
  if (ext === ".mjs" || ext === ".js" || ext === ".ts") return `node ${script}`;
  if (ext === ".py") return `python3 ${script}`;
  if (ext === ".ps1") return `powershell -NoProfile -File ${script}`;
  return `sh ${script}`;
}

/** How a command ended, in words: timed out, or its exit code and time (and its output when it failed). */
function commandDetail(r: CommandRun): string {
  const values = { command: r.command, code: String(r.exitCode), seconds: (r.ms / 1000).toFixed(1) };
  if (r.timedOut) return t("bootstrap.verify.timedOut", { command: r.command, seconds: Math.round(r.ms / 1000) });
  return r.exitCode === 0
    ? t("bootstrap.verify.exited", values)
    : t("bootstrap.verify.exitedWithOutput", { ...values, output: r.tail });
}

const asCheck = (name: string, r: CommandRun): Check => ({
  name,
  status: r.exitCode === 0 ? "pass" : "fail",
  detail: commandDetail(r),
});

/** Post-apply checks per generator: tests run, smoke scripts run, others were checked before applying. */
export async function verifyApplied(root: string, action: string, files: string[]): Promise<Check[]> {
  if (action === "scaffold-tests") {
    // Re-detect: the scaffold just added the test command.
    const pkg = detectWorkspace(root).packages.find((p) => p.commands.test);
    if (!pkg?.commands.test)
      return [{ name: t("bootstrap.verify.testCommand"), status: "fail", detail: t("bootstrap.verify.noTestCommand") }];
    const r = await runGuarded(
      root,
      pkg.commands.test.run,
      path.join(root, ...pkg.path.split("/").filter((p) => p !== ".")),
      300_000,
    );
    const check = asCheck(t("bootstrap.verify.testsRun"), r);
    if (check.status === "fail" && /not found|cannot find|ENOENT|No module named/i.test(r.tail)) {
      check.detail += `\n${t("bootstrap.verify.runnerMissing")}`;
    }
    return [check];
  }
  if (action === "smoke-test") {
    const script = files.find((f) => f.startsWith("scripts/smoke."));
    if (!script || !existsSync(path.join(root, ...script.split("/")))) {
      return [{ name: t("bootstrap.verify.smokeScript"), status: "fail", detail: t("bootstrap.verify.noSmokeScript") }];
    }
    return [asCheck(t("bootstrap.verify.smokeRuns"), await runGuarded(root, scriptCommand(script), root, 120_000))];
  }
  if (action === "stop-tests") {
    // Run the hook as Claude Code would (no hook input on stdin): exit 0 when tests pass, 2 when they fail.
    const r = await runGuarded(root, `sh ${STOP_SCRIPT}`, root, 300_000, { CLAUDE_PROJECT_DIR: root });
    const seconds = (r.ms / 1000).toFixed(1);
    if (r.timedOut || (r.exitCode !== 0 && r.exitCode !== 2)) return [asCheck(t("bootstrap.verify.stopHookRuns"), r)];
    return [
      {
        name: t("bootstrap.verify.stopHookRuns"),
        status: "pass",
        detail:
          r.exitCode === 0
            ? t("bootstrap.verify.testsPass", { seconds })
            : t("bootstrap.verify.hookWorksTestsFail", { seconds }),
      },
      ...(r.ms > 60_000
        ? [
            {
              name: t("bootstrap.verify.stopHookSpeed"),
              status: "fail" as const,
              detail: t("bootstrap.verify.slowTests", { seconds }),
            },
          ]
        : []),
    ];
  }
  return [];
}
