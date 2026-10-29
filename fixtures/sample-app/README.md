# sample-app

A deliberately tiny project with a **seeded bug** for AgentChainer's M1 exit scenarios: `total()` in
`src/cart.js` ignores each item's quantity, so `node --test` fails.

The scenarios are listed in [docs/CHECKLIST.md](../../docs/CHECKLIST.md) (M1-E1…E6).
`node packages/sidecar/scripts/spike-host.ts --cwd <empty dir> --scenario exit` copies this folder into
`<empty dir>` and runs E1–E5 against your own `claude` login.

Don't fix the bug here: the scenarios need it.
