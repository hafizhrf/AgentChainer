# Spike S2/S3 — Event stream and tool approvals (chat slice)

- **Date:** 2026-10-28
- **Checklist:** M0-16 (S2), M0-17 (S3); touches M0-15 (S1: CLI resolution only)
- **Status:** In progress. The sidecar-level flow is verified; UI-level measurements and the remaining S3 items are open.

## Question

Can a Node sidecar running the Claude Agent SDK, relayed by the Rust core, stream agent output to the React UI and
broker tool approvals through `canUseTool`? It must do this while using the **user's own** `claude` CLI and login
([ADR-0002](../adr/0002-auth-and-branding.md), [ADR-0003](../adr/0003-agent-runtime-and-ipc.md)).

## Setup

| Item | Value |
|---|---|
| Machine | macOS 26.5 (x86_64) |
| Node | 24.18.0, running sidecar `.ts` files via built-in type stripping (no build step) |
| Claude Code CLI | 2.1.293, user install at `~/.local/bin/claude`, passed via `pathToClaudeCodeExecutable` |
| Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.311. The per-platform bundled binaries are excluded with pnpm `ignoredOptionalDependencies` |
| Model | `haiku` (cheapest; keeps spike cost negligible) |
| Permission mode | `default` |

**Pieces built:**

- `packages/protocol`: spike-level JSON-RPC types (`system.hello`, `session.*`, `permission.respond`, `agent.event`,
  `permission.request`).
- `packages/sidecar`:
  - NDJSON JSON-RPC over stdio (`rpc.ts`); stdout carries protocol frames only.
  - CLI discovery (`claude.ts`).
  - A streaming-input `query()` session with a `canUseTool` broker and an event normalizer (`session.ts`).
- `apps/desktop/src-tauri/src/sidecar.rs`:
  - spawns `node packages/sidecar/src/main.ts` (dev only);
  - forwards valid JSON lines to the UI as `sidecar://frame` events;
  - accepts frames through the `sidecar_send` command.
- `apps/desktop/src`: a minimal chat UI with streaming text, tool cards, an approval dialog, Stop, and a cost estimate.
- `packages/sidecar/scripts/spike-host.ts`: drives the sidecar exactly as the Rust core does, for repeatable measurements.

## Method

1. `node packages/sidecar/scripts/spike-host.ts --cwd <scratch dir> --model haiku`. It sends:
   - `system.hello`, then `session.start`;
   - a text-only turn;
   - a turn that requires a `Write` approval.
2. Ran the same harness with `--deny`.
3. Launched the debug app and captured only its window. The top bar shows the `system.hello` result, which covers
   the UI → Rust → sidecar → `claude --version` round trip.

## Results

| Measurement | Result |
|---|---|
| CLI discovery | `~/.local/bin/claude` found, version `2.1.293 (Claude Code)` |
| Text turn ("Reply with exactly one word: pong") | Reply `pong`. First text delta after **2.1–3.4 s** (n=3), turn total 2.2–3.5 s |
| Approval → allow | `permission.request` arrives before the tool runs. After allow, the file is created with the expected content |
| Approval → deny | The tool result is an error ("The user denied this action."). The model acknowledges it and doesn't retry. No file is created |
| Sidecar-side permission round trip (host sends `permission.respond` → ack) | **0.4–0.8 ms** |
| Estimated cost per harness run (2 turns, haiku) | **$0.006–0.011** (SDK `total_cost_usd`, an estimate) |
| App: UI → Rust → sidecar → CLI handshake | Works; the top bar renders CLI, SDK and Node versions |

## Findings

1. **Read-only commands bypass `canUseTool`.** Claude Code auto-approves commands like `echo`, so they never reach the
   callback. Approvals only appear for actions that need them, such as `Write`. This confirms we need the `PreToolUse`
   guard to see every call ([ARCHITECTURE §6](../ARCHITECTURE.md#6-permissions)).
2. **`system/init` arrives at the start of every turn** in streaming-input mode, not once per session. The UI has to
   treat `session.started` as idempotent.
3. **The user's CLI works with the SDK, and no bundled binary is needed.** `ignoredOptionalDependencies` keeps the
   ~per-platform binaries out of `node_modules`, which supports ADR-0002 and simplifies packaging (S1).
4. **pnpm 11 enforces a minimum release age.** The newest SDK release (12 h old) was held back. We pinned 0.3.311
   (35 h old) instead of adding an exclusion. Dependency bots (M0-11) must respect this policy.
5. **Short replies arrive as a single delta.** Perceived latency is dominated by the model's time to first token, not by
   our relay. UI-side delta latency still needs instrumenting to confirm this.
6. **Running nested inside a Claude Code session** (`CLAUDECODE=1` set) did not block the SDK-spawned CLI.

## Not covered yet

- [ ] End-to-end delta latency and CPU in the UI (instrument timestamps in the Rust relay and UI) — S2.
- [ ] Manual test of the approval dialog and the Stop button (`interrupt()`) in the app — S3.
- [ ] `PreToolUse` guard (denylist) and a mid-session `setPermissionMode()` — S3.
- [ ] Sidecar as a single executable; app launched from Finder (PATH and env resolution) — S1 / M1-03.

## Decision so far

No blocker found. The SDK-in-sidecar plus Rust-relay design from [ADR-0003](../adr/0003-agent-runtime-and-ipc.md)
handles streaming and approvals. ADR-0003 stays **Proposed** until S1 (packaging) is done.
