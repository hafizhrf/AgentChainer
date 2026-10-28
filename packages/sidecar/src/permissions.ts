import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PermissionRuleValue, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

/**
 * "Always allow" rules (M1-17/M1-20). They live in the workspace's `.claude/settings.local.json`, which Claude Code
 * keeps out of git. Only the `permissions` lists are read or written here; any other settings in the file (it can hold
 * `env` values) are preserved and never leave the sidecar.
 */

export type Behavior = "allow" | "ask" | "deny";
type Rules = Record<Behavior, string[]>;

export const localSettingsPath = (cwd: string) => path.join(cwd, ".claude", "settings.local.json");

/** Claude Code's rule syntax: `Tool` or `Tool(content)`, e.g. `Bash(npm test:*)`. */
export const ruleText = (r: PermissionRuleValue) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);

/**
 * What "Always allow" saves, from the CLI's suggestions: allow rules and extra folders, written to the project's local
 * settings. Mode switches are left out, so "always" never changes the session's permission mode behind the user's back.
 */
export function alwaysUpdates(suggestions: PermissionUpdate[] | undefined): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [];
  for (const s of suggestions ?? []) {
    if (s.type === "addRules" && s.behavior === "allow") updates.push({ ...s, destination: "localSettings" });
    if (s.type === "addDirectories") updates.push({ ...s, destination: "localSettings" });
  }
  return updates;
}

/** Human-readable summary of `alwaysUpdates`, shown on the approval prompt. */
export function describeUpdates(updates: PermissionUpdate[]): string[] {
  return updates.flatMap((u) => {
    if (u.type === "addRules") return u.rules.map(ruleText);
    if (u.type === "addDirectories") return u.directories.map((d) => `Access to ${d}`);
    return [];
  });
}

function readSettings(cwd: string): Record<string, unknown> {
  const file = localSettingsPath(cwd);
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object.`);
  return parsed as Record<string, unknown>;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function listRules(cwd: string): Rules {
  const perms = readSettings(cwd).permissions;
  const p = (perms && typeof perms === "object" ? perms : {}) as Record<string, unknown>;
  return { allow: strings(p.allow), ask: strings(p.ask), deny: strings(p.deny) };
}

/** Removes one rule and rewrites the file atomically; everything else in it stays as it was. */
export function removeRule(cwd: string, behavior: Behavior, rule: string): void {
  const settings = readSettings(cwd);
  const perms = settings.permissions as Record<string, unknown> | undefined;
  const list = strings(perms?.[behavior]);
  if (!perms || !list.includes(rule)) throw new Error(`No ${behavior} rule ${rule} in ${localSettingsPath(cwd)}.`);
  perms[behavior] = list.filter((r) => r !== rule);
  const file = localSettingsPath(cwd);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}
