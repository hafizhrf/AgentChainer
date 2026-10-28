# ADR-0006: License — Apache-2.0

- **Status:** Accepted (owner confirmed 2026-10-28; checklist M0-02)
- **Date:** 2026-10-28
- **Deciders:** project owner
- **Related:** [RISKS R-11](../RISKS.md), checklist M0-03

## Context

AgentChainer is public open source and wants contributors and downstream adoption. It depends on:

- the Claude Agent SDK, whose use is governed by Anthropic's Commercial Terms (not an OSI license);
- permissively licensed libraries (Tauri, React, `@xyflow/react` MIT, Monaco MIT, xterm.js MIT).

Related tools use AGPL (opcode, Claude Squad), Apache-2.0 (vibe-kanban) and MIT (Crystal/Nimbalyst).

## Decision

License AgentChainer's own code under **Apache-2.0** (explicit patent grant, permissive, widely accepted by companies).

- **No copying** of code from AGPL projects (opcode, Claude Squad); reading them for ideas is fine.
- Third-party catalog content (skills/plugins) keeps its own license. The catalog records it, and the installer shows it.
  Source-available items (e.g. some anthropics/skills document skills) are excluded from defaults.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| MIT | Simplest, most familiar | No explicit patent grant |
| AGPL-3.0 | Forces hosted forks to share | Deters companies and contributors; unusual for a desktop client |

## Consequences

- Add `LICENSE` and SPDX headers (optional) at M0.
- Add a `NOTICE` file listing third-party components bundled in releases.
- The SDK is not redistributed: it is downloaded on first run (M0-03, [ADR-0003](0003-agent-runtime-and-ipc.md)).

## References

- https://www.apache.org/licenses/LICENSE-2.0
