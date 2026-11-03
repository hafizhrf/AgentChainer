import {
  type AgentDefinition,
  type AgentInput,
  type AgentScope,
  type AgentTemplate,
  agentProblems,
  isAutoAgent,
  KNOWN_TOOLS,
  toolList,
} from "@agentchainer/protocol";

/**
 * The agent form's state (M4-06, M8-04): its fields, where it's saved, and whether its tools are limited. Whether the
 * agent is auto is read from the description's wording.
 */
export type Draft = {
  /** The file name it's saved under now; unset for a new agent. */
  previous?: string;
  scope: AgentScope;
  name: string;
  description: string;
  /** Only the listed tools; off means every tool, as the CLI does with no `tools` field. */
  limited: boolean;
  tools: string;
  model: string;
  prompt: string;
};

export const blankDraft = (scope: AgentScope = "project"): Draft => ({
  scope,
  name: "",
  description: "",
  limited: false,
  tools: "",
  model: "",
  prompt: "",
});

const fileName = (a: AgentDefinition) => a.file.split("/").pop()?.replace(/\.md$/, "") ?? a.name;

export const draftOf = (a: AgentDefinition): Draft => ({
  previous: fileName(a),
  scope: a.scope,
  name: a.name,
  description: a.description,
  limited: toolList(a.tools).length > 0,
  tools: a.tools ?? "",
  model: a.model ?? "",
  prompt: a.prompt,
});

/** `name-copy`, then `name-copy-2`, …: the first name nobody in `taken` has. */
export function freeName(base: string, taken: readonly string[]): string {
  const stem = base.slice(0, 58);
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${stem}-copy` : `${stem}-copy-${i}`;
    if (!taken.includes(name)) return name;
  }
}

/** A clone: the same fields under a free name, in the same scope, saved as a new agent. */
export function cloneDraft(a: AgentDefinition, taken: readonly string[]): Draft {
  const { previous: _p, ...rest } = draftOf(a);
  return { ...rest, name: freeName(a.name, taken) };
}

/**
 * A new agent from a template. A shipped role's copy gets a free `-copy` name, so it never shadows the role the setup
 * plan installs; a starter keeps its own name unless it's taken.
 */
export function templateDraft(t: AgentTemplate, scope: AgentScope, taken: readonly string[]): Draft {
  const name = t.source === "role" || taken.includes(t.name) ? freeName(t.name, taken) : t.name;
  return {
    scope,
    name,
    description: t.description,
    limited: toolList(t.tools).length > 0,
    tools: t.tools ?? "",
    model: t.model ?? "",
    prompt: t.prompt,
  };
}

/** What the form sends to `agents.save`. */
export function inputOf(d: Draft): AgentInput {
  const tools = toolList(d.tools).join(", ");
  return {
    name: d.name.trim(),
    description: d.description,
    prompt: d.prompt,
    auto: isAutoAgent(d.description),
    scope: d.scope,
    ...(d.limited && tools ? { tools } : {}),
    ...(d.model ? { model: d.model } : {}),
  };
}

/** The form's problems, live: the shared checks, plus a limited tool list that lists nothing. */
export function draftProblems(d: Draft, taken: readonly string[]): string[] {
  const problems = agentProblems({ ...inputOf(d), ...(d.limited ? { tools: d.tools } : {}) }, taken);
  if (d.limited && toolList(d.tools).length === 0) problems.push("Tools: pick at least one, or allow all tools.");
  return problems;
}

const BUILT_IN = Object.values(KNOWN_TOOLS).flat() as string[];

/** Ticks or unticks a built-in tool, keeping the picker's order and every other entry (MCP, unknown) after it. */
export function toggleTool(tools: string, tool: string, on: boolean): string {
  const list = toolList(tools);
  const set = new Set(list.filter((t) => BUILT_IN.includes(t)));
  if (on) set.add(tool);
  else set.delete(tool);
  const others = list.filter((t) => !BUILT_IN.includes(t));
  return [...BUILT_IN.filter((t) => set.has(t)), ...others].join(", ");
}

/** The entries the checkboxes don't show (MCP entries, or names the checks will flag), as a comma list. */
export const otherTools = (tools: string) =>
  toolList(tools)
    .filter((t) => !BUILT_IN.includes(t))
    .join(", ");

/** Replaces the other entries, keeping the ticked built-in tools. */
export function withOtherTools(tools: string, others: string): string {
  const built = toolList(tools).filter((t) => BUILT_IN.includes(t));
  return [...built, ...toolList(others)].join(", ");
}
