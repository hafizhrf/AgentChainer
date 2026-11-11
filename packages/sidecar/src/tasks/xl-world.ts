import { existsSync } from "node:fs";
import type { Task } from "@agentchainer/protocol";
import { runGuarded } from "../bootstrap/verify.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { resolveGates, runGates } from "./gates.ts";
import { untracked } from "./runner.ts";
import {
  addWorktree,
  branchOf,
  codeRootIn,
  commitAll,
  headOf,
  mergeInto,
  removeWorktree,
  tipOf,
  worktreePath,
} from "./worktree.ts";
import { copyIncluded, mainCheckoutOf, setupCommand } from "./worktree-setup.ts";
import type { ChildRun, SetupRun, XlWorld } from "./xl.ts";

/** A dependency install can take a while on a cold cache. */
const SETUP_TIMEOUT_MS = 900_000;

/**
 * Gets a new worktree's code folder ready (CP-04): copies the gitignored files the project names in
 * `.worktreeinclude` from the main checkout, then runs its setup script once the person allowed it, else the
 * detected install command, under the workspace guard so a lockfile it rewrites is put back. Null when there's
 * nothing to copy or run.
 */
export async function setupWorktree(code: string, signal: AbortSignal): Promise<SetupRun | null> {
  const source = mainCheckoutOf(code);
  const copy = source ? copyIncluded(source, code) : { copied: [], capped: false };
  const { command, scriptNotAllowed } = setupCommand(source ?? code, code);
  const extra = {
    ...(copy.copied.length ? { copied: copy.copied } : {}),
    ...(copy.capped ? { copyCapped: true } : {}),
    ...(scriptNotAllowed ? { scriptNotAllowed: true } : {}),
  };
  if (!command) {
    return Object.keys(extra).length
      ? { command: "", exitCode: 0, timedOut: false, durationMs: 0, tail: "", ...extra }
      : null;
  }
  const r = await runGuarded(code, command, code, SETUP_TIMEOUT_MS, {}, signal);
  return { command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.ms, tail: r.tail, ...extra };
}

/**
 * The real world of an XL run (M3-07): worktrees under the workspace's `.agentchainer/worktrees/`, the project's install
 * command in each new one (under the workspace guard, so a lockfile it rewrites is put back), the gates, and git.
 * Sub-tasks are loaded, saved and run by the task service.
 */
export function gitWorld(
  root: string,
  tasks: {
    load: (id: string) => Task;
    save: (task: Task) => void;
    runChild: (child: Task, resume: boolean) => ChildRun;
  },
): XlWorld {
  return {
    worktree(id, from, repo = root) {
      const path = worktreePath(repo, id);
      const branch = branchOf(id);
      addWorktree(repo, path, branch, from);
      return { path, branch, code: codeRootIn(repo, path) };
    },
    codeOf: (path, repo = root) => codeRootIn(repo, path),
    exists: (path) => existsSync(path),
    removeWorktree: (path, repo = root) => removeWorktree(repo, path),
    head: () => headOf(root),
    tip: (branch, repo = root) => tipOf(repo, branch),
    setup: setupWorktree,
    untracked: (code) => untracked(code),
    async gates(code, kinds, round, signal) {
      const commands = resolveGates(code, detectWorkspace(code), kinds);
      const notRun = kinds.filter((k) => !commands.some((c) => c.kind === k));
      return { runs: await runGates(code, commands, round, signal), notRun };
    },
    commit: commitAll,
    merge: mergeInto,
    ...tasks,
  };
}
