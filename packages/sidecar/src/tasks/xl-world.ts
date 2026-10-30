import { existsSync } from "node:fs";
import type { Task } from "@agentchainer/protocol";
import { installCommand } from "../bootstrap/plan.ts";
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
import type { ChildRun, XlWorld } from "./xl.ts";

/** A dependency install can take a while on a cold cache. */
const SETUP_TIMEOUT_MS = 900_000;

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
    worktree(id, from) {
      const path = worktreePath(root, id);
      const branch = branchOf(id);
      addWorktree(root, path, branch, from);
      return { path, branch, code: codeRootIn(root, path) };
    },
    codeOf: (path) => codeRootIn(root, path),
    exists: (path) => existsSync(path),
    removeWorktree: (path) => removeWorktree(root, path),
    head: () => headOf(root),
    tip: (branch) => tipOf(root, branch),
    async setup(code, signal) {
      const command = installCommand(detectWorkspace(code));
      if (!command) return null;
      const r = await runGuarded(code, command, code, SETUP_TIMEOUT_MS, {}, signal);
      return { command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.ms, tail: r.tail };
    },
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
