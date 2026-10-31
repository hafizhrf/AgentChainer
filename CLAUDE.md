# AgentChainer — agent context

Open-source desktop app (Tauri v2 + React/TS + Node sidecar on the Claude Agent SDK) that makes repos agent-ready and
keeps agent work transparent and verified. **Current phase: R1 (v0.1 release prep; publishing waits for M0-01 and M0-22).
M1 awaits the Ubuntu exit runs, E6 by hand and the macOS/Ubuntu click-through (Windows passed); M2-E2 is deferred.**

The app has a working M1/M2 UI in a three-column shell (UX-03):
- a sidebar with sessions and workspaces, and a native menu with shortcuts;
- readiness check, sessions with resume, fork and file rewind, tool approvals, subagent cards;
- a right panel with changes, workspace files, diff and revert, git and the setup report (tabs can be hidden); a
  terminal;
- a full-page Workspace settings (`src/setup/`): readiness, setup plan, commands, permission rules, history.

Packaged builds ship the sidecar as a Node single executable (spike S1). The rest of the design pass is the UX track
in the checklist.

Layout:
- `apps/desktop`: Tauri app. `src/` is the React UI, `src-tauri/` is the Rust core (native menu in `menu.rs`).
  UI building blocks are Radix-based wrappers in `src/ui/`; styles are CSS tokens and files in `src/styles/`, no
  Tailwind ([ADR-0008](docs/adr/0008-ui-components-and-styling.md)).
- `packages/protocol`: IPC types.
- `packages/sidecar`: Node agent runtime.
- `docs/`: planning docs.

## Source of truth

- Scope and user stories: `docs/PRD.md`
- Design: `docs/ARCHITECTURE.md`
- Decisions: `docs/adr/`. Don't contradict an Accepted ADR; propose a new ADR instead (copy `docs/adr/0000-template.md`).
- Work plan: `docs/CHECKLIST.md` (task IDs like `M1-08`)
- Catalog rules: `docs/CATALOG.md`; risks: `docs/RISKS.md`; user auth guide: `docs/guides/AUTH_SETUP.md`
- Security: `docs/THREAT_MODEL.md` (update it with any new command, capability or network call); privacy promises:
  `docs/PRIVACY.md`; releases: `docs/RELEASING.md`

## Rules

- Find the checklist ID before starting work, and reference it in branches, commits and PRs: `feat(sidecar): … [M1-08]`.
- Tick a checklist box only with evidence (PR, CI run, spike doc). Never report a check as passed unless you ran it.
- Auth: the app must never implement or automate login, read credentials, or store tokens or keys ([ADR-0002](docs/adr/0002-auth-and-branding.md)).
- Sessions: use SDK session APIs only. Never parse `~/.claude/projects/**/*.jsonl` ([ADR-0004](docs/adr/0004-session-data.md)).
- Catalog items: pin to a commit SHA or release asset with sha256; never run upstream install scripts ([ADR-0005](docs/adr/0005-catalog-trust-model.md)).
- Sidecar: stdout carries protocol frames only; logs go to stderr ([ADR-0003](docs/adr/0003-agent-runtime-and-ipc.md)).
- Branding: never use "Claude Code" in product names, icons or window titles.
- Don't copy code from AGPL projects (opcode, Claude Squad).
- Docs are written in English. Mark unverified external facts **(verify)** and link sources.

## Commands

Prerequisites:
- Node 24 (`.node-version`) and pnpm 11 (`packageManager`).
- Rust stable via rustup (`rust-toolchain.toml`), with `~/.cargo/bin` on PATH.
- The [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/).

| Task | Command |
|---|---|
| Install | `pnpm install` (once per clone: `pnpm hooks:install` for the pre-commit hook) |
| Run the desktop app (dev, hot reload) | `pnpm dev` |
| Lint + format check (Biome, what CI runs) / auto-fix | `pnpm lint` / `pnpm format` |
| Build the desktop app (installers) | `pnpm build` |
| Fast debug build, no installers | `pnpm --filter @agentchainer/desktop tauri build --debug --no-bundle` |
| Build the sidecar single executable (Node SEA; needed before `cargo clippy/test`, done automatically by `pnpm dev/build`) | `pnpm --filter @agentchainer/sidecar build:sea [--force]` |
| Packaged sidecar smoke: first-run SDK download + verify, then cache | `node scripts/sidecar-smoke.mjs` |
| Re-pin the Agent SDK after bumping it (updates `sdk-pin.json` from the lockfile) | `node packages/sidecar/scripts/pin-sdk.ts` |
| Regenerate the protocol JSON Schema after changing `packages/protocol/src/index.ts` | `pnpm --filter @agentchainer/protocol export-schema` |
| Typecheck all TS packages | `pnpm typecheck` |
| Rust check / lint / format | `cargo check --workspace` · `cargo clippy --workspace` · `cargo fmt --all` |
| Sidecar one-shot check (JSON-RPC over stdio) | `echo '{"jsonrpc":"2.0","id":1,"method":"system.hello","params":{"protocolVersion":2}}' \| node packages/sidecar/src/main.ts` |
| Unit tests, all packages (Node's built-in runner) / with coverage | `pnpm test` / `pnpm test:coverage` |
| Rust tests | `cargo test --workspace` |
| Spike harness: real model calls with your own `claude` login (haiku, a few cents) | `node packages/sidecar/scripts/spike-host.ts --cwd <empty scratch dir> [--scenario basic\|mode\|interrupt\|guard\|auto\|subagents\|sessions\|approvals\|plan\|fixtures\|image\|all] [--record raw.jsonl]` |
| M1 exit criteria E1–E5 on `fixtures/sample-app` (real model calls; a few cents to ~$0.30) | `node packages/sidecar/scripts/spike-host.ts --cwd <empty dir> --scenario exit` |
| Triage benchmark (M3-E1): agreement with the labeled tiers in `test/triage-benchmark.json` (haiku, ~$0.02; `--signals-only` makes no model calls) | `node packages/sidecar/scripts/benchmark-triage.ts [--signals-only] [--draft]` |
| A task end to end over JSON-RPC on a fixture copy: draft, approve, run, gates, exit codes re-checked by hand, the evidence report checked against the recorded gate runs; XL also splits, merges and cleans its worktrees up (real model calls; S with haiku ≈$0.01, M or L with the Opus review ≈$0.15–0.20) | `node packages/sidecar/scripts/live-task.ts [--fixture sample-app] [--request "…"] [--tier S\|M\|L\|XL] [--accept "<reason>"] [--print-evidence]` |
| Re-download every pinned git source in `catalog/` and check its sha256 (network) | `node packages/sidecar/scripts/verify-catalog-sources.ts` |
| Validate `catalog/` and compile the snapshot the app ships, the skills and the task library (after changing catalog items, profiles, `catalog/workflows/` or `agents/`) | `node packages/sidecar/scripts/build-catalog.ts` |
| Regenerate the detector/audit/plan snapshots of `fixtures/` after changing detection, the plan or the catalog | `UPDATE_SNAPSHOTS=1 node --test packages/sidecar/src/detect/detect.test.ts packages/sidecar/src/bootstrap/plan.test.ts` |
| Regenerate the event snapshots the UI tests replay, after re-recording a fixture | `UPDATE_FIXTURES=1 node --test packages/sidecar/src/normalize.test.ts` |
| Turn a raw recording into a committable fixture (fails if anything identifying survives) | `node packages/sidecar/scripts/make-fixture.ts raw.jsonl packages/sidecar/test/fixtures/<name>.jsonl --cwd <recording workspace>` |
| Plugin/MCP install spike (installs and removes again, in a throwaway project) | `node packages/sidecar/scripts/spike-install.ts --cwd <empty scratch dir>` |
| Release asset script tests (collect, SHA256SUMS, latest.json) | `node --test scripts/release-assets.test.mjs` |
| Launch smoke test (after a debug build) | `node scripts/smoke-launch.mjs target/debug/agentchainer [--seconds N]` |
| Streaming latency + CPU self-test (after a debug build; one real haiku turn, opens a window briefly) | `node scripts/selftest-latency.mjs --cwd <empty scratch dir> [--resume]` |

CI (`.github/workflows/ci.yml`) runs on every PR and on pushes to `main`. Actions are pinned by commit SHA, so keep the
`# vX.Y.Z` comment next to each SHA when bumping.

Edits made by Claude in this repo are auto-formatted by the PostToolUse hook in `.claude/settings.json` (format only, no
lint fixes). `pnpm lint` is the gate. Tests use `node:test`; add Vitest only for DOM component tests.
Never commit a raw SDK recording: it contains local paths and account details. Only `make-fixture.ts` output goes into
`test/fixtures/`. PR titles must be Conventional Commits with checklist IDs; see `CONTRIBUTING.md`.
