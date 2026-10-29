# Contributing to AgentChainer

Thanks for your interest! AgentChainer is pre-alpha (milestone M0). The design docs in [`docs/`](docs/) are the source of
truth, and [`docs/CHECKLIST.md`](docs/CHECKLIST.md) is the work plan.

## Before you start

- **Pick a checklist item.** Every change maps to a task ID such as `M1-08`. If your idea isn't on the checklist, open an
  issue first.
- **Read the relevant ADRs** in [`docs/adr/`](docs/adr/). Don't contradict an Accepted ADR in code. Propose a new ADR
  instead (copy [`0000-template.md`](docs/adr/0000-template.md)).
- **Non-negotiables:**
  - The app never implements or automates login, and never reads or stores credentials ([ADR-0002](docs/adr/0002-auth-and-branding.md)).
  - Session data goes through the SDK only ([ADR-0004](docs/adr/0004-session-data.md)).
  - Catalog items are pinned and previewed ([ADR-0005](docs/adr/0005-catalog-trust-model.md)).
  - No code copied from AGPL projects.

## Set up

Prerequisites:
- Node 24 and pnpm 11;
- Rust stable via rustup;
- the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/);
- the [Claude Code CLI](docs/guides/AUTH_SETUP.md), signed in with your own account.

```bash
pnpm install
pnpm hooks:install   # pre-commit: Biome on staged files, cargo fmt when Rust changed
pnpm dev             # run the desktop app with hot reload (builds the sidecar executable first, ~10 s once)
```

All commands are listed in [`CLAUDE.md`](CLAUDE.md#commands).

Troubleshooting:
- **`pnpm dev` fails with `failed to run 'cargo metadata'`**: Rust is installed but `cargo` isn't on your shell's
  PATH (rustup installed without changing your profile).
  - Fix it for every new terminal: `echo '. "$HOME/.cargo/env"' >> ~/.zshrc` (or `~/.bashrc`).
  - Fix it for the current one: `source "$HOME/.cargo/env"`.

## Making a change

1. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>` or `spike/<topic>`.
2. Keep the change focused, but group related checklist items into one PR rather than many tiny ones. CI builds on three
   operating systems, so each PR takes a few minutes.
3. Before pushing, run what CI runs:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
   ```
4. **PR title = commit message on `main`** (we squash-merge). Use
   [Conventional Commits](https://www.conventionalcommits.org/) and the checklist ID, e.g.
   `feat(sidecar): add env.check [M0-19]`. The `PR title` workflow checks this.
5. In the PR description, list the evidence for every checklist item you tick: test runs, spike write-ups, screenshots.
   Never claim a check passed that you didn't run.

`main` is protected: PRs only, CI must be green, linear history, no force pushes.

## Tests and fixtures

- Unit tests use Node's built-in runner (`node:test`) and live next to the code as `*.test.ts`.
- SDK behaviour is tested by replaying **recorded fixtures** (`packages/sidecar/test/fixtures/*.jsonl`):
  1. Record a raw stream with `spike-host.ts --record`.
  2. Convert it with `scripts/make-fixture.ts`. It strips local paths, usernames, hook output and account details, and
     refuses to write if anything identifying survives.
  3. **Never commit a raw recording.**
- Spike harnesses (`packages/sidecar/scripts/spike-*.ts`) make real model calls with **your own** Claude login. Use
  `--model haiku` and a scratch folder.

## Code style

- Biome formats and lints TypeScript, JSON, CSS and YAML (`pnpm format`). rustfmt and clippy cover Rust.
- Docs are in English. Mark unverified external facts **(verify)** and link sources.

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
