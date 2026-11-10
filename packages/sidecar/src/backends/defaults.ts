import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentRoles,
  AgentRolesSchema,
  type TaskDefaults,
  TaskDefaultsSchema,
  type TaskDefaultsView,
} from "@agentchainer/protocol";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { refuseLinks } from "../workspace-files.ts";

/**
 * How a workspace's tasks run unless a task chooses (owner request, 2026-11-10; M9-06 for the agents): the agent per
 * role, the model, the permission profile and the budget per tier. Two levels:
 * - **the app's**, from Settings, sent by the UI (`app.setDefaults`) and held here for scheduled runs too;
 * - **the workspace's**, in `.agentchainer/defaults.json`, out of git: each computer has its own CLIs and limits.
 *   A workspace from before reads its agents from `agents.json` until it saves.
 * A workspace's value wins over the app's, field by field; each falls back to the built-in one.
 */
const FILE = "defaults.json";
const LEGACY = "agents.json";

let app: TaskDefaults = {};

export function setAppDefaults(defaults: TaskDefaults): void {
  app = TaskDefaultsSchema.parse(defaults);
}

export function appDefaults(): TaskDefaults {
  return app;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The workspace's own defaults; a broken or hand-edited file reads as none. */
export function readWorkspaceDefaults(root: string): TaskDefaults {
  const file = path.join(root, AC_DIR, FILE);
  if (existsSync(file)) {
    const parsed = TaskDefaultsSchema.safeParse(readJson(file));
    return parsed.success ? parsed.data : {};
  }
  const legacy = path.join(root, AC_DIR, LEGACY);
  if (!existsSync(legacy)) return {};
  const agents = AgentRolesSchema.safeParse(readJson(legacy));
  return agents.success && Object.keys(agents.data).length ? { agents: agents.data } : {};
}

/** Replaces the workspace's own defaults; empty fields are dropped, so `{}` follows the app's. */
export function writeWorkspaceDefaults(root: string, defaults: TaskDefaults): TaskDefaults {
  const parsed = TaskDefaultsSchema.parse(defaults);
  const clean: TaskDefaults = {
    ...(parsed.agents && Object.keys(parsed.agents).length ? { agents: parsed.agents } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
    ...(parsed.budgetUsd && Object.keys(parsed.budgetUsd).length ? { budgetUsd: parsed.budgetUsd } : {}),
  };
  ensureIgnored(root, FILE);
  refuseLinks(root, `${AC_DIR}/${FILE}`);
  writeFileSync(path.join(root, AC_DIR, FILE), `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

/** The workspace's value over the app's, field by field (agents and budgets per role and tier). */
export function mergeDefaults(appLevel: TaskDefaults, workspace: TaskDefaults): TaskDefaults {
  const agents = { ...appLevel.agents, ...workspace.agents };
  const budgetUsd = { ...appLevel.budgetUsd, ...workspace.budgetUsd };
  const model = workspace.model ?? appLevel.model;
  const permissionMode = workspace.permissionMode ?? appLevel.permissionMode;
  return {
    ...(Object.keys(agents).length ? { agents } : {}),
    ...(model ? { model } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(Object.keys(budgetUsd).length ? { budgetUsd } : {}),
  };
}

export function defaultsView(root: string): TaskDefaultsView {
  const workspace = readWorkspaceDefaults(root);
  return { app, workspace, effective: mergeDefaults(app, workspace) };
}

/** The agent per role a task starts from: the workspace's, then the app's (step and task choices come on top). */
export function readDefaults(root: string): AgentRoles {
  return mergeDefaults(app, readWorkspaceDefaults(root)).agents ?? {};
}

/** The workspace's own agents (the triage card's older call); keeps its other defaults. */
export function writeDefaults(root: string, agents: AgentRoles): AgentRoles {
  const current = readWorkspaceDefaults(root);
  return writeWorkspaceDefaults(root, { ...current, agents: AgentRolesSchema.parse(agents) }).agents ?? {};
}

/** A tier's budget: the workspace's, then the app's, then the built-in one. `null` is "no budget". */
export function budgetFor(root: string, tier: "S" | "M" | "L" | "XL", builtIn: number): number | null {
  const b = mergeDefaults(app, readWorkspaceDefaults(root)).budgetUsd?.[tier];
  return b === undefined ? builtIn : b;
}
