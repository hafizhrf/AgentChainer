import type { AgentTemplate } from "@agentchainer/protocol";
import shippedLibrary from "./tasks/library.json" with { type: "json" };
import { LibrarySchema } from "./tasks/library.ts";

/**
 * Starting points for a new agent profile (M8-04): the shipped task roles (`agents/ac-*.md`, M3-05) and a few starters
 * for common jobs. The form fills in from one; nothing is written until the person saves.
 */

const STARTERS: Omit<AgentTemplate, "id" | "source">[] = [
  {
    name: "researcher",
    description: "Answers questions about the codebase and the libraries it uses, citing files and sources.",
    tools: "Read, Grep, Glob, WebFetch, WebSearch",
    model: "inherit",
    prompt:
      "You research questions about this codebase. Read the relevant code before answering, and look up library " +
      "documentation on the web when the code alone doesn't settle it. Cite file paths with line numbers and link " +
      "the pages you used. Don't change any files. Say plainly when something is uncertain.",
  },
  {
    name: "test-writer",
    description: "Writes and runs tests for code that has none, following the project's test conventions.",
    tools: "Read, Grep, Glob, Edit, Write, Bash",
    model: "inherit",
    prompt:
      "You write tests. First find how this project tests code (framework, file layout, helpers) and follow it. " +
      "Cover the behaviour that matters, including edge cases and failures, without testing implementation details. " +
      "Run the tests you wrote and fix them until they pass. Don't change the code under test; report bugs you find.",
  },
  {
    name: "docs-writer",
    description: "Writes and updates documentation: READMEs, guides and comments, matching the project's style.",
    tools: "Read, Grep, Glob, Edit, Write",
    model: "inherit",
    prompt:
      "You write documentation. Read the code and the existing docs first, and match their tone, structure and " +
      "terms. Explain what a reader needs to use or change the code, with short examples. Keep it accurate: check " +
      "every command, path and option against the code. Don't change code.",
  },
  {
    name: "explainer",
    description: "Explains how a part of the code works, read-only, for someone new to it.",
    tools: "Read, Grep, Glob",
    model: "inherit",
    prompt:
      "You explain code to someone new to it. Trace the flow through the files involved, then explain it in plain " +
      "words: what each part does, how they connect, and why it's built that way where the code shows it. Point to " +
      "file paths and line numbers. Don't change any files.",
  },
];

/** The shipped roles first, then the starters. */
export function agentTemplates(): AgentTemplate[] {
  const roles = Object.values(LibrarySchema.parse(shippedLibrary).roles).map(
    (r): AgentTemplate => ({
      id: `role:${r.name}`,
      source: "role",
      name: r.name,
      description: r.description,
      ...(r.tools ? { tools: r.tools } : {}),
      model: r.model,
      prompt: r.prompt,
    }),
  );
  const starters = STARTERS.map((s): AgentTemplate => ({ id: `starter:${s.name}`, source: "starter", ...s }));
  return [...roles, ...starters];
}
