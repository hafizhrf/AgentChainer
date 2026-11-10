import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AgentRoles, AgentRolesSchema } from "@agentchainer/protocol";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { refuseLinks } from "../workspace-files.ts";

/**
 * A workspace's default agent per role (M9-06, ADR-0012 §5): which agent plans, implements and reviews when a task
 * doesn't choose. Kept in `.agentchainer/agents.json`, out of git: each computer has its own CLIs installed.
 */
const FILE = "agents.json";

export function readDefaults(root: string): AgentRoles {
  const file = path.join(root, AC_DIR, FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = AgentRolesSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeDefaults(root: string, agents: AgentRoles): AgentRoles {
  const clean = AgentRolesSchema.parse(
    Object.fromEntries(Object.entries(agents).filter(([, a]) => a !== undefined && a !== "claude")),
  );
  ensureIgnored(root, FILE);
  refuseLinks(root, `${AC_DIR}/${FILE}`);
  writeFileSync(path.join(root, AC_DIR, FILE), `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}
