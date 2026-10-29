import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { detectWorkspace } from "../detect/detect.ts";
import type { Check } from "./generate.ts";
import { STOP_SCRIPT } from "./stop-hook.ts";
import { guarded } from "./workspace-guard.ts";

/**
 * The verifier (M2-26): after generated files are applied, runs the command that proves they work, with a timeout,
 * and keeps the exit code and the end of the log. It never rolls back on its own; the report says what failed.
 */

const TAIL_LINES = 40;

export type CommandRun = { command: string; exitCode: number | null; timedOut: boolean; tail: string; ms: number };

/** Runs a project command through the shell (commands come from the project's own manifests) without blocking. */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<CommandRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
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
      child.kill("SIGKILL");
    }, timeoutMs);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
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
async function runGuarded(
  root: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> = {},
): Promise<CommandRun> {
  const { result, reverted } = await guarded(root, () => runCommand(command, cwd, timeoutMs, env));
  return reverted.length
    ? { ...result, tail: `${result.tail}\n(reverted changes the command made to ${reverted.join(", ")})` }
    : result;
}

const asCheck = (name: string, r: CommandRun): Check => ({
  name,
  status: r.exitCode === 0 ? "pass" : "fail",
  detail: r.timedOut
    ? `\`${r.command}\` timed out after ${Math.round(r.ms / 1000)} s`
    : `\`${r.command}\` exited ${r.exitCode} in ${(r.ms / 1000).toFixed(1)} s${r.exitCode === 0 ? "" : `:\n${r.tail}`}`,
});

/** Post-apply checks per generator: tests run, smoke scripts run, others were checked before applying. */
export async function verifyApplied(root: string, action: string, files: string[]): Promise<Check[]> {
  if (action === "scaffold-tests") {
    // Re-detect: the scaffold just added the test command.
    const pkg = detectWorkspace(root).packages.find((p) => p.commands.test);
    if (!pkg?.commands.test)
      return [{ name: "test command", status: "fail", detail: "no test command detected after applying" }];
    const r = await runGuarded(
      root,
      pkg.commands.test.run,
      path.join(root, ...pkg.path.split("/").filter((p) => p !== ".")),
      300_000,
    );
    const check = asCheck("tests run", r);
    if (check.status === "fail" && /not found|cannot find|ENOENT|No module named/i.test(r.tail)) {
      check.detail += "\nThe runner may not be installed yet: run the project's install command, then the tests.";
    }
    return [check];
  }
  if (action === "smoke-test") {
    const script = files.find((f) => f.startsWith("scripts/smoke."));
    if (!script || !existsSync(path.join(root, ...script.split("/")))) {
      return [{ name: "smoke script", status: "fail", detail: "no scripts/smoke.* was written" }];
    }
    const ext = path.extname(script);
    const command =
      ext === ".mjs" || ext === ".js"
        ? `node ${script}`
        : ext === ".py"
          ? `python3 ${script}`
          : ext === ".ps1"
            ? `powershell -NoProfile -File ${script}`
            : `sh ${script}`;
    return [asCheck("smoke test runs", await runGuarded(root, command, root, 120_000))];
  }
  if (action === "stop-tests") {
    // Run the hook as Claude Code would (no hook input on stdin): exit 0 when tests pass, 2 when they fail.
    const r = await runGuarded(root, `sh ${STOP_SCRIPT}`, root, 300_000, { CLAUDE_PROJECT_DIR: root });
    const seconds = (r.ms / 1000).toFixed(1);
    if (r.timedOut || (r.exitCode !== 0 && r.exitCode !== 2)) return [asCheck("stop hook runs", r)];
    return [
      {
        name: "stop hook runs",
        status: "pass",
        detail:
          r.exitCode === 0
            ? `the tests pass (${seconds} s)`
            : `the hook works; the tests fail now (${seconds} s), so Claude will be asked to fix them when it stops`,
      },
      ...(r.ms > 60_000
        ? [
            {
              name: "stop hook speed",
              status: "fail" as const,
              detail: `the tests take ${seconds} s, which every turn will wait for; consider a faster test command`,
            },
          ]
        : []),
    ];
  }
  return [];
}
