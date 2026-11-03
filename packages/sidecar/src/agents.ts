import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentDefinition,
  type AgentInput,
  type AgentScope,
  agentProblems,
  isAutoAgent,
  withAutoWording,
} from "@agentchainer/protocol";
import { parse, stringify } from "yaml";
import { applyFileEdits } from "./bootstrap/apply.ts";
import shippedLibrary from "./tasks/library.json" with { type: "json" };
import { LibrarySchema } from "./tasks/library.ts";

/**
 * The agent library (M4-06): the subagent definitions in the project's `.claude/agents/` and the user's
 * `~/.claude/agents/`, the format the CLI reads (YAML front matter, then the prompt). Project agents are written as
 * recorded runs that History can roll back; the user's own (M8-04) are written in place, since they aren't the
 * workspace's. Both are checked with `agentProblems` first.
 */

const PROJECT_DIR = ".claude/agents";
const ROLE_NAMES = new Set(Object.values(LibrarySchema.parse(shippedLibrary).roles).map((r) => r.name));

type Parsed = { fields: Record<string, unknown>; prompt: string };

function parseAgentFile(text: string): Parsed {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new Error("It doesn't start with --- front matter ---.");
  const fields = parse(m[1] ?? "") as unknown;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Its front matter isn't a map.");
  return { fields: fields as Record<string, unknown>, prompt: (m[2] ?? "").trim() };
}

function readAgent(file: string, scope: AgentDefinition["scope"], display: string): AgentDefinition {
  const name = path.basename(file, ".md");
  const base = { name, scope, file: display, description: "", prompt: "", auto: false, role: ROLE_NAMES.has(name) };
  try {
    const { fields, prompt } = parseAgentFile(readFileSync(file, "utf8"));
    const { name: own, description, tools, model } = fields;
    if (typeof own !== "string" || !own) throw new Error("It has no name.");
    if (typeof description !== "string" || !description) throw new Error("It has no description.");
    return {
      ...base,
      name: own,
      role: ROLE_NAMES.has(own),
      description,
      ...(typeof tools === "string" ? { tools } : Array.isArray(tools) ? { tools: tools.join(", ") } : {}),
      ...(typeof model === "string" ? { model } : {}),
      prompt,
      auto: isAutoAgent(description),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

function listDir(dir: string, scope: AgentDefinition["scope"], display: (file: string) => string): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readAgent(path.join(dir, f), scope, display(f)));
}

/** The project's agents, then the user's (`configDir` is the CLI's `~/.claude`). */
export function listAgents(root: string, configDir: string): AgentDefinition[] {
  return [
    ...listDir(path.join(root, ...PROJECT_DIR.split("/")), "project", (f) => `${PROJECT_DIR}/${f}`),
    ...listDir(path.join(configDir, "agents"), "user", (f) => `~/.claude/agents/${f}`),
  ];
}

/** The agent's file text. Front matter fields the app doesn't edit (`color`, `mcpServers`, …) are kept from `keep`. */
export function renderAgent(agent: AgentInput, keep: Record<string, unknown> = {}): string {
  const { name: _n, description: _d, tools: _t, model: _m, ...rest } = keep;
  const fields = {
    name: agent.name,
    description: withAutoWording(agent.description, agent.auto),
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(agent.model ? { model: agent.model } : {}),
    ...rest,
  };
  return `---\n${stringify(fields, { lineWidth: 0 }).trimEnd()}\n---\n\n${agent.prompt.trim()}\n`;
}

const fileOf = (name: string) => `${PROJECT_DIR}/${name}.md`;

/** The other agents' names in a folder of agents, which a new or renamed one can't take. */
function namesIn(dir: string, except?: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .filter((n) => n !== except);
}

function refuseProblems(agent: AgentInput, taken: string[]): void {
  const problems = agentProblems(agent, taken);
  if (problems.length) throw new Error(problems.join(" "));
}

/**
 * Creates or edits (and with `previousName`, renames) an agent. A project agent's change is a run, whose id is
 * returned; a user agent (`configDir` is the CLI's `~/.claude`) is written in place, with no run.
 */
export function saveAgent(
  root: string,
  configDir: string,
  agent: AgentInput,
  catalogVersion: string,
  previousName?: string,
  now = new Date(),
): string | undefined {
  if (agent.scope === "user") return saveUserAgent(path.join(configDir, "agents"), agent, previousName);
  refuseProblems(agent, namesIn(path.join(root, ...PROJECT_DIR.split("/")), previousName ?? agent.name));
  const from = previousName ?? agent.name;
  const target = path.join(root, ...fileOf(agent.name).split("/"));
  const source = path.join(root, ...fileOf(from).split("/"));
  if (from !== agent.name && existsSync(target)) throw new Error(`An agent named ${agent.name} already exists.`);
  if (previousName === undefined && existsSync(target)) throw new Error(`An agent named ${agent.name} already exists.`);
  let keep: Record<string, unknown> = {};
  if (previousName !== undefined) {
    if (!existsSync(source)) throw new Error(`There is no project agent named ${previousName}.`);
    try {
      keep = parseAgentFile(readFileSync(source, "utf8")).fields;
    } catch {
      // An unreadable file is replaced by the form's fields.
    }
  }
  const edits: { path: string; content: string | null }[] = [
    { path: fileOf(agent.name), content: renderAgent(agent, keep) },
  ];
  if (from !== agent.name) edits.push({ path: fileOf(from), content: null });
  const verb = previousName === undefined ? "Create" : from !== agent.name ? "Rename" : "Edit";
  return applyFileEdits(
    root,
    { id: `agent:${agent.name}`, title: `${verb} agent ${agent.name}` },
    edits,
    catalogVersion,
    now,
  );
}

/** A user agent, written through a temporary file so a failed write never leaves half a file. */
function saveUserAgent(dir: string, agent: AgentInput, previousName?: string): undefined {
  refuseProblems(agent, namesIn(dir, previousName ?? agent.name));
  const target = path.join(dir, `${agent.name}.md`);
  const source = path.join(dir, `${previousName ?? agent.name}.md`);
  if (previousName === undefined && existsSync(target)) throw new Error(`An agent named ${agent.name} already exists.`);
  let keep: Record<string, unknown> = {};
  if (previousName !== undefined) {
    if (!existsSync(source)) throw new Error(`There is no user agent named ${previousName}.`);
    try {
      keep = parseAgentFile(readFileSync(source, "utf8")).fields;
    } catch {
      // An unreadable file is replaced by the form's fields.
    }
  }
  mkdirSync(dir, { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, renderAgent(agent, keep));
  renameSync(temp, target);
  if (source !== target) rmSync(source, { force: true });
  return undefined;
}

export function deleteAgent(
  root: string,
  configDir: string,
  name: string,
  scope: AgentScope,
  catalogVersion: string,
  now = new Date(),
): string | undefined {
  if (scope === "user") {
    const file = path.join(configDir, "agents", `${name}.md`);
    if (!existsSync(file)) throw new Error(`There is no user agent named ${name}.`);
    rmSync(file);
    return undefined;
  }
  if (!existsSync(path.join(root, ...fileOf(name).split("/"))))
    throw new Error(`There is no project agent named ${name}.`);
  return applyFileEdits(
    root,
    { id: `agent:${name}`, title: `Delete agent ${name}` },
    [{ path: fileOf(name), content: null }],
    catalogVersion,
    now,
  );
}
