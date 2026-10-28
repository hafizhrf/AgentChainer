---
name: add-ipc-method
description: Add a JSON-RPC method between the AgentChainer UI and the Node sidecar, covering the zod schema, sidecar handler, UI call, tests and docs. Use when a feature needs a new request from the UI to the agent runtime.
---

# Add an IPC method

Frames flow UI → Rust core (`sidecar_send`) → sidecar stdin, and back as `sidecar://frame` events (ADR-0003). Rust
relays frames without knowing their shape, so a new method needs **no Rust change**.

1. **Schema:** add an entry to `methodSchemas` in `packages/protocol/src/index.ts`, with zod `params` and `result`.
   - The TS types (`Methods`, `MethodParams`, `MethodResult`) are inferred, so there's nothing else to declare.
   - Results never carry secrets or account identity (ADR-0002).
   - For a new event instead of a method, extend `AgentEventSchema` or `notificationSchemas`.
   - Then regenerate the JSON Schema: `pnpm --filter @agentchainer/protocol export-schema`. A test fails while it's stale.
2. **Sidecar handler:** add it in `packages/sidecar/src/main.ts`.
   - TypeScript requires a handler for every method.
   - Params arrive **already validated and typed** (`rpc.ts` `dispatch`), and the result is validated before it's sent.
   - Throw `RpcFailure(RpcErrorCode.x, message)` for expected failures. Add a code to `RpcErrorCode` if needed.
   - Put the logic in a module (e.g. `claude.ts`, `installer.ts`) so it is unit-testable. `main.ts` stays wiring only.
   - Never write to stdout outside `rpc.ts`. Logs go through `log()` to stderr.
3. **UI:** call `request("<method>", params)` from `apps/desktop/src`. `sidecar.ts` validates and types the result.
4. **Tests:**
   - Add a `*.test.ts` next to the module (`node:test`).
   - Add schema cases to `packages/protocol/src/protocol.test.ts` when the shape has rules (min lengths, enums).
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
