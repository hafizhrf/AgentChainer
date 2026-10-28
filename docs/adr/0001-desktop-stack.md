# ADR-0001: Desktop stack — Tauri v2 + React/TypeScript + Node sidecar

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** project owner
- **Related:** [ADR-0003](0003-agent-runtime-and-ipc.md), checklist M0-06, M0-07, M0-15 (spike S1)

## Context

AgentChainer is a desktop app for Windows, macOS and Linux. It needs:

- A rich UI: streaming chat, diff viewer (Monaco), terminal (xterm.js), node graphs (React Flow).
- Tight OS integration: process supervision, PTY, file watching, keychain, auto-update.
- The **Claude Agent SDK**, which is officially available only for **TypeScript** (`@anthropic-ai/claude-agent-sdk`,
  Node 18.14+) and **Python** (`claude-agent-sdk`, Python 3.10+). Other languages would have to drive the `claude` CLI's
  `stream-json` mode directly.
- A small, fast download for an open-source audience.

## Decision

- **Shell:** Tauri v2 with a thin **Rust core** (windows, supervision, PTY, fs watch, SQLite, updater).
- **UI:** React + TypeScript (strict) + Vite, rendered in the platform WebView.
- **Agent runtime:** a **Node.js sidecar** written in TypeScript that hosts the Agent SDK and the bootstrap engine,
  shipped as a Tauri `externalBin` per target triple.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Electron + React (all TS) | One language; SDK runs in the main process; mature tooling; Chromium everywhere | ~150 MB+ bundles, higher RAM; still needs signing | Heavier, but it's the **fallback** if S1/S2 fail |
| Tauri v2 + Python sidecar | Python SDK; some users prefer Python | Bundling Python cross-platform is the most painful option; UI is still TS | Packaging cost |
| Tauri v2, Rust only, CLI `stream-json` | No Node at all; smallest bundle | Re-implements what the SDK gives (typed messages, hooks, `canUseTool`, session APIs); more brittle to CLI changes | Too much plumbing and churn risk |

## Consequences

- **Positive:**
  - Small binaries and low idle memory.
  - Rust gives us safe OS-level code.
  - The TS SDK has the richest API (session management, `setPermissionMode`, `forwardSubagentText`, file checkpointing).
- **Negative:**
  - Polyglot repo (Rust + TS).
  - We must package and sign a sidecar executable per OS.
  - Three different WebViews (WKWebView, WebView2, WebKitGTK) behave differently, so all three need early testing,
    especially WebKitGTK performance on Linux.
- **Spike outcome (2026-10-28):** S1 and S2 passed, so the Electron fallback isn't needed. The cost is the sidecar's
  size: a Node SEA is ~117 MB per platform, versus a 4.3 MB app binary ([S1](../spikes/S1-sidecar-packaging.md)).
- **Revisit when:** spike S1 (sidecar packaging) or S2 (event-stream latency) fails on any OS without a reasonable
  workaround, or the sidecar's size becomes a distribution problem.
  In that case, switch to Electron and record the change in a new ADR.

## References

- Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/ and https://v2.tauri.app/learn/sidecar-nodejs/
