import { isAtLeast, MIN_CLAUDE_VERSION, parseAuthStatus } from "./claude.ts";

/**
 * What AgentChainer runs through the user's own `claude`, besides sessions (which go through the SDK): the commands
 * and flags the weekly drift job (X-05, `.github/workflows/drift.yml`) checks against the newest CLI with
 * `scripts/cli-contract.ts`. `cli-contract.test.ts` keeps this list in step with `installer.ts`.
 */
export type ContractEntry = { command: string[]; flags: string[]; why: string };

export const CLI_CONTRACT: ContractEntry[] = [
  { command: ["auth", "status"], flags: ["--json"], why: "Readiness: whether the user is signed in" },
  {
    command: ["mcp", "add"],
    flags: ["--scope", "--transport", "--env", "--header"],
    why: "setup and the MCP servers page: register an MCP server",
  },
  { command: ["mcp", "get"], flags: [], why: "setup and the MCP servers page: check an MCP server" },
  { command: ["mcp", "list"], flags: [], why: "the MCP servers page: list and health-check servers" },
  { command: ["mcp", "remove"], flags: ["--scope"], why: "rollback and the MCP servers page: remove an MCP server" },
  { command: ["mcp", "login"], flags: [], why: "the MCP servers page shows it, to run in the user's own terminal" },
  {
    command: ["mcp", "add-from-claude-desktop"],
    flags: ["--scope"],
    why: "the MCP servers page shows it, to run in the user's own terminal",
  },
  { command: ["plugin", "list"], flags: ["--json", "--available"], why: "setup and the Plugins page: list plugins" },
  { command: ["plugin", "marketplace", "list"], flags: ["--json"], why: "setup and the Plugins page: marketplaces" },
  { command: ["plugin", "details"], flags: [], why: "the Plugins page: what a plugin brings" },
  {
    command: ["plugin", "install"],
    flags: ["--scope", "--json", "--accept-command"],
    why: "setup and the Plugins page: install",
  },
  { command: ["plugin", "update"], flags: ["--scope", "--json", "--accept-command"], why: "the Plugins page: update" },
  { command: ["plugin", "uninstall"], flags: ["--scope", "--json"], why: "rollback and the Plugins page: uninstall" },
  { command: ["plugin", "enable"], flags: ["--scope", "--json"], why: "the Plugins page: turn on" },
  { command: ["plugin", "disable"], flags: ["--scope", "--json"], why: "the Plugins page: turn off" },
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The flags an entry needs that the command's `--help` doesn't list as options. Only option lines count
 * ("  -s, --scope <scope>  …"), not a flag mentioned in another option's description.
 */
export function missingFlags(help: string, entry: ContractEntry): string[] {
  return entry.flags.filter(
    (flag) => !new RegExp(`^\\s*(?:-\\w,\\s*)?${escapeRegExp(flag)}(?=[\\s,=<[]|$)`, "m").test(help),
  );
}

/** What's wrong with `claude --version` output, or null when it's at least the version the app needs. */
export function versionProblem(output: string): string | null {
  if (isAtLeast(output, MIN_CLAUDE_VERSION)) return null;
  return `\`claude --version\` printed "${output.trim().slice(0, 80)}", older than ${MIN_CLAUDE_VERSION} or unreadable`;
}

/** `claude auth status --json` must keep parsing, signed in or not: Readiness depends on it. */
export function authStatusProblem(stdout: string): string | null {
  return parseAuthStatus(stdout)
    ? null
    : "`claude auth status --json` no longer prints a `loggedIn` boolean that Readiness can read";
}
