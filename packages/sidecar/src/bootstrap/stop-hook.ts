import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { WorkspaceProfile } from "@agentchainer/protocol";
import type { HookFile } from "./git-hooks.ts";

/**
 * The optional Stop hook (M2-22): when Claude finishes a turn, the project's tests run, and failures go back to Claude
 * (exit code 2) so it fixes them before stopping. Built from the detected test command, without a model call.
 * Claude Code sets `stop_hook_active` when it's already continuing because of a Stop hook; the script stops there, so
 * it can't loop.
 */

export const STOP_SCRIPT = ".claude/hooks/stop-tests.sh";
const SETTINGS = ".claude/settings.json";
export const STOP_COMMAND = `sh "$CLAUDE_PROJECT_DIR"/${STOP_SCRIPT}`;

export type StopTarget = { dir: string; run: string };

/** The package whose tests the hook runs: the first one with a test command. */
export function stopTestTarget(profile: WorkspaceProfile): StopTarget | null {
  const pkg = profile.packages.find((p) => p.commands.test);
  return pkg?.commands.test ? { dir: pkg.path, run: pkg.commands.test.run } : null;
}

const shQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'"'"'`)}'`);

export function stopHookScript(target: StopTarget): string {
  const project = `"\${CLAUDE_PROJECT_DIR:-.}"`;
  const cd = target.dir === "." ? project : `${project}/${shQuote(target.dir)}`;
  return `#!/bin/sh
# Added by AgentChainer: runs the tests when Claude finishes a turn, and sends failures back so Claude fixes them.
input=$(cat)
# Claude is already continuing because of this hook: stop here instead of looping.
case "$input" in *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;; esac
cd ${cd} || exit 0
export CI=1
if out=$(${target.run} 2>&1); then exit 0; fi
echo ${shQuote(`The tests fail (${target.run}). Fix them before finishing:`)} >&2
printf '%s\\n' "$out" | tail -n 40 >&2
exit 2
`;
}

/**
 * The files the fix writes: the script, and one more `Stop` entry in `.claude/settings.json` (existing hooks and
 * settings stay). Null when the settings file isn't valid JSON or already runs the script.
 */
export function stopHookFiles(root: string, target: StopTarget): HookFile[] | null {
  const read = (rel: string) => {
    const file = path.join(root, ...rel.split("/"));
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const before = read(SETTINGS);
  let settings: Record<string, unknown> = {};
  if (before.trim()) {
    try {
      const parsed: unknown = JSON.parse(before);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      settings = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (before.includes(STOP_SCRIPT)) return null;
  const hooks = { ...((settings.hooks ?? {}) as Record<string, unknown>) };
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  hooks.Stop = [...stop, { hooks: [{ type: "command", command: STOP_COMMAND, timeout: 300 }] }];
  return [
    { path: SETTINGS, before, after: `${JSON.stringify({ ...settings, hooks }, null, 2)}\n` },
    { path: STOP_SCRIPT, before: read(STOP_SCRIPT), after: stopHookScript(target), executable: true },
  ];
}
