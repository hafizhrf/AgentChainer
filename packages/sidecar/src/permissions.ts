import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AlwaysScope, RuleScope } from "@agentchainer/protocol";
import type { PermissionRuleValue, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { t } from "./i18n/index.ts";

/**
 * "Always allow" rules (M1-17/M1-20, UX-05). They live in the workspace's `.claude/settings.local.json`, which Claude
 * Code keeps out of git (just this user), or in its `.claude/settings.json`, which is committed (the whole team). Only
 * the `permissions` lists are read or written here; any other settings in the files (they can hold `env` values) are
 * preserved and never leave the sidecar.
 */

export type Behavior = "allow" | "ask" | "deny";
type Rules = Record<Behavior, string[]>;

export const localSettingsPath = (cwd: string) => path.join(cwd, ".claude", "settings.local.json");
export const teamSettingsPath = (cwd: string) => path.join(cwd, ".claude", "settings.json");
/** The CLI's config folder, which every project reads: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeConfigDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
/** The CLI's user settings, which every project reads (ADR-0013). */
export const userSettingsPath = (env: NodeJS.ProcessEnv = process.env) =>
  path.join(claudeConfigDir(env), "settings.json");
const settingsPath = (cwd: string, scope: RuleScope) =>
  scope === "user" ? userSettingsPath() : scope === "team" ? teamSettingsPath(cwd) : localSettingsPath(cwd);

const DESTINATION = { session: "session", workspace: "localSettings", team: "projectSettings" } as const;

/** Saves the "Always allow" updates where the user chose (UX-05): the session, or one of the workspace's rule files. */
export const retarget = (updates: PermissionUpdate[], scope: AlwaysScope): PermissionUpdate[] =>
  updates.map((u) => ({ ...u, destination: DESTINATION[scope] }));

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
    if (u.type === "addDirectories") return u.directories.map((d) => t("rpc.permissions.accessTo", { path: d }));
    return [];
  });
}

function readSettings(cwd: string, scope: RuleScope): Record<string, unknown> {
  const file = settingsPath(cwd, scope);
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t("rpc.permissions.notAnObject", { file }));
  }
  return parsed as Record<string, unknown>;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function listRules(cwd: string, scope: RuleScope = "workspace"): Rules {
  const perms = readSettings(cwd, scope).permissions;
  const p = (perms && typeof perms === "object" ? perms : {}) as Record<string, unknown>;
  return { allow: strings(p.allow), ask: strings(p.ask), deny: strings(p.deny) };
}

/** Removes one rule and rewrites the file atomically; everything else in it stays as it was. */
export function removeRule(cwd: string, behavior: Behavior, rule: string, scope: RuleScope = "workspace"): void {
  const settings = readSettings(cwd, scope);
  const perms = settings.permissions as Record<string, unknown> | undefined;
  const list = strings(perms?.[behavior]);
  const file = settingsPath(cwd, scope);
  if (!perms || !list.includes(rule)) throw new Error(t("rpc.permissions.noRule", { behavior, rule, file }));
  perms[behavior] = list.filter((r) => r !== rule);
  writeSettings(file, settings);
}

/**
 * Adds one rule, once (UX-19); everything else in the file stays as it was. A rule in another list stays there too:
 * Claude Code applies deny first, then ask, then allow.
 */
export function addRule(cwd: string, behavior: Behavior, rule: string, scope: RuleScope): void {
  const settings = readSettings(cwd, scope);
  const current = settings.permissions;
  const perms = (current && typeof current === "object" && !Array.isArray(current) ? current : {}) as Record<
    string,
    unknown
  >;
  const list = strings(perms[behavior]);
  if (list.includes(rule)) return;
  perms[behavior] = [...list, rule];
  settings.permissions = perms;
  writeSettings(settingsPath(cwd, scope), settings);
}

/**
 * Writes a settings file atomically. The user settings file may be a link (dotfiles kept elsewhere): it's written
 * where it points, so the link stays a link. A workspace's own `.claude` files aren't written through links (T-03).
 */
function writeSettings(file: string, settings: Record<string, unknown>): void {
  let target = file;
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    if (file !== userSettingsPath()) throw new Error(t("rpc.permissions.linked", { file }));
    target = realpathSync(file);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, target);
}
