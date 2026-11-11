# ADR-0015: Any MCP server, through the user's own CLI, with references instead of secrets

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** hafizhrf (owner)
- **Related:** CP-02 (CHECKLIST), [ADR-0002](0002-auth-and-branding.md), [ADR-0004](0004-session-data.md),
  [ADR-0010](0010-unreviewed-marketplace-plugins.md), [ADR-0013](0013-user-level-claude-settings.md), THREAT_MODEL
  T-09 and T-22

## Context

The app adds MCP servers only as reviewed catalog items, through the setup plan. Community tools (opcode, Vibe Kanban)
manage any server: add one, import Claude Desktop's, test the connection. CP-02 asks for the same.

An MCP server is code or a remote service that Claude talks to with the user's rights. Two things make it delicate:
- **A stdio server is a command** the CLI starts on the user's machine.
- **A config can hold secrets:** API keys in `env`, tokens in headers. ADR-0002 says the app never reads, stores or
  handles them.

What the CLI offers (2.1.293; checked on 2026-11-11 with throwaway servers in a scratch project, no model calls):
- **Commands:**
  - `claude mcp add [--scope local|project|user] [--transport stdio|http|sse] [--env K=V…] [--header "N: V"…]`;
  - `list` and `get <name>`, text only, with no JSON mode;
  - `remove --scope`, `login <name>` (OAuth) and `add-from-claude-desktop` (interactive, Mac and WSL only).
- **Health checks:** `list` and `get` health-check every approved server, so they **start** each stdio server and
  contact each HTTP one. A `.mcp.json` server nobody approved shows "Pending approval" and isn't started.
- **`get` prints values:** environment values and header values, unmasked. `add` masks an `Authorization` header in
  its own output.
- **`${NAME}` references are expanded** when the CLI starts or connects to a server, at local, project and user scope,
  in `env` values and in header values. A test server that checked the value connected with the variable set, and
  failed without it. A variable that isn't set is passed through as the literal text, and `list` warns "Missing
  environment variables".
- **Environment:** a stdio server also inherits the environment of the process that runs the CLI.
- **Variadic options:** `--env` and `--header` take several values. A positional argument after them is read as one
  more value, so the name and URL must come first.

## Decision

Workspace settings get an **MCP servers** section. Everything goes through the user's own `claude`, as a child process
with arguments and no shell. **No secret value ever passes through the app.**

- **Reading:**
  - The list comes from `claude mcp list`, when the page opens and on Refresh, and is kept for the app session. The
    page says that checking starts every server.
  - Details and "Check again" come from `claude mcp get <name>`.
  - The sidecar parses the CLI's text. Of environment variables and headers it keeps **names only**; values are
    dropped while parsing, so they never cross IPC or reach a log.
  - Targets and the CLI's error text go through the shared redaction (`redactSecrets`).
  - Nothing reads `~/.claude.json`, which holds the account's details, or Claude Desktop's config.
- **Adding:**
  - stdio servers take a command line, split like a shell would but never run by one. HTTP and SSE servers take a
    URL: `https:`, or `http:` to localhost only.
  - **Environment variables are names.** The app passes `NAME=${NAME}`, which the CLI fills in from the user's
    environment.
  - **A header's value must be a reference**, e.g. `Bearer ${GITHUB_TOKEN}`. A plain value is refused with a pointer
    to the terminal.
  - A command or URL that looks like it holds a key, token or password (`hasSecret`, or a URL with a user or
    password) is refused.
- **What the person sees before anything runs:**
  - an "unreviewed" warning, as ADR-0010 does for plugins;
  - the scope, defaulting to local;
  - the exact command, shown before it runs.
- **Recorded in History:** each add is a run whose Roll back removes the server. At project scope, `.mcp.json` is
  backed up and restored.
- **Scopes:** local is the default; project writes `.mcp.json` for the team; user is every project. As with plugins
  under ADR-0013, a user-scope change goes through the CLI's own `--scope user`. The app never edits the user's
  settings or `~/.claude.json` itself.
- **Removing:** goes through `claude mcp remove --scope`, after a confirmation. A run that added the server shows it
  rolled back.
- **Sign-in and import stay in the user's terminal:**
  - OAuth (`claude mcp login <name>`) and `claude mcp add-from-claude-desktop` are shown as commands with Copy and
    Open terminal;
  - the app never runs them, so it never sees a token or Desktop's config;
  - an import isn't a History run.
- **Read-only servers:** those from plugins (`plugin:…`) and claude.ai connectors are listed, but the page doesn't
  change them.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Edit `.mcp.json` and `~/.claude.json` directly | JSON, no text parsing | `~/.claude.json` holds the account's details and is the CLI's private file (ADR-0004's spirit); ADR-0013 keeps the app out of the user's config | Breaks two ADRs |
| Accept env and header values in the form | Matches `claude mcp add -e K=V` | The app would handle keys (ADR-0002) | References do the same job |
| `claude mcp add-json` with a JSON blob | One argument | Same secrets problem; harder to show the person what runs | Plain flags are clearer |
| List only, check on click | No server starts on its own | The owner chose to load on open (2026-11-11); the CLI checks every server at session start anyway | Owner's choice |
| Import by reading Claude Desktop's config | No terminal step | Reads another app's file, which can hold keys | The CLI's own importer does it |

## Consequences

- **Positive:**
  - any server can be added from the app, safely enough to explain;
  - every add is reversible from History;
  - the app still never holds a key.
- **Negative:**
  - the CLI's text format is a contract. The weekly drift job checks the commands and flags (`cli-contract.ts`); the
    parser is tested on the format as captured;
  - a value that isn't a reference (a header with a plain token) needs the terminal;
  - opening the page starts every configured server.
- **Revisit when:**
  - the CLI gains `mcp list --json` or `mcp get --json`, which would replace the text parser;
  - Claude Desktop's import gains a non-interactive mode;
  - people ask for plain header values often.

## References

- `claude mcp --help` and its subcommands, Claude Code 2.1.293.
- The spike: a minimal stdio server and a minimal streamable-HTTP server that each accepted only an expected value,
  checked with `claude mcp get` with the variable set and unset, at local, project and user scope (2026-11-11).
- Claude Code's MCP docs: environment variable expansion in `.mcp.json` (https://code.claude.com/docs/en/mcp)
  **(verify)** for local and user scope; the spike showed it works there too.
