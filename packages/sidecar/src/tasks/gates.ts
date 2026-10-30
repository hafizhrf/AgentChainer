import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { GateKind, GateRun, WorkspaceProfile } from "@agentchainer/protocol";
import { type CommandRun, runCommand, runGuarded, scriptCommand } from "../bootstrap/verify.ts";
import { changedBetween, fingerprint } from "../bootstrap/workspace-guard.ts";

/**
 * Gates (M3-08): the project's own checks, run by the sidecar, never by the model, with real exit codes. They come
 * from the workspace profile's commands, plus the smoke script when there is one. Format runs in write mode and its
 * changes become part of the task; the checks run under the workspace guard, so a check never changes code.
 */

export type GateCommand = { kind: GateKind; command: string; package: string; cwd: string };

const TIMEOUT_MS: Record<GateKind, number> = {
  format: 300_000,
  lint: 600_000,
  typecheck: 600_000,
  test: 900_000,
  build: 900_000,
  smoke: 300_000,
};

/** `scripts/smoke.*`, the script the readiness audit looks for (M2-09). */
export const SMOKE_SCRIPT = /^smoke([-_.][\w.-]*)?\.(sh|ps1|mjs|js|ts|py)$/;

export function smokeCommand(root: string): string | null {
  const dir = path.join(root, "scripts");
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir)
    .sort()
    .find((n) => SMOKE_SCRIPT.test(n));
  return name ? scriptCommand(`scripts/${name}`) : null;
}

/**
 * The commands for `kinds`, in that order. A command the root package has runs once at the root (it usually covers
 * the workspace, e.g. `pnpm -r test`); otherwise each package's own runs in its folder.
 */
export function resolveGates(root: string, profile: WorkspaceProfile, kinds: readonly GateKind[]): GateCommand[] {
  const out: GateCommand[] = [];
  for (const kind of kinds) {
    if (kind === "smoke") {
      const command = smokeCommand(root);
      if (command) out.push({ kind, command, package: ".", cwd: root });
      continue;
    }
    const own = profile.packages.find((p) => p.path === ".")?.commands[kind];
    if (own) {
      out.push({ kind, command: own.run, package: ".", cwd: root });
      continue;
    }
    for (const p of profile.packages) {
      const c = p.commands[kind];
      if (p.path !== "." && c)
        out.push({ kind, command: c.run, package: p.path, cwd: path.join(root, ...p.path.split("/")) });
    }
  }
  return out;
}

const record = (g: GateCommand, r: CommandRun, round: number, changed: string[], now: Date): GateRun => ({
  kind: g.kind,
  command: g.command,
  package: g.package,
  exitCode: r.exitCode,
  timedOut: r.timedOut,
  durationMs: r.ms,
  tail: r.tail,
  round,
  at: now.toISOString(),
  ...(changed.length ? { changed } : {}),
});

/**
 * Runs every gate in order, even after one fails, so a fix round sees all the failures at once. Stops early only
 * when `signal` is aborted.
 */
export async function runGates(
  root: string,
  gates: GateCommand[],
  round: number,
  signal?: AbortSignal,
): Promise<GateRun[]> {
  const runs: GateRun[] = [];
  for (const g of gates) {
    if (signal?.aborted) break;
    if (g.kind === "format") {
      const before = fingerprint(root);
      const r = await runCommand(g.command, g.cwd, TIMEOUT_MS.format, {}, signal);
      runs.push(record(g, r, round, changedBetween(before, fingerprint(root)), new Date()));
    } else {
      const r = await runGuarded(root, g.command, g.cwd, TIMEOUT_MS[g.kind], {}, signal);
      runs.push(record(g, r, round, r.reverted, new Date()));
    }
  }
  return runs;
}

export const passed = (runs: GateRun[]) => runs.every((r) => r.exitCode === 0 && !r.timedOut);
