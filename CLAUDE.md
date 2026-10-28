# AgentChainer — agent context

Open-source desktop app (Tauri v2 + React/TS + Node sidecar on the Claude Agent SDK) that makes repos agent-ready and
keeps agent work transparent and verified. **Current phase: M0 (foundations).** The monorepo scaffold exists; there are no agent features yet.

Layout:
- `apps/desktop`: Tauri app. `src/` is the React UI, `src-tauri/` is the Rust core.
- `packages/protocol`: IPC types.
- `packages/sidecar`: Node agent runtime.
- `docs/`: planning docs.

## Source of truth

- Scope and user stories: `docs/PRD.md`
- Design: `docs/ARCHITECTURE.md`
- Decisions: `docs/adr/`. Don't contradict an Accepted ADR; propose a new ADR instead (copy `docs/adr/0000-template.md`).
- Work plan: `docs/CHECKLIST.md` (task IDs like `M1-08`)
- Catalog rules: `docs/CATALOG.md`; risks: `docs/RISKS.md`; user auth guide: `docs/guides/AUTH_SETUP.md`

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
| Install | `pnpm install` |
| Run the desktop app (dev, hot reload) | `pnpm dev` |
| Build the desktop app (installers) | `pnpm build` |
| Fast debug build, no installers | `pnpm --filter @agentchainer/desktop tauri build --debug --no-bundle` |
| Typecheck all TS packages | `pnpm typecheck` |
| Rust check / lint / format | `cargo check --workspace` · `cargo clippy --workspace` · `cargo fmt --all` |
| Run the sidecar placeholder | `pnpm --filter @agentchainer/sidecar start` |

TS lint, format and test commands arrive with M0-08 / M0-09.
