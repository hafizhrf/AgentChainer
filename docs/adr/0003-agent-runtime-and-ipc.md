# ADR-0003: Agent runtime and IPC — one supervised Agent SDK sidecar, JSON-RPC over stdio, Rust as hub

- **Status:** Proposed (accept after spikes S1 and S2: checklist M0-15, M0-16, M0-21)
- **Date:** 2026-10-28
- **Deciders:** project owner
- **Related:** [ADR-0001](0001-desktop-stack.md), [ARCHITECTURE §2 and §4](../ARCHITECTURE.md), checklist M0-03, M1-01, M1-02

## Context

- The UI needs a live, typed stream of agent activity: text deltas, tool calls, subagents, permission requests and cost.
- The TS Agent SDK exposes:
  - `query()` with **streaming input** (needed for follow-ups, `interrupt()` and `setPermissionMode()`);
  - `canUseTool`, hooks, session APIs and file checkpointing.
- Each `query()` spawns its own `claude` child process.
- We also need somewhere to run the bootstrap engine (detectors, installers, generators), which is mostly TS/Node work.

## Decision

- **One long-lived Node sidecar process per app instance**, supervised by the Rust core (spawn, health ping, restart with
  backoff). It hosts N concurrent sessions, each a `query()` whose `claude` child is the user's installed binary
  (see [ADR-0002](0002-auth-and-branding.md)).
- **Protocol:** JSON-RPC 2.0, one JSON object per line (NDJSON), over the sidecar's **stdin/stdout**. stdout is reserved for
  protocol frames; all logs go to stderr. A `system.hello` handshake exchanges protocol and SDK versions.
- **Schemas** live in `packages/protocol` (zod). We generate JSON Schema from them, then TS and Rust types. Both ends validate.
- **Rust core is the hub.** It relays sidecar notifications to the UI as Tauri events, forwards UI requests to the sidecar,
  and owns persistence (SQLite) and OS integrations. The UI never talks to the sidecar directly.
- The SDK is used through an internal `AgentRuntime` interface, so a CLI-`stream-json` implementation could replace it if needed.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| One sidecar **per workspace** | Crash isolation per workspace | More memory and processes; multiple DB writers | Each session already runs in its own `claude` process; isolation gain is small |
| Sidecar exposes a localhost WebSocket to the UI | Fewer hops | Any local process could connect, so it needs auth tokens and origin checks; bypasses Rust's validation | Security surface |
| Rust drives `claude -p --output-format stream-json` directly | No Node | Loses typed hooks and `canUseTool`; permission prompts need `--permission-prompt-tool` via MCP; more parsing | Kept as the fallback `AgentRuntime` |

## Consequences

- **Positive:**
  - A single place for agent logic; a simple security boundary (stdio only).
  - Rust stays thin and generic, and mostly relays frames.
- **Negative:**
  - A sidecar crash interrupts all running turns. SDK sessions are persisted, so they can be resumed, but in-flight tool calls are lost.
  - Backpressure: text deltas must be coalesced (~16 ms frames) before crossing to the UI.
- **Open item (M0-03):** confirm that the Agent SDK's license/terms allow bundling its JS inside our distributed sidecar binary.
  If not, install the SDK on first run from npm instead.
- **Revisit when:** S1/S2 numbers are unacceptable, the SDK changes its process model, or a multi-window feature needs per-window isolation.

## References

- TS SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Streaming output: https://code.claude.com/docs/en/agent-sdk/streaming-output
- Headless CLI: https://code.claude.com/docs/en/headless
