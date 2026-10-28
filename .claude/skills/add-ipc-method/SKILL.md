---
name: add-ipc-method
description: Add a JSON-RPC method between the AgentChainer UI and the Node sidecar, covering the protocol type, sidecar handler, UI call, tests and docs. Use when a feature needs a new request from the UI to the agent runtime.
---

# Add an IPC method

Frames flow UI → Rust core (`sidecar_send`) → sidecar stdin, and back as `sidecar://frame` events (ADR-0003). Rust
relays frames without knowing their shape, so a new method needs **no Rust change**.

1. **Protocol:** add the method to `Methods` in `packages/protocol/src/index.ts`, with `params` and `result` types.
   - Results never carry secrets or account identity (ADR-0002).
   - For a new event instead of a method, extend `AgentEvent` or `Notifications`.
2. **Sidecar handler:** add it in `packages/sidecar/src/main.ts`.
   - Validate params with `requireString(...)` or explicit checks.
   - Throw `RpcFailure(code, message)` for expected failures: `-32602` for bad params, `-32001…` for app errors.
   - Put the logic in a module (e.g. `claude.ts`, `installer.ts`) so it is unit-testable. `main.ts` stays wiring only.
   - Never write to stdout outside `rpc.ts`. Logs go through `log()` to stderr.
3. **UI:** call `request("<method>", params)` from `apps/desktop/src`. `sidecar.ts` types the result from `Methods`.
4. **Tests:**
   - Add a `*.test.ts` next to the module (`node:test`).
   - If the method reacts to SDK messages, extend `normalize.test.ts` with a recorded fixture (see CONTRIBUTING:
     never commit raw recordings).
5. **Smoke test over stdio:**
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"<method>","params":{}}' | node packages/sidecar/src/main.ts
   ```
6. **Docs:**
   - Add the method to the IPC table in `docs/ARCHITECTURE.md` §4.
   - Note the checklist ID and evidence in the PR.
7. **Gate:** `pnpm lint && pnpm typecheck && pnpm test`.
