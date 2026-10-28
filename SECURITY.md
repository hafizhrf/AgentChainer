# Security Policy

## Supported versions

AgentChainer is pre-alpha. Only the `main` branch receives fixes until the first release (v0.1).

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub:
**[Security → Report a vulnerability](https://github.com/hafizhrf/AgentChainer/security/advisories/new)**.
Don't open a public issue.

Please include:
- what an attacker can do and under which conditions;
- steps to reproduce (a minimal repo or prompt helps);
- affected component and version or commit;
- any suggested fix.

You'll get an acknowledgement within 7 days. We'll agree on a disclosure date with you once a fix is ready.

## What's in scope

AgentChainer drives an AI agent on the user's machine, so we especially want to hear about:

- **Guard bypasses:** commands or tool calls that should be blocked by the PreToolUse guard
  (`packages/sidecar/src/guard.ts`) but aren't, especially through prompt injection from repository content.
- **Credential exposure:** any path where the app reads, logs, displays or transmits Claude credentials, API keys,
  account details or secrets. The app must never handle these ([ADR-0002](docs/adr/0002-auth-and-branding.md)).
- **IPC and process boundaries:** a way for another local process or web content to drive the sidecar or the Rust core.
- **Supply chain:** ways to make the app install or run unpinned or tampered skills, plugins, MCP servers or SDK
  packages ([ADR-0005](docs/adr/0005-catalog-trust-model.md)).
- **Data in fixtures or logs:** personal data leaking into committed test fixtures, diagnostics or logs.

Out of scope:
- vulnerabilities in Claude Code, the Claude Agent SDK, or Anthropic's services (report those to
  [Anthropic](https://hackerone.com/anthropic));
- issues that need an already-compromised machine.
