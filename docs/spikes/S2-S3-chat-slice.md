# Spike S2/S3 — Event stream and tool approvals (chat slice)

- **Date:** 2026-10-28
- **Checklist:** M0-16 (S2), M0-17 (S3); touches M0-15 (S1: CLI resolution only)
- **Status:** Complete (S2 and S3).
  - S3 behaviours are verified against the real CLI by an automated harness (11/11 checks, including `auto` mode), and
    the owner checked the dialog and mode switcher in the app.
  - S2 latency and CPU were measured with the app's self-test mode (see Results).

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
- `apps/desktop/src`: a minimal chat UI with streaming text, tool cards, an approval dialog, a permission-mode switcher,
  Stop, and a cost estimate.
- `packages/sidecar/src/guard.ts`: the hard denylist, run as a `PreToolUse` hook in every mode, with unit tests in
  `guard.test.ts`.
- `packages/sidecar/scripts/spike-host.ts`: drives the sidecar exactly as the Rust core does, and checks each scenario's
  outcome automatically.

## Method

1. `node packages/sidecar/scripts/spike-host.ts --cwd <scratch dir> --scenario all` (haiku) runs four scenarios in one
   session:
   - **basic:** a text turn, then two `Write` turns with approval allowed and denied;
   - **mode:** `setPermissionMode("acceptEdits")`, a write, then back to `default` and another write;
   - **interrupt:** a 30-second Bash command interrupted after 1.5 s; a follow-up turn; then an interrupt sent while idle,
     followed by another turn;
   - **guard:** `rm -rf` on a sibling folder that doesn't exist (outside the workspace).
2. Launched the debug app and captured only its window. The top bar shows the `system.hello` result, which covers
   the UI → Rust → sidecar → `claude --version` round trip.

## Results

| Measurement | Result |
|---|---|
| CLI discovery | `~/.local/bin/claude` found, version `2.1.293 (Claude Code)` |
| Text turn ("Reply with exactly one word: pong") | Reply `pong`. First text delta after **2.1–3.4 s** (n=3), turn total 2.2–3.5 s |
| Approval → allow | `permission.request` arrives before the tool runs. After allow, the file is created with the expected content |
| Approval → deny | The tool result is an error ("The user denied this action."). The model acknowledges it and doesn't retry. No file is created |
| Sidecar-side permission round trip (host sends `permission.respond` → ack) | **0.4–0.8 ms** |
| `setPermissionMode("acceptEdits")` mid-session | The next write runs with **no prompt**. Switching back to `default` prompts again |
| `interrupt()` during a running Bash tool | The turn ends **20–35 ms** after the interrupt (`result` subtype `error_during_execution`). The next turn works normally |
| `interrupt()` while idle | Before the fix it aborted the **next** turn. Now the sidecar ignores it (`interrupted: false`) and the next turn succeeds |
| `PreToolUse` guard (`rm -rf ../…` outside the workspace) | Blocked **before any approval prompt**. The tool result reads `PreToolUse:Bash hook error: Blocked by AgentChainer guard: …` |
| Guard unit tests | 10/10 pass: everyday commands allowed, destructive and exfiltrating ones blocked |
| Full harness run | **9/9 checks pass** in one session |
| `setPermissionMode("auto")` (owner's account) | `mkdir` in the workspace runs with **no prompt**. The guard still blocks `rm -rf` outside the workspace (2/2) |
| In-app check by the owner on a real repo (Opus) | The approval dialog shows the tool description and full input, and the mode switcher works. Session cost ≈ $1.03 (estimate) |
| Estimated cost of a full harness run (≈ 9 turns, haiku) | **≈ $0.05** (SDK `total_cost_usd`, an estimate) |
| App: UI → Rust → sidecar → CLI handshake | Works; the top bar renders CLI, SDK and Node versions |
| **S2: sidecar → Rust → UI delta latency** (self-test, haiku; 300- and 1000-word replies) | **p50 1 ms, p95 2–3 ms, max 4–16 ms** over 72 and 196 deltas. Measured from the sidecar's send time to JS receipt in the WebView |
| **S2: CPU / memory while streaming** (`ps`, 250 ms samples) | App ~2–3% avg (startup spikes to ~57–74%), sidecar ~1.4–1.9% avg, `claude` ~6–9% avg. RSS: app ~59 MB, sidecar ~86 MB, `claude` ~210–290 MB |

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
7. **An interrupt sent while idle aborts the next turn.** The SDK doesn't drop it, so a Stop click that races the end of
   a reply would kill the user's next message. The sidecar now counts open turns and ignores an interrupt when idle.
8. **Claude Code has its own command guards.** It rejected `sleep 30 && echo …` with a message suggesting a
   different waiting pattern. Our guard adds to these and doesn't replace them. Tests that need a long-running command
   should use something like a Node timer.
9. **Models often refuse obviously destructive commands themselves** (e.g. `git push --force`), so live tests of the
   guard need a command the model will attempt. The unit tests are the real coverage for each rule.
10. **A hook denial reaches the model as a "hook error" tool result.** The model sees our reason and stops. The UI marks
    these tool cards "blocked by guard".
11. **"Auto-accept edits" was read as "auto mode".** In the owner's test, Bash still asked in `acceptEdits`, which is
    correct but unexpected. The app now also offers `auto`, Claude's classifier mode, and labels `acceptEdits` as
    "commands still ask". Mode explanations are tracked in M1-18 and UX-05.

## Not covered yet

- [x] End-to-end delta latency and CPU (S2): measured with the self-test above. WebView render cost is not included,
      because on macOS the WebView's processes aren't children of the app.
- [x] In-app check by a human: approval dialog and mode switcher (owner, 2026-10-28). The Stop button wasn't clicked;
      the harness covers the RPC behind it.
- [ ] Sidecar as a single executable; app launched from Finder (PATH and env resolution) — S1 / M1-03.

## Decision so far

No blocker found. The SDK-in-sidecar plus Rust-relay design from [ADR-0003](../adr/0003-agent-runtime-and-ipc.md)
handles streaming and approvals. ADR-0003 stays **Proposed** until S1 (packaging) is done.
