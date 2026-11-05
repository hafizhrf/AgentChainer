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
- **Windows** (checked on Windows 11, 2026-10-31):
  - Use the MSVC Rust toolchain. With rustup's GNU default, the build fails with `dlltool.exe: program not found`:
    `rustup set default-host x86_64-pc-windows-msvc`, then `rustup default stable-x86_64-pc-windows-msvc`. You also
    need the Visual Studio Build Tools (C++ workload), as the Tauri prerequisites say.
  - Turn off `core.autocrlf` (`git config --global core.autocrlf false`). Git for Windows turns it on, and the tests'
    own temporary repos must keep LF text; CI does the same.
  - Put `C:\Program Files\Git\bin` on your PATH, so `sh` is found by the tests and by `scripts/smoke.sh` gates.
  - Turn on Developer Mode (`start ms-settings:developers`); one test creates a symlink, which Windows otherwise
    refuses.

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
6. **Changing a tier workflow (`catalog/workflows/`) or a role prompt (`agents/`)?** Run the eval benchmark with your
   own `claude` login, commit its report, and paste the report's summary into the PR description. CI fails until the
   committed report matches the changed files:
   ```bash
   node packages/sidecar/scripts/benchmark.ts --variant main:workflows-ref=origin/main --variant branch
   ```
   It costs about $1 per variant with haiku at N=3 and writes `packages/sidecar/test/evals/report.json` and `.md`. A
   role prompt change has no `main` variant yet (variants swap workflows and models only), so its report is a run of
   `branch` alone.

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
- **End-to-end tests** (`scripts/e2e/`, X-06) drive the debug app through `tauri-driver` on Linux and Windows: the
  setup check, opening a workspace, a setup fix applied and rolled back, the command palette and Settings. CI runs
  them in the Build & launch jobs. Locally:
  - **Linux:** install `webkit2gtk-driver`, then `cargo install tauri-driver --version 2.1.0 --locked`, and run
    `xvfb-run -a node scripts/e2e/run.mjs --binary target/debug/agentchainer`.
  - **Windows:** point `EDGEWEBDRIVER` at a folder with the `msedgedriver.exe` that matches your WebView2 runtime,
    and run `node scripts/e2e/run.mjs --binary target/debug/agentchainer.exe`. The run attaches to the app through
    WebView2's debugging port, which only debug builds open.
  - **macOS:** there's no WebDriver for WKWebView. Use the Docker image in `scripts/e2e/Dockerfile` for the Linux
    run, and [MANUAL_CHECKS.md](docs/guides/MANUAL_CHECKS.md) for macOS itself.

  A failing flow saves a screenshot and the app log in `e2e-artifacts/`.

  The same run checks accessibility (X-12, `a11y.e2e.mjs`). axe-core audits the main screens and dialogs in light and
  in dark against WCAG 2.1 A and AA, then keyboard-only flows check the palette, Tab order with focus rings, and focus
  staying inside a dialog.
  - **What fails:** a serious or critical violation fails the run.
  - **The report:** `e2e-artifacts/a11y-report.json` lists every violation by screen and theme, with the impact, the
    failing elements' selectors and axe's fix hint. It's in the CI job's artifact too. `blocking` is what failed the
    run.
  - **New screens:** when you add a screen or dialog, add an `audit("…")` for it.

  Last, the run starts the app again in the pseudo-locale (X-13, `i18n.e2e.mjs`), where every catalog message is
  accented and in ⟦brackets⟧. It fails on any visible text in the app's own chrome that didn't come from a catalog,
  and saves `pseudo-*.png` screenshots of the main screens.
- **The SDK and the CLI move fast.**
  - The weekly **Drift** workflow tries the newest of both and opens an issue when something the app relies on
    breaks (X-05).
  - When you bump the SDK, run `node packages/sidecar/scripts/pin-sdk.ts` and update the pin in
    [COMPATIBILITY.md](docs/COMPATIBILITY.md). The same goes for `MIN_CLAUDE_VERSION`. CI's
    `scripts/check-compatibility.mjs` fails until they match.
  - When the app starts running a new `claude` command or flag, add it to `packages/sidecar/src/cli-contract.ts`. Its
    test fails when a call in `installer.ts` is missing from it.

## Code style

- Biome formats and lints TypeScript, JSON, CSS and YAML (`pnpm format`). rustfmt and clippy cover Rust.

### Text in the UI

Every string a person reads goes through a catalog ([ADR-0011](docs/adr/0011-ui-text-catalogs.md), X-13), in English
and in Bahasa Indonesia.
- **Where:** `apps/desktop/src/i18n/locales/en/<area>.json`, in the area of the file you're editing: `app`, `session`,
  `panel`, `shell`, `home`, `graph`, `tasks`, `setup`, `workflows`, `menu`.
  - Keys are flat, `<area>.<component>.<purpose>`, e.g. `setup.plugins.searchPlaceholder`.
  - A key's prefix is its file's name.
- **How:**
  - `t("setup.plugins.searchPlaceholder")`, with `{{name}}` in the message for values.
  - `t(key, { count })` with two keys, `…_one` and `…_other`, for plurals.
  - `<Rich k="…" tags={{ code: (s) => <code>{s}</code> }} />` for a sentence with markup in it.
  - `i18n/format.ts` for money, counts, dates and durations.
- **Never call `t()` at module top level.** It must run after the locale is set. Exported label maps are getters, as
  in `options.ts`.
- **What stays English:**
  - text sent to Claude, in constants commented "sent to Claude";
  - code, commands and ids;
  - prose the sidecar or the Rust core returns.
- **What catches mistakes:**
  - `pnpm lint` fails on text between tags (`noJsxLiterals`).
  - `pnpm test` fails on a literal `label`, `title`, `placeholder` or `aria-label`, on an unused key, and on a key in
    the wrong file.
  - Running a debug build with `AGENTCHAINER_PSEUDO_LOCALE=1` shows anything you missed: it's the text without ⟦⟧.
- **Every key in every language:** a new English key needs its Bahasa Indonesia too (`locales/id/`), and
  `pnpm test` fails until it has one, with the same `{{values}}` and tags. Follow
  [TRANSLATING.md](docs/guides/TRANSLATING.md). If you don't speak Indonesian, say so in the PR and a maintainer
  adds it.
- **Adding a language:** see [TRANSLATING.md](docs/guides/TRANSLATING.md).
- Docs are in English. Mark unverified external facts **(verify)** and link sources.

## Reporting security issues

Please don't open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
