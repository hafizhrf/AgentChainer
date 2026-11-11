import { runClaude } from "./claude.ts";
import { runAsync } from "./run-async.ts";

/**
 * Thin wrappers over the user's own CLI for plugin and MCP management (spike S6). The bootstrap installer (M2-13…15)
 * builds on these; it never runs upstream install scripts (ADR-0005).
 */

export type Scope = "user" | "project" | "local";
export type CliResult = { ok: boolean; status: number | null; json: unknown; stdout: string; stderr: string };

function run(claude: string, args: string[], cwd: string): CliResult {
  const r = runClaude(claude, args, cwd);
  return { ok: r.status === 0, status: r.status, json: parseJsonOutput(r.stdout), stdout: r.stdout, stderr: r.stderr };
}

/**
 * List commands print pretty-printed (multi-line) JSON; install/uninstall `--json` print one result line,
 * possibly after other output. Not every command has a JSON mode, so callers fall back to the exit status.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  for (const candidate of [text, text.split("\n").pop() ?? ""]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  return null;
}

export const listMarketplaces = (claude: string, cwd: string) =>
  run(claude, ["plugin", "marketplace", "list", "--json"], cwd);

export const listPlugins = (claude: string, cwd: string) => run(claude, ["plugin", "list", "--json"], cwd);

/** `id` is `plugin@marketplace`. No `-y`: a plugin that needs a marketplace-declared command must be confirmed by a person. */
export const installPlugin = (claude: string, id: string, scope: Scope, cwd: string) =>
  run(claude, ["plugin", "install", id, "--scope", scope, "--json"], cwd);

export const uninstallPlugin = (claude: string, id: string, scope: Scope, cwd: string) =>
  run(claude, ["plugin", "uninstall", id, "--scope", scope, "--json"], cwd);

/** Registers a stdio MCP server. `local` scope is private to this user and project; `project` writes `.mcp.json`. */
export const addMcpServer = (
  claude: string,
  name: string,
  scope: Scope,
  command: string,
  args: string[],
  cwd: string,
) => run(claude, ["mcp", "add", "--scope", scope, name, "--", command, ...args], cwd);

export const getMcpServer = (claude: string, name: string, cwd: string) => run(claude, ["mcp", "get", name], cwd);

export const removeMcpServer = (claude: string, name: string, scope: Scope, cwd: string) =>
  run(claude, ["mcp", "remove", "--scope", scope, name], cwd);

/**
 * The Plugins page's calls (UX-10, ADR-0010). They run without blocking the sidecar: listing the marketplaces takes a
 * few seconds, and an install clones the plugin's repository.
 */
async function runLong(claude: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<CliResult> {
  const r = await runAsync(claude, args, { cwd, timeoutMs });
  return { ok: r.status === 0, status: r.status, json: parseJsonOutput(r.stdout), stdout: r.stdout, stderr: r.stderr };
}

/** A marketplace-declared command a person confirmed: its sha256, as an earlier `--json` run reported it. */
const accept = (sha256?: string) => (sha256 ? ["--accept-command", sha256] : []);

export const pluginCli = (claude: string, cwd: string) => ({
  /** Installed plugins, and every plugin the configured marketplaces list. */
  available: () => runLong(claude, ["plugin", "list", "--available", "--json"], cwd, 60_000),
  installed: () => runLong(claude, ["plugin", "list", "--json"], cwd, 60_000),
  marketplaces: () => runLong(claude, ["plugin", "marketplace", "list", "--json"], cwd, 60_000),
  /** The component inventory and projected tokens of an installed plugin. Text only: the CLI has no JSON mode for it. */
  details: (id: string) => runLong(claude, ["plugin", "details", id], cwd, 60_000),
  install: (id: string, scope: Scope, acceptCommand?: string) =>
    runLong(claude, ["plugin", "install", id, "--scope", scope, "--json", ...accept(acceptCommand)], cwd),
  update: (id: string, scope: Scope, acceptCommand?: string) =>
    runLong(claude, ["plugin", "update", id, "--scope", scope, "--json", ...accept(acceptCommand)], cwd),
  uninstall: (id: string, scope: Scope) =>
    runLong(claude, ["plugin", "uninstall", id, "--scope", scope, "--json"], cwd),
  setEnabled: (id: string, scope: Scope, enabled: boolean) =>
    runLong(claude, ["plugin", enabled ? "enable" : "disable", id, "--scope", scope, "--json"], cwd),
});

export type PluginCli = ReturnType<typeof pluginCli>;

/** A server for `mcp add`, already checked (`mcp.ts` `addSpec`). */
export type McpAddSpec = {
  name: string;
  scope: Scope;
  transport: "stdio" | "http" | "sse";
  /** stdio: the program and its arguments. */
  argv: string[];
  url: string;
  /** stdio: `NAME=${NAME}` references. */
  env: string[];
  /** HTTP and SSE: `Name: value` lines. */
  headers: string[];
};

/**
 * The `mcp add` arguments. `--env` and `--header` take several values, so each goes where nothing follows it but
 * another option or `--`: after the name for stdio, after the URL otherwise.
 */
export function mcpAddArgs(s: McpAddSpec): string[] {
  return s.transport === "stdio"
    ? ["mcp", "add", "--scope", s.scope, s.name, ...s.env.flatMap((e) => ["--env", e]), "--", ...s.argv]
    : [
        "mcp",
        "add",
        "--scope",
        s.scope,
        "--transport",
        s.transport,
        s.name,
        s.url,
        ...s.headers.flatMap((h) => ["--header", h]),
      ];
}

/**
 * The MCP servers page's calls (CP-02, ADR-0015). Listing health-checks every server, which can take a while; it
 * never blocks the sidecar.
 */
export const mcpCli = (claude: string, cwd: string) => ({
  list: () => runLong(claude, ["mcp", "list"], cwd, 120_000),
  get: (name: string) => runLong(claude, ["mcp", "get", name], cwd, 60_000),
  add: (spec: McpAddSpec) => runLong(claude, mcpAddArgs(spec), cwd, 60_000),
  remove: (name: string, scope: Scope) => runLong(claude, ["mcp", "remove", "--scope", scope, name], cwd, 60_000),
});

export type McpCli = ReturnType<typeof mcpCli>;
