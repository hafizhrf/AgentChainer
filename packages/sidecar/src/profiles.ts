import { type AgentDefinition, agentProblems, MCP_TOOL_ENTRY, toolList } from "@agentchainer/protocol";
import { listAgents } from "./agents.ts";
import { READ_TOOLS } from "./guard.ts";

/**
 * Running an agent profile (M8-04, docs/design/agent-profiles.md): a project or user agent's prompt, model and tools
 * applied to a session the app starts, a chat or a Team's worker. Its tools narrow what the session has; approvals and
 * the guard still apply to them.
 */

export type Profile = Pick<AgentDefinition, "name" | "description" | "scope" | "prompt"> & {
  /** Null: the profile lists none, so it has every tool. */
  tools: string[] | null;
  model?: string;
};

/** Tools a chat keeps whatever its profile lists: they only ask the person or narrow what Claude may do. */
export const CHAT_TOOLS = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TodoWrite"];

/** A project agent of that name wins over the user's own. Refuses an unreadable profile or one with problems. */
export function loadProfile(root: string, configDir: string, name: string): Profile {
  const agents = listAgents(root, configDir);
  const agent = agents.find((a) => a.name === name && a.scope === "project") ?? agents.find((a) => a.name === name);
  if (!agent) throw new Error(`There is no agent profile named ${name}.`);
  if (agent.error) throw new Error(`The agent profile ${name} can't be read: ${agent.error}`);
  const problems = agentProblems(agent);
  if (problems.length) throw new Error(`The agent profile ${name} needs fixing first: ${problems.join(" ")}`);
  const tools = toolList(agent.tools);
  return {
    name: agent.name,
    description: agent.description,
    scope: agent.scope,
    prompt: agent.prompt,
    tools: tools.length ? tools : null,
    ...(agent.model && agent.model !== "inherit" ? { model: agent.model } : {}),
  };
}

/** Every readable profile with no problems, by name, for the Team's instructions. */
export function profileSummaries(root: string, configDir: string): { name: string; description: string }[] {
  const seen = new Set<string>();
  return listAgents(root, configDir)
    .filter((a) => !a.error && agentProblems(a).length === 0)
    .filter((a) => !seen.has(a.name) && seen.add(a.name))
    .map((a) => ({ name: a.name, description: a.description }));
}

export type ProfileOptions = {
  appendSystemPrompt: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
};

/**
 * The session options a profile gives. `extraTools` are always kept (a chat's question and plan tools);
 * `keepMcp` keeps every MCP tool (a Team chat's own tools are MCP). A `readOnly` session keeps only the profile's read
 * tools, or all of them when it lists none.
 */
export function profileOptions(
  profile: Profile,
  {
    readOnly = false,
    extraTools = [],
    keepMcp = false,
  }: { readOnly?: boolean; extraTools?: string[]; keepMcp?: boolean } = {},
): ProfileOptions {
  const base = { appendSystemPrompt: profile.prompt, ...(profile.model ? { model: profile.model } : {}) };
  if (readOnly) {
    const read = (profile.tools ?? READ_TOOLS).filter((t) => READ_TOOLS.includes(t));
    return { ...base, tools: read.length ? read : [...READ_TOOLS] };
  }
  if (!profile.tools) return base;
  const mcp = profile.tools.filter((t) => MCP_TOOL_ENTRY.test(t));
  const builtIn = profile.tools.filter((t) => !MCP_TOOL_ENTRY.test(t));
  return {
    ...base,
    tools: [...new Set([...builtIn, ...extraTools])],
    // A profile that names no MCP server gets none; one that names some keeps the servers the session has.
    ...(mcp.length === 0 && !keepMcp ? { disallowedTools: ["mcp__*"] } : {}),
  };
}
