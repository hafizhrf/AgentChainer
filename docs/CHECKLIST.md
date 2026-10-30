# AgentChainer — Project Checklist

> The master work plan. Scope comes from the [PRD](PRD.md), design from [ARCHITECTURE](ARCHITECTURE.md), decisions from
> [ADRs](adr/), and risks from [RISKS](RISKS.md).

## How to use this checklist

- Every task has a **stable ID** (`M1-08`). Reference it in branch names, commits and PRs:
  `feat(sidecar): session runtime [M1-08]`.
- **Tick a box only with evidence.** Append a link to the PR, CI run or spike doc:
  `- [x] **M0-15** … — evidence: #42, docs/spikes/S1-sidecar-packaging.md`.
- Never tick a task on the strength of a check that was not actually run.
- A milestone is done when all its **exit criteria** are ticked. Tasks may move between milestones; IDs never change or get reused.
- New work gets the next free ID in its milestone. Decisions that are expensive to reverse also get an ADR.
- Spikes end with a write-up in `docs/spikes/Sx-<name>.md`: question, method, results (numbers), decision.

## Status overview

| Milestone | Release | Theme | Status |
|---|---|---|---|
| [M0](#m0--foundations--spikes) | — | Foundations & spikes | ◐ Exit criteria met. Owner items left: M0-01, M0-05, M0-07, M0-13, M0-14, M0-22 |
| [M1](#m1--agent-session-core-v01-a) | v0.1 | Agent session core | ◐ Built. Exit criteria wait for the UI click-through and the Windows/Ubuntu runs |
| [M2](#m2--workspace-bootstrap-v01-b) | v0.1 | Workspace bootstrap | ◐ Built. E1, E3, E4 pass; E2 (real repositories) deferred by the owner |
| [UX](#ux--product-design--ui-polish-before-r1) | v0.1 | Product design & UI polish (after M1/M2 work functionally) | ◐ Design system done; desktop shell, panels and setup page in place |
| [R1](#r1--v01-release) | v0.1 | Packaging & release | ◐ Pipeline, updater, security review and docs in place; publishing waits for M0-01 and M0-22 |
| [M3](#m3--adaptive-planner--task-contracts-v02) | v0.2 | Adaptive planner, contracts, evidence | ◐ S, M and L run, with gates, evidence and accepted risk (preview); XL and the exit runs left |
| [M4](#m4--agent-observability-v02v03) | v0.2–0.3 | Agent observability graph | ☐ Not started |
| [M5](#m5--git-workflow-pr--quality-gates-v03) | v0.3 | Git workflow, PRs, gates | ☐ Not started |
| [M6](#m6--deployment--workflow-canvas-v04) | v0.4 | Deploy adapters, workflow canvas | ☐ Not started |
| [M7](#m7--evals--analytics-v05) | v0.5 | Evals & analytics | ☐ Not started |
| [M8](#m8--multi-folder-workspaces--agent-fleet-proposed) | later | Multi-folder workspaces, agent fleet | ☐ Proposed (owner, 2026-10-30) |
| [X](#cross-cutting-tracks-ongoing) | all | Security, quality, compatibility, docs, a11y | ☐ Ongoing |

---

## M0 — Foundations & spikes

**Goal:** de-risk the stack and set up the repo, so every later milestone starts with CI, conventions and verified assumptions.

### Decisions

- [ ] **M0-01** Check the product name: GitHub org/repo, domain, npm scope and crates.io are free, and the name is policy-compliant
      (no "Claude Code" in name or icon; tagline "Powered by Claude"). → [ADR-0002](adr/0002-auth-and-branding.md)
- [x] **M0-02** Accept the license ([ADR-0006](adr/0006-license.md)), add `LICENSE` and `NOTICE`.
      — evidence: the owner chose Apache-2.0 (2026-10-28). `LICENSE` (SPDX text) and `NOTICE` added, `license` field set
      in every package and crate, and ADR-0006 is Accepted.
- [x] **M0-03** Check whether the Agent SDK's license or terms allow bundling its JS inside a distributed sidecar binary. Record
      the answer in [ADR-0003](adr/0003-agent-runtime-and-ipc.md); fallback is installing the SDK on first run ([R-11](RISKS.md)).
      — evidence: the SDK `LICENSE.md` ("All rights reserved", with use under Anthropic's legal agreements) and the
      [legal page](https://code.claude.com/docs/en/legal-and-compliance), which grants no redistribution right.
      **Decision:** don't bundle. Download the pinned SDK from npm on first run with an integrity check. Recorded in
      ADR-0003 and R-11.
- [ ] **M0-22** Owner asks Anthropic in writing (via [contact sales](https://www.anthropic.com/contact-sales)):
  - (1) May an open-source desktop app bundle the Agent SDK?
  - (2) Is a local GUI that drives the user's own unmodified, user-signed-in `claude` CLI through the Agent SDK
    acceptable with Pro/Max subscriptions?
  - Record the answer in ADR-0002 and ADR-0003 ([R-01](RISKS.md), [R-11](RISKS.md)).

### Repository & tooling

- [x] **M0-04** Create the GitHub repo, push these docs, and protect `main` (PR required, no force push or deletion,
      linear history). The "green CI required" part moves to M0-10, because there is no CI to require yet.
      — evidence: [repo](https://github.com/hafizhrf/AgentChainer), [ruleset `protect-main`](https://github.com/hafizhrf/AgentChainer/rules/26015160), initial commit `53421cf`
- [ ] **M0-05** Add issue/PR templates; labels `area/*`, `milestone/*`, `type/*`, `good first issue`; a GitHub Project board mirroring this checklist.
      Progress: PR template (evidence checklist) and bug/feature issue templates added. Remaining for the owner, in
      the GitHub UI: labels and a Project board.
- [x] **M0-06** Monorepo scaffold: pnpm workspaces (`apps/desktop`, `packages/sidecar`, `packages/protocol`) + Cargo workspace
      (`apps/desktop/src-tauri`). Layout per [ARCHITECTURE §11](ARCHITECTURE.md#11-planned-repository-layout).
      — evidence: branch `chore/m0-06-monorepo-scaffold`. On macOS x86_64 these pass: `pnpm install`, `pnpm typecheck`,
      sidecar runs on Node 24 type stripping, `cargo fmt --check`, `cargo clippy -D warnings`, `tauri build --debug`.
- [ ] **M0-07** Tauri v2 + React + Vite + TS (strict) app shell that opens a window on macOS, Windows and Ubuntu.
      Progress: on macOS x86_64 the debug build opens a 1280×800 window that shows "v0.1.0 · app shell", which comes from
      the `app_info` Rust command, so the UI ⇄ Rust IPC path works (confirmed visually by the owner). CI launch smoke
      (app alive after 15 s) passed on macOS, Windows and Ubuntu in
      [run 40645248278](https://github.com/hafizhrf/AgentChainer/actions/runs/40645248278). Tick once the uploaded
      screenshots confirm the window renders on all three.
- [x] **M0-08** Lint and format: decide Biome vs ESLint+Prettier; rustfmt; clippy with warnings denied; lefthook pre-commit;
      conventional commits (commitlint).
      — evidence: **Biome 2.6** (`biome.json`) lints and formats TS/JSON/CSS/YAML (Markdown and the lockfile excluded).
      `pnpm lint` runs `biome ci` in CI. rustfmt and clippy (`-D warnings`) were already in CI.
      Deviations, chosen for zero extra dependencies:
      - The pre-commit hook is a plain script in `.githooks/`, enabled with `pnpm hooks:install`. lefthook needs an
        install script, which pnpm 11 blocks by default.
      - commitlint is replaced by a **PR title** check (`.github/workflows/pr-title.yml`), because squash merges make the
        PR title the commit message on `main`.
- [x] **M0-09** Test runners: Vitest (TS), `cargo test` (Rust), coverage reports.
      — evidence: decision to **keep `node:test`** (zero dependencies, runs `.ts` natively on Node 24). Vitest is added
      only when DOM component tests are needed (M1).
      - CI runs `pnpm test:coverage` (Node's built-in coverage; ~98% of desktop and ~90% of sidecar lines touched by
        tests) and `cargo test --workspace` (first Rust test).
      - 26 TS tests in total.
- [x] **M0-10** CI (GitHub Actions): lint + typecheck + test on ubuntu/macos/windows; Tauri build with unsigned artifacts per OS
      on PRs; least-privilege `permissions:`; actions pinned by SHA. Then add the CI jobs as required status checks in
      the `protect-main` ruleset, with "require branches to be up to date".
      — evidence: `.github/workflows/ci.yml` (PR #3, extended since), green on every PR since. The owner added all 4 jobs as
      required status checks with "up to date" enforced, confirmed through the rules API (2026-10-28). Since then PRs
      can't merge before CI passes (PR #8).
- [x] **M0-11** Renovate or Dependabot. Pin the Agent SDK and group it for manual review.
      — evidence: Dependabot ran (cargo and npm update jobs) and opened PR #10 with a Conventional title, and its CI was
      green.
      - PR #10 bundled two **major** bumps (TypeScript 6→7, `@types/node` 24→26) in one group, so the config now groups
        only minor/patch updates and ignores `@types/node` majors (Node runtime is 24).
      - TypeScript 7 passed CI. Adopting it is a separate, deliberate PR.
- [x] **M0-12** Dogfood: update [`CLAUDE.md`](../CLAUDE.md) with real commands; `.claude/settings.json` hooks (format on edit);
      project skills for recurring work (e.g. `add-ipc-method`, `add-catalog-item`).
      — evidence: CLAUDE.md lists the real commands.
      - The `.claude/settings.json` PostToolUse hook formats every file Claude edits. It was exercised on itself while
        building this PR.
      - Finding: the hook must not apply lint fixes mid-edit. A `let` declared one edit before its reassignment was
        turned into a `const`, so the hook now only formats and sorts imports.
      - Project skill `.claude/skills/add-ipc-method`. `add-catalog-item` waits for the catalog (M2).
- [ ] **M0-13** Render-check all Mermaid diagrams in `docs/` on GitHub.
- [ ] **M0-14** Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (private vulnerability reporting enabled).
      Progress: all three files added. Reports go through GitHub's private advisories. Remaining for the owner: enable
      **Settings → Code security → Private vulnerability reporting**.

### Spikes

- [x] **M0-15** **S1 Sidecar packaging.**
  - Compile our sidecar code into a single executable **without the Agent SDK inside** (M0-03). Compare `@yao-pkg/pkg`
    and Node SEA.
  - First-run SDK fetch:
    - download the pinned `@anthropic-ai/claude-agent-sdk` tarball from the npm registry into the app data dir;
    - verify its sha512 integrity against the lockfile, then load it;
    - test offline, behind a proxy, and with a tampered tarball.
  - Run it as a Tauri `externalBin` on 3 OS, driving the user's installed `claude` via `pathToClaudeCodeExecutable`.
  - Record binary size and cold start.
  - Check PATH resolution: a macOS app started from Finder, and `%USERPROFILE%\.local\bin` on Windows.
  - Progress: see [S1 spike](spikes/S1-sidecar-packaging.md).
    - **Node SEA** chosen. pkg wasn't tried: SEA met every requirement without a third-party Node binary source.
    - Sidecar executable 117 MB; release `.app` 122 MB. Warm cold start 125–160 ms.
    - First-run SDK download + sha512 check + extract ~1.5 s, then cached. Tampered, offline and HTTP-error paths are
      unit-tested.
    - The **release app launched from Finder** (minimal PATH, no Node) downloaded the SDK, found `claude` in
      `~/.local/bin`, and completed a real turn.
    - — evidence (3 OS): the packaged sidecar smoke (start, SDK download + sha512 check, cache) passed on macOS
      (arm64 runner), Windows and Ubuntu in [run 40672012100](https://github.com/hafizhrf/AgentChainer/actions/runs/40672012100).
    - Windows `%USERPROFILE%\.local\bin\claude.exe` discovery is unit-tested (the S6 CI found and fixed npm's
      `claude.cmd` case on a real Windows runner).
    - Moved on: the proxy test goes to X-14. A signed-in Windows session is covered by the M1 exit scenarios on 3 OS.
- [x] **M0-16** **S2 Event stream.** Run a streaming-input `query()`, forward SDK messages through Rust to React, and measure
      end-to-end delta latency and CPU with partial messages on.
  - — evidence: self-test mode plus `scripts/selftest-latency.mjs`, two runs (haiku, macOS x86_64).
    - Sidecar → Rust → UI delta latency: **p50 1 ms, p95 2–3 ms, max 4–16 ms** over 72 and 196 deltas.
    - CPU while streaming: app ~2–3%, sidecar ~1.4–1.9%, `claude` ~6–9% average.
    - RSS: app ~59 MB, sidecar ~86 MB, `claude` ~210–290 MB.
  - Time to first delta (2–3 s) is the model's. Delta coalescing is not needed at these rates.
  - Not measured: WebView render cost (its processes aren't children of the app on macOS).
  - See [S2/S3 spike](spikes/S2-S3-chat-slice.md).
- [x] **M0-17** **S3 Permissions.**
  - Round-trip `canUseTool` and a `PreToolUse` hook to a UI modal.
  - Exercise `interrupt()` and a mid-session `setPermissionMode()`.
  - Document which calls bypass `canUseTool`.
  - — evidence: [S2/S3 spike](spikes/S2-S3-chat-slice.md), PR #5.
    - The spike harness passes 11/11 checks against the real CLI:
      - `canUseTool` allow and deny;
      - mid-session `setPermissionMode()`, including `auto`;
      - `interrupt()` stops a tool in 20–35 ms; an interrupt while idle is ignored;
      - the `PreToolUse` guard blocks before any prompt, in every mode.
    - 10 guard unit tests run in CI.
    - The owner exercised the approval dialog and mode switcher in the app on a real repo (2026-10-28).
  - Not separately exercised in the app: the Stop button. The `session.interrupt` RPC behind it is covered by the harness.
  - Read-only commands such as `echo` bypass `canUseTool`.
- [x] **M0-18** **S4 Subagent attribution.**
  - Capture `parent_tool_use_id`, `agent_id`, the `SubagentStart/Stop` hooks and `forwardSubagentText`.
  - Build an agent tree for a prompt that spawns 2 parallel subagents.
  - Save the stream as the first recorded fixture.
  - — evidence: [S4 spike](spikes/S4-S5-S6.md#s4--subagent-attribution-and-agent-tree), fixture
    `packages/sidecar/test/fixtures/subagents-parallel.jsonl` (sanitized, with a leak check), 3 replay tests in CI.
  - The tree is built from `system/task_*` messages; the `SubagentStart/Stop` hooks aren't needed.
- [x] **M0-19** **S5 Install & auth detection.**
  - Run `claude --version` and `claude auth status --json` across these states: not installed, too old, logged out,
    subscription, Console, `ANTHROPIC_API_KEY`, Bedrock/Vertex env.
  - Confirm no secret values appear in the output.
  - Set `MIN_CLAUDE_VERSION`.
  - — evidence: [S5 spike](spikes/S4-S5-S6.md#s5--install-and-auth-detection), `env.check` RPC with readiness UI,
    6 unit tests (the email never survives parsing). `MIN_CLAUDE_VERSION` = 2.1.293.
  - States covered:
    - real runs: subscription, logged out, API key, Bedrock, not installed;
    - unit test: too old.
  - Not tested: Console (no account); Vertex (same `third_party` path as Bedrock).
- [x] **M0-20** **S6 Plugin & MCP install.**
  - From the sidecar on 3 OS, run non-interactively: `claude plugin marketplace add`, `claude plugin install … --scope project -y --json`,
    `claude plugin uninstall`, `claude mcp add --scope local`.
  - Find out whether plugin versions can be pinned.
  - Progress: 6/6 on macOS ([S6 spike](spikes/S4-S5-S6.md#s6--plugin-and-mcp-installs-non-interactive)):
    - project-scope plugin install and uninstall with no TTY and no `-y`;
    - MCP add/remove at local and project scope.
  - Versions **can't be pinned**; the installed version is read from `plugin list --json` for the lockfile.
  - — evidence (3 OS): `.github/workflows/s6-install.yml` installs Claude Code **2.1.293** (= `MIN_CLAUDE_VERSION`)
    from npm on fresh runners, adds the official marketplace, and runs the spike. 6/6 on macOS, Windows and Ubuntu in
    [run 40673510145](https://github.com/hafizhrf/AgentChainer/actions/runs/40673510145).
  - **Finding:** on Windows an npm install exposes only a `claude.cmd` shim, and `findClaude()` returned null. It now
    resolves the shim to `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (unit-tested). Without this, every
    npm-installed Windows user would have seen "Claude Code CLI not found".
- [x] **M0-21** Update [ADR-0003](adr/0003-agent-runtime-and-ipc.md) with the spike results: Accept, or switch to the fallback
      (Electron, or CLI `stream-json`).
      — evidence: ADR-0003 **Accepted** 2026-10-28 with S1/S2 numbers, and ADR-0001 records that the Electron fallback
      isn't needed ([S1](spikes/S1-sidecar-packaging.md), [S2/S3](spikes/S2-S3-chat-slice.md)).

### Exit criteria

- [x] **M0-E1** S1–S6 pass on macOS, Windows and Ubuntu, or have a documented workaround.
      — evidence:
      - S1 and S6 run in CI on all 3 OS.
      - S2–S5 need a signed-in Claude account, which CI runners don't have, so they were run on macOS. They exercise
        the same SDK, CLI and sidecar that the 3-OS CI covers.
      - **Workaround:** the M1 exit scenarios (M1-E1…E6) are run by hand on macOS, Windows and Ubuntu.
- [x] **M0-E2** ADR-0001 through ADR-0005 are Accepted. — evidence: 0001, 0002, 0004 and 0005 were Accepted at planning;
      0003 was accepted after S1/S2 (M0-21).
- [x] **M0-E3** CI is green on all 3 OS for the app shell. — evidence: every PR since #3 is green on macOS, Windows and
      Ubuntu (e.g. [run 40647229719](https://github.com/hafizhrf/AgentChainer/actions/runs/40647229719)), and CI checks
      are required on `main`.

---

## M1 — Agent session core (v0.1-A)

**Goal:** a reliable, transparent agent session on a local workspace. → PRD [F1](PRD.md#f1--agent-session-core-p0)

### App shell & onboarding

- [x] **M1-01** Sidecar supervisor (Rust): spawn, health ping, restart with backoff, crash log; `system.hello` handshake.
      — evidence: `sidecar.rs` supervisor and a backoff unit test.
      - Exponential backoff 0.5 s → 30 s, reset after 60 s of uptime.
      - Crash log of the last 200 stderr lines in the app log dir.
      - `sidecar_restart` command; `sidecar://exit` and `sidecar://ready` events.
      - The UI pings `system.ping` every 20 s (5 s timeout → restart) and re-handshakes on ready.
      - Verified: `kill -9` on the running sidecar → crash log written → new sidecar ready → UI banner "The agent
        runtime restarted" with readiness re-checked.
- [x] **M1-02** `packages/protocol`: zod schemas → JSON Schema → generated TS + Rust types; validation on both ends; version errors.
      — evidence:
      - zod 4 schemas for every method and notification, with TS types inferred from them.
      - The sidecar validates params **and** its own results (`dispatch` tests: invalid params −32602, unknown method,
        contract-breaking result −32603).
      - The UI validates every result and notification.
      - `schema/protocol.schema.json` is exported, and a test fails while it's stale.
      - `system.hello` rejects a protocol-version mismatch (−32005) on both ends.
      - No Rust types: the core only relays frames (ADR-0003), so generating them would add code nobody reads.
- [x] **M1-03** Environment resolver: login-shell env (macOS/Linux), `claude` discovery (settings → PATH → known locations),
      version check. → [ARCHITECTURE §3](ARCHITECTURE.md#3-locating-claude-and-the-users-environment)
      — evidence:
      - `shell_env.rs` runs `$SHELL -ilc` with a 5 s timeout and a marker, so shell banners are ignored. Values are never
        logged. 3 unit tests.
      - `findClaude()` order: `AGENTCHAINER_CLAUDE_PATH` setting → PATH → known locations (incl. the Windows npm shim).
      - Verified: the app started with `env -i` (PATH `/usr/bin:/bin`, no node) still found node and `claude` through
        the login shell and completed a self-test turn.
- [x] **M1-04** Health-check screen covering git, `claude` (installed, version ≥ minimum), auth state, and Git for Windows on Windows.
      Each failing item links to its fix.
      — evidence: `Readiness.tsx` on `env.check` (S5), re-run after every runtime restart.
      - Every failing row shows its fix command (install per OS, `claude update`, `claude auth login`, install git).
      - On Windows the git row is the Git for Windows check.
- [ ] **M1-05** Onboarding tutorial that renders [AUTH_SETUP](guides/AUTH_SETUP.md) for the user's OS. Copy buttons,
      "Open terminal", "Re-check". The app never handles credentials.
      Progress: the key steps render inline for the user's OS, with Copy buttons, Open terminal (`open_terminal`
      command) and Re-check. Remaining: render the full guide in-app (UX-06) and check Open terminal by hand on each OS.
- [ ] **M1-06** Workspace picker: open folder, recent list, multiple workspaces as tabs. If the folder isn't a git repo, offer `git init`.
      Never default to, and warn on, the home folder: in owner testing the agent then roamed the whole home directory.
      Progress: native folder picker (`tauri-plugin-dialog`), recent list (settings), no default folder plus a
      home-folder warning, one session per tab across any number of workspaces (background tabs keep streaming; a dot
      marks a tab waiting for approval). `git init` is offered on the start screen and in the session sidebar when the
      folder isn't a repository (`workspace.gitInit`, unit-tested). Remaining: click through tabs and `git init` in the
      app.
- [ ] **M1-07** Settings stored in the app DB (no secrets): Claude CLI path, default model, effort, permission profile, budget cap, theme.
      Progress:
      - `settings.json` in the app config dir, with atomic writes, normalization and 2 unit tests.
      - Covers the Claude CLI path (restarts the runtime on change), default model, default permission mode, and recent
        workspaces.
      - Also the external editor for "Open in editor" (M1-28).
      - Remaining: effort, budget cap (with M1-32), theme. SQLite arrives with session and cost history (M1-21/M1-33).

### Chat & streaming

- [x] **M1-08** Session runtime: one streaming-input `query()` per session with the options in
      [ARCHITECTURE §5.1](ARCHITECTURE.md#51-session-runtime).
      — evidence:
      - Protocol v2: one sidecar runs many sessions, keyed by SDK session id; notifications carry it.
      - The sidecar picks a new session's id up front (`sessionId` option).
      - Options set: `enableFileCheckpointing`, explicit `settingSources` (user, project, local), effort and
        `maxBudgetUsd` from settings.
      - Verified live with `spike-host`:
        - `--scenario sessions`: two sessions answer in parallel without mixing replies.
        - `--scenario plan`: a $0.0001 cap ends the turn with `error_max_budget_usd`; `setModel` and `setEffort`
          apply mid-session.
      - Design change: no `PostToolUse` change tracker. The changes panel derives agent edits from the transcript and
        adds git status, which also catches Bash edits (M1-26).
- [x] **M1-09** Event normalizer: SDK messages → `AgentEvent` ([§5.2](ARCHITECTURE.md#52-normalized-events)), with a recorded
      fixture for every event type.
      — evidence:
      - `test/fixtures/turn-basics.jsonl` was recorded with `spike-host --scenario fixtures` and sanitized by
        `make-fixture.ts`. It holds summarized thinking, a Write call, the reply, and an `error_max_budget_usd` result.
      - Together with `subagents-parallel.jsonl`, a test checks that every event the normalizer emits appears in a
        recording.
      - `user.message` (from `session.history`) and `error` (from the session runtime) don't come from SDK stream
        messages. They are covered by `stored-sessions.test.ts` and the runtime.
      - Finding: without a thinking display mode, the CLI streams thinking with empty text. The app now asks for
        adaptive thinking with the summarized display (a setting, on by default).
- [ ] **M1-10** Message list: streaming markdown, collapsible thinking, virtualized for long sessions.
      Progress:
      - The main agent's thinking streams into a collapsed "Thinking" block (`thinking.delta`).
      - Assistant text renders as GitHub-flavored markdown (react-markdown + remark-gfm). Raw HTML is dropped, links
        open in the browser (http/https only), and images show as text, so model output can't load anything.
      - Long sessions render the latest 200 items, with "Show earlier".
      - Remaining: look at it in the app; code highlighting is UX-04.
- [ ] **M1-11** Tool-call cards (Read, Edit, Write, Bash, Grep, Glob, WebFetch, MCP):
  - status, duration, collapsible input and output;
  - Edit and Write show an inline diff.
      Progress: live calls show their duration; Edit, MultiEdit and Write show an inline line diff with +/− counts
      (`textdiff.test.ts`); "Open in editor" on file tools. Remaining: look at them in the app.
- [ ] **M1-12** Subagent calls shown inline as nested cards. The full graph comes in M4.
- [ ] **M1-13** Composer:
  - multiline input; @file mention with fuzzy search; image paste;
  - `/` palette for skills and commands (from session init);
  - queued follow-ups while a turn is running.
      Progress: messages sent during a turn queue and go out one by one after each successful turn (removable,
      "Clear queue"); `@` suggests workspace files and `/` the session's slash commands, fuzzy-matched
      (`fuzzy.test.ts`). Remaining: image paste; click through in the app.
- [ ] **M1-14** Interrupt (Esc or Stop button) and "stop after this turn".
      Progress: Esc and Stop interrupt (live-verified in spike S3); Esc in a dialog or the `@`/`/` picker doesn't.
      "Stop after this turn" is "Clear queue": nothing more goes out after the running turn. Remaining: try in the app.
- [ ] **M1-15** Switcher for model, effort and permission mode; mid-session mode switch via `setPermissionMode()`.
      Progress: profile, model and effort selects in the composer. `session.setModel` (verified live: the next turn
      runs on Sonnet), `session.setEffort` (`applyFlagSettings`), defaults in Settings. Remaining: try in the app.
- [ ] **M1-16** Plan-mode UX: render the proposed plan with "Approve & execute", "Revise" and "Reject".
      Progress: ExitPlanMode opens a plan review with the plan text (`input.plan`), the mode to execute in, and
      Approve & execute / Revise (with feedback) / Reject. Verified live (`spike-host --scenario plan`): one prompt,
      then the plan runs in the chosen mode without further edit prompts. Remaining: click through in the app.

### Permissions

- [ ] **M1-17** Approval modal driven by `canUseTool`:
  - shows the tool, the agent (main or subagent) and the input, which is editable;
  - options: allow once, always for this project, deny with a message to the agent.
      Progress: the dialog shows title, reason, path, the asking agent and the input (editable as JSON); "Always
      allow" lists the rule it saves. Verified live (`spike-host --scenario approvals`, 5/5): always-allow saves a
      rule and the next call doesn't ask, edited input is what runs, deny blocks and the agent sees the message.
      Since UX-05 the dialog also shows a plain-language view and a risk level. "Always allow" saves for the session,
      for this user, or for the team (`.claude/settings.json`). Remaining: click through in the app.
- [ ] **M1-18** Permission profiles Safe / Standard / Autonomous ([ARCHITECTURE §6](ARCHITECTURE.md#6-permissions)).
      Check auto-mode availability per account type. `auto` works on the owner's account (spike S3).
      Explain each mode in the UI, because owner testing showed "auto-accept edits" being read as "auto mode" (Bash
      still asks in `acceptEdits`).
      Progress: the mode select is now the profile select (Safe = `default`, Standard = `acceptEdits`, Autonomous =
      `auto`, plus Plan first), with an explanation of each. Autonomous needs a budget cap. Remaining: auto-mode
      availability on other account types; profile-specific allowlists come with the WorkspaceProfile (M2).
- [x] **M1-19** `PreToolUse` guard: a hard denylist that applies in every profile and shows the reason for each block.
      — evidence:
      - Rules in `guard.ts`, covered by `guard.test.ts`.
      - Live in spike S3 (`spike-host --scenario guard` and `auto`): blocked before any prompt, in the default and
        auto modes.
      - The tool card names the guard and shows its reason.
- [ ] **M1-20** "Always allow" rules go to `.claude/settings.local.json` and can be viewed and removed in a Permissions panel.
      Progress: "Always allow" saves the CLI's suggested rules with destination `localSettings`; **Workspace settings →
      Permissions** lists and removes them (`permissions.list/remove`, which touch only the `permissions` lists). It
      was a right-panel tab until the owner's 2026-10-29 notes. Verified live (`--scenario approvals`). Remaining:
      click through in the app.

### Sessions & checkpoints

- [ ] **M1-21** Session list per workspace via the SDK, showing title, last activity and cost; rename, tag, delete.
      Progress: `session.list/rename/tag/delete` on the SDK session APIs, shown on the new-session screen with title,
      last activity, git branch and tag. Deleting an open session is refused (−32006). Verified live by
      `spike-host --scenario sessions`. Each session's cost now comes from the local cost history (M1-33).
      Remaining: look at it in the app.
- [x] **M1-22** Resume and fork. Sessions started in the terminal CLI appear in the list and can be resumed.
      — evidence:
      - `spike-host --scenario sessions`: a closed session resumes with the same id and remembers the conversation;
        `session.fork` copies it under a new id.
      - A session made with `claude -p` in a scratch folder is listed, its history replays, and it resumes with the
        same id and remembers its earlier reply.
      - `scripts/selftest-latency.mjs --resume` drives the app's own resume path: history renders, then a second turn
        succeeds in the resumed tab.
      - Ended tabs (runtime restart, CLI exit) keep their transcript and offer "Resume session".
- [ ] **M1-23** File checkpoints: "Rewind files to here" on a user message, with the documented limits shown.
      Progress: `session.rewind` with dry-run preview; the UI lists the files and the limits before restoring.
      Verified live by `spike-host --scenario sessions`: restore to before a message, delete a file created after it,
      and rewind after close + resume. Remaining: click through the dialog in the app.
- [ ] **M1-24** Retention notice: show `cleanupPeriodDays` (default 30) and explain how to change it.
      Progress: `session.retention` reads only `cleanupPeriodDays` through the SDK's `resolveSettings` (default 30
      when unset; verified live). The session list shows it with how to change it. Remaining: see it in the app.

### Files, diff, terminal

- [ ] **M1-25** File tree with git status badges, updated live by a file watcher.
      Progress: `workspace.files` (git `ls-files` + `status --porcelain -z`, subfolder workspaces, non-git folders
      walked with a cap) and the Rust `notify` watcher. Tested against real repos and folders (sidecar `workspace.test.ts`,
      Rust `watcher` tests). Remaining: look at the tree in the app on each OS.
- [ ] **M1-26** Changes panel: files changed per turn and per session.
      Progress: "Edited by the agent" groups Edit/Write/MultiEdit/NotebookEdit calls by user turn (subagents
      included; `files.test.ts`), next to everything git sees as changed (which also covers Bash edits). Remaining:
      look at it in the app.
- [ ] **M1-27** Monaco diff viewer; revert a file or a hunk (via git), with confirmation.
      Progress: Monaco bundled locally and lazy-loaded; `workspace.diff` / `workspace.revert` tested on a real repo
      (hunk revert leaves other hunks, new files deleted, staged renames undone, binary files flagged). Confirmation
      dialogs before every revert. The diff no longer jumps back to the top while scrolling: listing and diff calls
      never write `.git/index` (`--no-optional-locks`, plumbing `diff-index`; regression test in
      `workspace.test.ts`), so a refresh can't trigger another through the file watcher; an unchanged listing keeps
      its object (`sameListing`), and the diff keeps its scroll position and folds when the text does change.
      Clicked through on macOS (2026-10-30, debug build): a scrolled 300-line diff stays put while idle, and
      `.git/index` keeps its mtime. Remaining: revert a hunk and a file in the app.
- [ ] **M1-28** "Open in editor" at `file:line` (VS Code, Cursor, JetBrains, system default).
      Progress: `open_in_editor` for VS Code, Cursor, Zed, IntelliJ (`idea`) and the system default, from the diff
      pane and tool cards; editor chosen in Settings. Argument building is unit-tested. Remaining: try each editor.
- [ ] **M1-29** Integrated terminal (xterm.js + portable-pty), scoped to the workspace.
      Progress: one terminal per tab in the workspace folder, the user's login shell (PowerShell on Windows). A Rust
      test runs a real shell through the PTY (command → output → resize → close). Remaining: use it in the app on
      each OS.

### Git basics

- [ ] **M1-30** Git panel using system git:
  - branch indicator, switch and create;
  - stage and unstage; commit with an AI-drafted message the user edits; push;
  - never force-push.
      Progress:
      - The sidebar's Git tab has a branch switcher with ↑/↓ counts, create, stage/unstage per file or all, commit,
        and push / publish branch behind a confirmation.
      - The branch picker also lists remote branches (checked out as tracking branches), and each branch has a ⋯ menu:
        merge into the current branch, rename, delete (an unmerged branch only after a second confirm). Fetch
        (`--all --prune`) and pull (fast-forward only) sit next to it. A merge with conflicts stays in progress with a
        banner and Abort. Tested on real repos with a bare remote (`git.test.ts`, 7 cases), and end to end over
        JSON-RPC on a scratch repo.
      - Tested on real repos with a bare remote (`git.test.ts`): staging before the first commit, commits, a new
        branch pushed with tracking, and a diverged push that fails instead of overwriting the remote. No code path
        passes `--force`.
      - "Draft with Claude" is a one-shot haiku query: no tools, no settings, not saved as a session. Live: a
        Conventional Commits message in 3.6 s, and no session left behind.
      - Clicked through on macOS (2026-10-30, debug build): remote checkout with tracking, fetch, pull, merge with a
        conflict then Abort, rename, and delete with the unmerged second confirm. The ⋯ was first a dropdown nested
        in the picker's popover, which closed both; it's now an actions view inside the picker. A conflicted file no
        longer counts as staged.
      - Remaining: commit and push in the app.

### Cost & limits

- [ ] **M1-31** Cost, tokens and duration per turn and per session, taken from `result` (`total_cost_usd`, `modelUsage`)
      and labeled "estimate".
      Progress: the status bar shows the last turn's cost, duration and tokens and the session total, all derived
      from running totals (`tabs.test.ts`; usage verified live). Remaining: look at it in the app.
- [ ] **M1-32** Budget cap (`maxBudgetUsd`) per session, with a warning at 80%.
      Progress: per-session cap from Settings; verified live (`error_max_budget_usd`). The 80% warning and the
      "cap reached" notice are unit-tested; resumed sessions only get the SDK's stop, since their earlier spend
      isn't known. Remaining: see it in the app.
- [ ] **M1-33** Local cost history per workspace.
      Progress:
      - SQLite (`rusqlite`, bundled) in the app data dir: one row per completed turn (`history.rs`, 3 tests).
      - A turn whose own cost the UI doesn't know (the first after a resume) gets it from the session's previous
        recorded total.
      - Verified in the app: the resume self-test wrote 2 turns, both with known costs.
      - The session list shows each session's cost and the folder's spend today / 7 / 30 days.
      - Remaining: look at it in the app.

### Quality

- [x] **M1-34** UI tests driven by recorded fixtures through a fake transport. No live API calls in CI.
      — evidence:
      - The UI's RPC client takes its transport as a parameter (`rpc-client.ts`); the app passes the Tauri one.
      - `rpc-client.test.ts` replays the normalizer's output for both recordings through a fake sidecar: the
        `*.events.json` snapshots, kept current by a sidecar test.
      - Through the client's validation and the tab reducers, it checks the real transcript: thinking, a timed Write
        card, the reply, cost and tokens, the budget-cap error, and nested subagent cards. Malformed and unknown
        frames are dropped, and error codes are mapped.
      - CI runs only `pnpm test`, with no model calls.
- [ ] **M1-35** Diagnostics: structured logs (Rust `tracing`, sidecar stderr) and an "Export diagnostics" bundle with secrets redacted.
      Progress:
      - `agentchainer.log` in the app log dir, one JSON object per line, rotated at 5 MB. It holds core supervisor
        events and the sidecar's stderr, and was written in the app run.
      - A small logger instead of `tracing`: one file, no extra dependencies.
      - Settings → "Export diagnostics…" writes one JSON file:
        - versions, OS, settings, the readiness check;
        - the last 500 log lines and up to 5 crash logs.
      - Everything is redacted first: the home folder becomes `~`, and API keys, tokens, bearer headers, passwords
        and emails are masked (`diagnostics.rs` tests).
      - Remaining: export from the app.

### Exit criteria

All of these run on macOS, Windows and Ubuntu against a sample repo in `fixtures/`:

- Sample repo: `fixtures/sample-app`. `total()` ignores quantities, so `node --test` fails.
- `spike-host --scenario exit --cwd <empty dir>` runs E1–E5 against the sidecar with your own login, including a
  real sidecar restart for E2.
- **macOS: E1–E5 pass**, 8/8 checks on CLI 2.1.293 with haiku:
  - E1: approvals for Bash, Edit, Bash; one hunk reviewed; committed.
  - E3: the file is back to the seeded bug.
  - E4: stopped 24 ms after the interrupt.
  - E2: after the restart, the agent named the fixed file.
  - E5: ExitPlanMode approved, then executed with a subagent; the tests pass.
- **Windows 11: E1–E5 pass**, 8/8 checks on CLI 2.1.314 with haiku (2026-10-30, `pnpm dev` checkout):
  - The first run failed E5 (7/8): CLI 2.1.314 runs Agent-tool subagents in the background by default, so the turn
    ended before the subagent wrote the test. The sidecar now turns background tasks off for every `query()`
    ([S4 update](spikes/S4-S5-S6.md)).
  - After that change: E1 approvals for Bash, Edit, Bash and a commit; E3 back to the seeded bug; E4 stopped 18 ms
    after the interrupt; E2 named the fixed file after the restart; E5 ExitPlanMode approved, then a foreground
    subagent, tests pass. `--scenario subagents`: 2/2, no async launch.
- Still to do: the same run on Ubuntu; E6 by hand on each OS (never automated: it would mean signing the user out);
  and the UI click-through of the same flows.

- [ ] **M1-E1** Fix a seeded bug with tool approvals in the Safe profile, review the diff, commit.
- [ ] **M1-E2** Quit the app mid-session, relaunch, resume, and continue the conversation.
- [ ] **M1-E3** Rewind files to an earlier message; the working tree matches that point.
- [ ] **M1-E4** Interrupt a long-running Bash call; the session stays usable.
- [ ] **M1-E5** Plan mode → approve → execute, with a subagent card shown during execution.
- [ ] **M1-E6** Starting logged out, the onboarding gets the user to a working session without the app touching credentials.

---

## M2 — Workspace bootstrap (v0.1-B)

**Goal:** make any repo agent-ready in minutes, with every change previewed, verified and reversible.
→ PRD [F2](PRD.md#f2--workspace-bootstrap-p0) · [CATALOG](CATALOG.md) · [ADR-0005](adr/0005-catalog-trust-model.md)

### Catalog

- [x] **M2-01** JSON Schema for catalog items and profiles ([CATALOG §3](CATALOG.md#3-item-schema)); CI validates `catalog/`.
      — evidence:
      - The zod schemas in `src/catalog/schema.ts` are exported as `catalog/schema.json`.
      - Checks beyond the schemas: unique ids, `<id>.yaml` file names, profile references, first-party/plugin source
        rules, and full commit SHAs only.
      - `build-catalog.ts` compiles the snapshot.
      - `plan.test.ts` fails in CI when `catalog/` is invalid or the compiled files are stale.
- [x] **M2-02** Seed the items from [CATALOG §6](CATALOG.md#6-seed-items) with pinned refs, CI-computed hashes and licenses.
      Review each one with the [§4 checklist](CATALOG.md#4-review-checklist-adding-or-updating-an-item).
      Progress:
      - 10 marketplace plugins are in `catalog/items/`, their names, versions and configs read from the official
        marketplace at `f8c5e7a`:
        - code-review, commit-commands, security-guidance;
        - the TypeScript, Python, Go and Rust LSPs;
        - context7, playwright, github.
      - Findings recorded in the items:
        - the playwright plugin runs `@playwright/mcp@latest`, unpinned;
        - github needs `GITHUB_PERSONAL_ACCESS_TOKEN`;
        - there is no Dart/Flutter LSP plugin.
      - `cloudflare-security-audit` is pinned to commit `c1c8a8c` with a tree sha256.
        - The `catalog-sources` workflow re-downloads every git source and checks its hash (CI-computed, §4).
        - A pre-review scan found no network calls in its scripts.
      - Release-asset and npm items added with the installer (M2-15):
        - gitleaks 8.30.1, actionlint 1.7.12 and codebase-memory-mcp 0.11.0, each with 5 platform assets;
        - playwright-mcp 0.0.83, pinned, which replaces the unpinned plugin in `web-testing`.
        - The `catalog-sources` workflow re-downloads every asset, checks its sha256 against the catalog and GitHub's
          digest, and checks npm integrity. Run locally: all 16 pins match.
      — evidence: [the first maintainer reviews](catalog-reviews/2026-10-30.md) (PR #34). Merging that PR is the
      owner's sign-off.
      - 11 items are approved, several with corrected permissions: code-review, commit-commands, the four LSPs,
        context7, github, playwright-mcp (now `--isolated`), actionlint, gitleaks.
      - 4 are not approved:
        - security-guidance: an unpinned pip install at runtime, and spend outside the session's cost. It's out of
          `baseline`.
        - the playwright plugin: `@latest`.
        - cloudflare-security-audit: its MIT notice isn't copied (M2-29).
        - codebase-memory-mcp 0.11.0: security fixes are in 0.12.x.
- [x] **M2-03** Show trust tiers in the UI. Community items are never pre-selected or auto-applied.
      — evidence:
      - The plan review shows each item's tier (community in red).
      - The builder never pre-selects community items (`plan.test.ts`).
      - Auto-apply takes only first-party and official items (`auto-apply.test.ts`).
- [x] **M2-04** Upstream-update bot: a scheduled workflow that opens PRs bumping refs and hashes, with a diff summary.
      — evidence:
      - `scripts/check-catalog-updates.ts`, run by `.github/workflows/catalog-updates.yml` (weekly or on demand,
        clean under actionlint).
      - It bumps marketplace refs, git refs with a new tree hash, and release-asset and npm versions at least 14
        days old, with hashes from the downloads checked against GitHub's digests.
      - It clears reviews and writes a summary.
      - Only the changed values are rewritten.
      - Pure helpers are tested (`updates.test.ts`).
      - **Live:**
        - against today's catalog, everything is up to date;
        - against a copy with older pins (gitleaks 8.30.0, actionlint 1.7.11, codebase-memory-mcp 0.10.8,
          playwright-mcp 0.0.82, an older code-review commit), the bumped files came out byte-identical to the
          verified pins.
      - **Owner:** enable "Allow GitHub Actions to create and approve pull requests", or add `CATALOG_BOT_TOKEN`,
        before the first scheduled run.
- [x] **M2-05** Decide whether v0.1 ships a bundled catalog snapshot only, or can also fetch signed catalog updates from Releases.
      — evidence: [ADR-0007](adr/0007-catalog-distribution.md) (Proposed): a bundled snapshot only. The sidecar
      imports the compiled `catalog.json`; verified in the packaged executable, where `bootstrap.plan` answers from it.

### Detection & audit

- [x] **M2-06** Stack detector for the tier-1 stacks, monorepo-aware:
  - TS/JS: npm, pnpm, yarn, bun; framework hints such as Next, Vite, Express, Nest.
  - Python: uv, poetry, pip; framework hints such as Django, FastAPI, Flask.
  - Flutter/Dart.
  - Go.
      — evidence: `src/detect/detect.ts`, tested with `detect.test.ts` (19 tests).
      - Fixture repos per stack are snapshot-tested. Inline variants cover yarn, bun and poetry.
      - Monorepo support: pnpm/npm/yarn workspaces, `go.work`, Cargo workspaces, and combinations of them.
      - Dogfood: this repo scans as `pnpm-workspace+cargo-workspace` with Node and Rust packages.
- [x] **M2-07** Command discovery per package: install, build, lint, format, typecheck, test, dev. Sources are manifests,
      scripts, Makefile and justfile; each command gets a confidence level.
      — evidence: each command carries its source and a high/medium/low confidence. Ranking: scripts, then
      make/just targets, then conventions. Asserted per fixture: Go's `make test` beats `go test ./...`, npm's
      placeholder test script is ignored, bun scripts go through `bun run`, and justfile targets are read.
- [x] **M2-08** Setup audit:
  - agent files: CLAUDE.md/AGENTS.md (presence, size, staleness signals); `.claude/` settings, skills, agents and hooks; `.mcp.json`;
  - project health: CI, test framework, lint/format config;
  - `.gitignore` covers env and secret files; git remote.
      — evidence: `src/detect/audit.ts`, covered by the fixture scenarios:
      - no git (empty);
      - a committed `.env` (legacy-messy);
      - a remote (ts-pnpm-vite);
      - a CLAUDE.md that mentions the test command (python-uv-fastapi).
      The audit found a real gap here (`.env` wasn't ignored), now fixed in this repo's `.gitignore`.
- [ ] **M2-09** Readiness report: checklist-style findings, each mapped to a fix action. No score that has no actions behind it.
      Progress:
      - The sidebar's Setup tab shows the stacks, the packages with their commands, and the findings grouped by
        area, each gap with its fix.
      - The headline is a count of things to fix, not a score.
      - A test asserts no finding lacks a fix.
      - Remaining: one-click fixes (they come with M2-11/M2-12), and a look at the tab in the app.
- [x] **M2-10** Persist the `WorkspaceProfile` as `.agentchainer/profile.json`; decide and document whether it's committed by default.
      — evidence: `workspace.saveProfile` writes it, and `.agentchainer/.gitignore` keeps it out of git (tested, and
      idempotent). Decision (ARCHITECTURE §8): not committed, because it's derived data. The bootstrap lockfile will
      be committed.

### Plan & apply

- [x] **M2-11** BootstrapPlan builder: profile + catalog + audit → actions, each with reason, risk, scope and a preview
      (file diff or command list).
      — evidence: `src/bootstrap/plan.ts`, with `bootstrap.plan` over JSON-RPC.
      - Fixes come with exact previews: the `.gitignore` diff, `git rm --cached`, `git init`, the AGENTS.md import.
      - Catalog items come from the suggested and opted-in profiles, with tier, license, source, permissions, secrets
        and commands.
      - Generators are listed as not available yet.
      - Items are unavailable, with the reason shown, when they're unreviewed, need a missing tool, don't support the
        platform, or are already enabled.
      - `plan.test.ts` (17 tests) includes a plan snapshot per fixture.
- [ ] **M2-12** Review UI:
  - toggle actions on and off;
  - inspect each preview, the permissions an item needs, and its license;
  - "Apply selected".
      Progress:
      - The Setup tab's plan lists actions with checkboxes, tier/risk badges, why, license, scope, permissions,
        secrets, notes, and a diff or command preview, plus opt-in profile toggles.
      - "Apply selected" confirms the list, then shows each action's result and warnings.
      - The history shows each run, with "Roll back run", per-action "Roll back", and "Force" after a conflict.
      - Remaining: click through in the app.
- [x] **M2-13** Skill installer: fetch the pinned source → verify sha256 → copy to `.claude/skills/<name>` (project) or `~/.claude/skills` (user).
      — evidence:
      - `bootstrap/git-source.ts` downloads the GitHub tarball at a full SHA and extracts it with system tar.
      - The tree hash is the sha256 of the sorted per-file sha256s, and symlinks are refused.
      - `apply.test.ts` covers a hash mismatch (nothing written), an existing target (refused), and a matching source
        (copied, files recorded).
      - Live: `cloudflare-security-audit` was downloaded at `c1c8a8c`; the hash matched; 20 files were copied and then
        rolled back.
      - User scope isn't offered yet; every seed item is project-scoped.
- [x] **M2-14** Plugin installer: `claude plugin marketplace add` + `claude plugin install … --scope project -y --json`;
      record the installed version.
      — evidence:
      - Installs go through the user's CLI (`installer.ts`, spike S6) with no `-y` and without adding marketplaces
        implicitly. If the marketplace is missing, the user gets the exact command to run.
      - The installed version comes from `plugin list --json` and is written to the lockfile, with a warning when it
        differs from the reviewed version.
      - Tests use a fake CLI.
      - Live: `code-review@claude-plugins-official` was installed as 1.0.1 (the reviewed version), then uninstalled by
        rollback.
- [x] **M2-15** MCP installer:
  - command-based servers are registered with `claude mcp add --scope local`;
  - portable servers (`npx`, remote HTTP) may go to the project `.mcp.json`;
  - binaries are downloaded with checksums into an app-managed dir (never `curl | bash`);
  - secrets are referenced as env vars and never written to repo files.
      — evidence:
      - **Binaries:** `tools.ts` downloads a release asset, checks its sha256 before unpacking, unpacks it with the
        system tar, and keeps it in `<app data>/tools/<item>/<version>/`. The Rust core passes the folder to every
        sidecar.
        - The cache is re-verified on reuse.
        - On macOS, a binary without a signature gets an ad-hoc one.
        - Rollbacks keep binaries (shared cache).
      - **Install steps:** `mcp-add` runs `claude mcp add` with the item's scope; `merge-json` handles `.mcp.json`.
        Plan previews and apply share `steps.ts`, so the preview is what gets written.
      - **Local items** are recorded in the git-ignored `.agentchainer/local.json`.
      - **Catalog rules (tested):**
        - binaries only from release assets;
        - a server that runs a downloaded binary uses `local` scope;
        - npm steps run the pinned version;
        - `${VAR}` only for declared `secrets`.
      - **Tests:** `tools.test.ts`, `schema.test.ts`, and `apply.test.ts` (local hook, lefthook, private MCP
        server, `.mcp.json` merge). Every case rolls back to byte-identical files and a clean `git status`.
      - **Live, with real downloads and the real CLI:**
        - codebase-memory-mcp 0.11.0 ran on macOS. `claude mcp get` showed it "Local config … ✔ Connected", and
          rollback removed it.
        - playwright-mcp was merged into `.mcp.json` and rolled back.
- [x] **M2-16** Lockfile `.agentchainer/lock.json` ([CATALOG §7](CATALOG.md#7-lockfile)); re-running bootstrap is idempotent.
      — evidence:
      - It holds items (source, scope, version, files) and fixes, and `.agentchainer/.gitignore` keeps `backups/`
        and `profile.json` out of git.
      - Apply re-plans first, so a re-run skips what's already applied. Tested: the second apply of a fix is
        "skipped".
- [x] **M2-17** Rollback per item and per run, restoring previous file contents byte-for-byte from backups.
      — evidence:
      - Files are backed up before their first change in a run.
      - A rollback first undoes CLI changes (plugin uninstall, `git reset` of untracked env files, removing a fresh
        `.git`), then restores files byte for byte.
      - A file edited since the run is a conflict, left alone unless forced.
      - Tested:
        - after a whole-run rollback, files are byte-identical and `git status` is clean, with no `.agentchainer/`
          left;
        - a per-action rollback updates the lockfile;
        - conflicts and forcing.
      - Live: the plugin and skill install rolled back to a clean `git status`.
- [x] **M2-18** Auto-apply as an opt-in setting, limited to first-party and official items.
      — evidence:
      - The Settings toggle, "Apply safe setup automatically before a new session", is off by default
        (`settings.rs`, tested).
      - Before `session.start`, the app calls `bootstrap.autoApply`. That applies only recommended, pre-selected
        first-party and official items and the fixes that add lines.
      - The policy is `auto-apply.ts` (tested).
      - The session's first notices list what was applied and point to History for rollback. Failures never block
        the session.

### Generators (agent-driven, verified deterministically)

- [x] **M2-19** First-party skills in `skills/`: `ac-write-claude-md`, `ac-setup-hooks`, `ac-scaffold-tests`,
      `ac-generate-ci`, `ac-smoke-test`.
      — evidence: the five `skills/ac-*/SKILL.md` files are compiled into the sidecar by `build-catalog.ts`; a test
      fails while the compiled copy is stale. Each generator session runs with its skill appended to the system
      prompt.
- [x] **M2-20** Generator sessions run under a restricted profile (edits inside the workspace, Bash limited to detected commands).
      They produce a proposal diff and never write without review.
      — evidence:
      - **The session can't write.** It gets the tools Read, Grep, Glob and Bash, and `settingSources: []` (so no
        user hooks or MCP servers), and it isn't persisted.
      - A `PreToolUse` hook (which sees every call) allows:
        - reads inside the workspace;
        - the project's own test/lint/typecheck/build commands;
        - the SDK's `StructuredOutput`.

        It denies everything else (`generate.test.ts`).
      - **Files come back as structured output.** Each proposed path must be one the generator owns. A disallowed
        path, or a failed check, goes back to Claude as feedback, up to 2 attempts.
      - **The workspace guard reverts command side effects.** Finding: pnpm 11 rewrites `pnpm-lock.yaml` and creates
        `pnpm-workspace.yaml` before `pnpm run`. The guard reverts what commands change in git-visible files
        (`workspace-guard.test.ts`; live, `pnpm run lint`'s changes are reverted). Outside git, generators get no
        commands.
      - Proposals show in the plan as file diffs, and apply refuses one whose files changed since.
- [x] **M2-21** CLAUDE.md generator:
  - concise: real commands, an architecture map, conventions, Definition of Done;
  - merges into an existing CLAUDE.md;
  - if AGENTS.md exists, avoids contradicting it (link or import).
      — evidence:
      - `ac-write-claude-md` covers commands, layout, conventions, DoD, merging and `@AGENTS.md`.
      - Checks:
        - at most 300 lines;
        - mentions the detected test command;
        - imports AGENTS.md when present;
        - no home-folder paths.
      - Live on a fixture (haiku, $0.01, 59 s): 56 lines, all checks pass, and commands it couldn't run are marked
        as failing rather than claimed.
- [x] **M2-22** Hooks generator:
  - format and lint on edit, written to `.claude/settings.json` (`PostToolUse`);
  - optional Stop hook that runs fast tests;
  - gitleaks pre-commit through whichever hook manager the repo already uses (lefthook, pre-commit, husky).
      — evidence:
      - `ac-setup-hooks` plus checks: valid JSON, existing settings kept, a PostToolUse hook, referenced scripts
        present.
      - Live end to end over JSON-RPC: `.claude/settings.json` and a lint hook script were generated, applied and
        verified, then rolled back to a clean `git status`.
      - **gitleaks pre-commit (M2-15 installer):**
        - **With a hook manager** (lefthook, pre-commit, husky), its config gets a committed wrapper
          (`.agentchainer/hooks/gitleaks.sh`). The wrapper uses gitleaks from PATH or AgentChainer's copy, and lets
          the commit through with a hint when neither exists.
        - **Without one**, a local `.git/hooks/pre-commit` (never over an existing hook).
        - Tested in `git-hooks.test.ts`: comments kept, refusals, and a real commit blocked by a stand-in.
        - Live with gitleaks 8.30.1: a commit holding a GitHub token was blocked ("leaks found: 1"), a clean one went
          through, and rollback left a clean `git status`.
      - **Stop hook (optional fix, not pre-selected):**
        - The script and a `Stop` entry in `.claude/settings.json` run the detected test command.
        - When tests fail, the script exits 2 with the failure tail for Claude, and it stops on `stop_hook_active`.
        - The verifier times one run.
        - Tested in `stop-hook.test.ts`: settings kept, exit 0/2, no loop, monorepo folder, and apply → verify →
          rollback with a real `npm test`.
- [x] **M2-23** Test scaffold, only when none exists:
  - Vitest or Jest, pytest, flutter_test, or `go test`;
  - plus one example test and a `test` command;
  - verified by running it.
      — evidence:
      - `ac-scaffold-tests` plus checks: an example test, valid manifests, no dropped fields.
      - After apply, the verifier runs the re-detected test command.
      - Live on legacy-messy: Node and Python tests were generated and applied. `npm test` failed because the
        fixture's dependencies weren't installed; this was reported, `verified: false` was recorded, and the run
        rolled back cleanly.
      - **Install step with consent:**
        - The plan's scaffold-tests action carries the detected install command, and the Plan view offers it as an
          unchecked "Install dependencies first" option.
        - Apply runs it only if it's still the command shown, with the lockfiles backed up first.
        - Test (`generate.test.ts`): `npm install` ran, the tests passed, and rollback removed the lockfile it
          created and left a clean `git status`.
- [x] **M2-24** CI generator: a GitHub Actions workflow (install, lint, typecheck, test, build) with dependency caching,
      least-privilege `permissions:` and SHA-pinned actions; validated with actionlint.
      — evidence:
      - `ac-generate-ci` lists the verified action SHAs.
      - Checks: the YAML parses, top-level `permissions:` is set, every `uses:` is pinned to a SHA, and actionlint
        passes.
      - Live on go-service ($0.0035, 16 s): a pinned, least-privilege workflow.
      - **actionlint now runs:** found on PATH or in the tools folder, or else the catalog's pinned 1.7.12 is
        downloaded and hash-checked on demand.
      - **Live on go-service** (haiku, $0.005, 1 attempt): every check passed, including `actionlint: clean`.
- [x] **M2-25** Smoke test: `scripts/smoke.(sh|ps1)` per stack (app boots, health endpoint responds, CLI `--help`, or Flutter
      build), plus a CI job.
      — evidence: `ac-smoke-test`, with checks on the script and the workflow. Live on go-service over JSON-RPC:
      `scripts/smoke.sh` and `.github/workflows/smoke.yml` were generated; after apply the verifier ran the script
      (exit 0, 6.3 s); then rolled back cleanly.
- [x] **M2-26** Verifier: runs each generated command with a timeout and captures exit code and log tail.
  - Generators get at most N repair attempts.
  - The Bootstrap Report lists what passed, what failed, and what was skipped, with reasons.
      — evidence:
      - `verify.ts` runs the test command (5 min) or the smoke script (2 min) asynchronously, so the sidecar keeps
        answering pings. It keeps the exit code, duration and log tail, inside the workspace guard.
      - Generators get up to 2 attempts, with failed checks as feedback.
      - Each apply result and history entry lists its checks (pass, fail, skipped, with detail).
      - The lockfile's `generated` entries record `verified`.
      - `generate.test.ts` covers a failing and a passing smoke run.

### Fixtures & tests

- [x] **M2-27** Fixture repos in `fixtures/`:
  - one per tier-1 stack;
  - an empty repo;
  - a messy legacy repo (mixed tooling, no tests);
  - a monorepo.
      — evidence:
      - `fixtures/` holds ts-pnpm-vite, python-uv-fastapi, flutter-app, go-service, empty, legacy-messy and
        monorepo-pnpm.
      - `sample-app` (M1 exit scenarios) is there too.
      - The fixtures carry manifests and a little code, not dependencies. Tests add per-fixture git state on temp
        copies.
- [x] **M2-28** Automated bootstrap tests per fixture: detector and plan snapshots; installer and rollback run on temp copies.
      — evidence:
      - Detector, audit and plan snapshots per fixture (`test/snapshots/*.json`, `*.plan.json`).
      - `apply.test.ts` runs installers and rollback on temp copies of the fixtures, with a fake CLI and fake fetch,
        so there's no network in CI.

### Follow-ups from the first catalog review ([2026-10-30](catalog-reviews/2026-10-30.md))

- [ ] **M2-29** Carry license notices for git-source items: a `licensePath` pinned with its own hash and copied with
      the files. This unblocks cloudflare-security-audit.
- [ ] **M2-30** The gitleaks hook wrapper prefers a gitleaks on PATH and doesn't hash-check the tools-folder copy:
      prefer the pinned copy and check it against its marker.
- [x] **M2-31** `merge-json` replaces arrays. Merge permission lists (allow/deny) by union, so an item can add a deny
      rule to `.claude/settings.json`.
      — evidence: `mergeJson` (`bootstrap/steps.ts`) keeps the rules in `permissions.allow`, `ask` and `deny` and adds
      new ones once each; other arrays (an MCP server's `args`) are still replaced. Tests: `steps.test.ts` (unit) and
      `apply.test.ts` (a deny rule added next to existing ones in `.claude/settings.json`, then a rollback restores it
      byte for byte).
- [ ] **M2-32** Re-pin codebase-memory-mcp to 0.12.1 (the weekly bot proposes it) and review it again; it needs two
      reviews as a community item.

### Exit criteria

- [x] **M2-E1** Bootstrap succeeds on every fixture on macOS, Windows and Ubuntu.
      — evidence: CI job "Bootstrap exit" ([run 40861455099](https://github.com/hafizhrf/AgentChainer/actions/runs/40861455099)),
      8 of 8 fixtures on each OS.
      - **What runs, per fixture:** the default bootstrap plus every catalog item (`exit.test.ts`), with all items
        reviewed and all profiles on. That covers:
        - pinned git copy;
        - release binaries (gitleaks; codebase-memory-mcp's zip on Windows);
        - local git hook;
        - MCP registration;
        - `.mcp.json` merge;
        - plugins;
        - fixes.
      - Downloads are real; the `claude` CLI is a stand-in. Generators need a model and are covered by their own
        live runs (M2-21…M2-25).
      - The job also runs the sidecar unit tests on all three OSes. On Windows it found CRLF checkouts and 8.3 short
        paths (fixed: `.gitattributes`, native realpath).
- [ ] **M2-E2** For each tier-1 stack, the generated CI runs green on a real GitHub test repo.
- [x] **M2-E3** A full rollback leaves `git status` clean and every file byte-identical.
      — evidence: the same run.
      - After the rollback, every file (including `.git/hooks`) hashes the same as before, and `git status` matches,
        on every fixture and OS.
      - It found a bug: actions of one run that changed the same file (every plugin install edits
        `.claude/settings.json`) shared one backup, so a whole-run rollback restored the wrong content. Each backup
        now has its own path, with a regression test in `apply.test.ts`.
- [x] **M2-E4** No action is applied without a preview, unless the user opted into auto-apply.
      — evidence:
      - Apply re-plans and only runs actions of the current plan.
      - `plan.test.ts` checks that every action that can be applied, in every fixture, has a concrete preview: a diff,
        files, commands, or a described copy with its commit and tree hash. All four kinds are exercised.
      - Generators can't be applied until their proposal (files) exists.
      - The only path without a preview is the opt-in auto-apply (M2-18), limited by `auto-apply.ts`.

---

## UX — Product design & UI polish (before R1)

**Goal:** turn the functional M1/M2 screens into a polished, trustworthy product before the first public release.
**Scheduled later by the owner:** start once M1 and M2 work functionally. Pulled forward on 2026-10-29: the owner asked
for the desktop shell, start screen and session view to be cleaned up (UX-02, UX-03, UX-06, UX-07).

- [ ] **UX-01** Pattern research: review Claude Code Desktop, Cursor, Zed and Conductor for layout, chat, tool, diff and
      approval patterns; write down principles and anti-patterns in `docs/design/ux-principles.md`.
- [x] **UX-02** Design system: tokens (color, type, spacing, radius, motion) for light and dark. Pick a component approach
      (e.g. Radix/shadcn + Tailwind) and record it in an ADR.
      Owner decisions (2026-10-28):
      - Primary color: a dark pastel green. No orange: it would look like Claude's own apps (see the branding rules
        in ADR-0002).
      - Dark mode stays a first-class theme.
      - Component approach (2026-10-29): Radix Primitives + our own CSS tokens + react-resizable-panels, no Tailwind.
      — evidence:
      - [ADR-0008](adr/0008-ui-components-and-styling.md).
      - Tokens in `apps/desktop/src/styles/tokens.css`; `App.css` is split into `styles/`.
      - A Light / Dark / System setting (`theme` in `settings.rs`, tested). Monaco and xterm follow theme changes.
      - Debug-build screenshots of Home, a session, the terminal and Settings, in both themes, reviewed and then deleted.
- [ ] **UX-03** Information architecture and wireframes:
  - Owner feedback (2026-10-29, after using the M2 build):
    - the Setup tab's readiness report and bootstrap plan need more room than the 260 px sidebar;
    - the settings form is cramped (labels sit on the fields);
    - the dev UI generally looks unfinished.
  - left sidebar with workspaces and sessions;
  - the main transcript;
  - a right panel for changes/diff and agents;
  - a status bar showing model, mode and cost.
  - Progress (2026-10-29): built.
    - Layout: sidebar (sessions, recent workspaces, readiness, Settings) | center (header, transcript, composer,
      terminal split, status bar) | resizable right panel (Changes, Files, Git, Rules, Setup).
    - A selected file's diff replaces the tabs and widens the panel to 55%.
    - Panel sizes are remembered.
    - Right-panel pass after owner feedback (same day):
      - Files is an explorer: file-type icons, indent guides, git tints, a filter, keyboard navigation.
      - Changes and Git use collapsible sections with hover actions.
      - Git has a branch picker (search, create) and a commit box with Draft with Claude.
    - Owner notes (2026-10-29, after R1 prep):
      - Rules took a whole tab: they moved to Workspace settings → Permissions.
      - The right panel's tabs can be hidden, VS Code style: the ⋯ menu or a right-click on the tab bar, remembered
        per device. The last tab can't be hidden; ⌘B still hides the whole panel.
    - Open:
      - owner click-through;
      - overall polish "to the level of the big IDEs". The owner wants it later, once the features exist.
- [x] **UX-04** Transcript polish: markdown and code highlighting, grouped and collapsible tool runs, a streaming cursor,
      copy buttons, timestamps, long-session performance.
      — evidence: PR #32, checked in a debug build with real Haiku turns, in light and dark.
      - **Code blocks:** fenced code is highlighted by Monaco's colorizer (lazy, no new dependency), with a language bar
        and Copy.
      - **Tool runs:** two or more calls in a row fold into one row ("Ran 4 tools · Read ×2 · Glob · Bash"). The row
        stays open while running or when a call failed or was blocked.
      - **Messages:** a blinking caret while a reply streams; the time and Copy on hover.
      - **Performance:** rows are memoized with stable callbacks.
      - **Scrolling:** output is followed only while you're at the bottom; otherwise "Jump to latest" appears.
- [x] **UX-05** Approval and mode UX:
  - richer approval dialog: diff preview for edits, plain-language command explanation, risk level, "always allow" with scope;
  - explain each permission mode in the UI, and show why the guard blocked a call.

      — evidence: PR #32, checked in the debug build:
      - `rm -rf build && git push` showed "High risk" with both reasons, Claude's explanation, and Deny focused.
      - An Edit showed "Low risk" and its diff.
      - The rules are deterministic (`approval.ts`, tested). "Always allow" saves for this session, this user
        (`.claude/settings.local.json`) or the team (`.claude/settings.json`).
      - Workspace settings → Permissions lists both files.
      - A "?" next to the Composer's profile explains each profile.
      - The guard's reason is on the blocked call's badge and in its card.
- [ ] **UX-06** Onboarding and empty states: native folder picker instead of a typed path, first-run checklist,
      helpful errors.
  - Progress (2026-10-29):
    - The Home screen scrolls at the window edge, with content in a centered column.
    - Cards, top to bottom:
      - readiness: one line when ready, otherwise the setup steps;
      - workspace: "Open folder…" first, recent folders, typed path on request, home-folder and git warnings;
      - options: model and profile side by side, plus the reason Start is disabled;
      - previous sessions, with a ⋯ menu.
    - Settings moved into a dialog.
    - New sessions offer starter prompts.
    - Workspace setup is a full page, like an IDE's project settings. It opens from Home, the session menu and the
      right panel. Sections:
      - Overview: findings by area, each linked to its fix;
      - Plan: master/detail, with unavailable items folded and Apply at the bottom;
      - Commands;
      - History.
    - Owner notes (2026-10-29):
      - The setup page is now **Workspace settings**: Overview, Setup plan, Commands, Permissions, History.
      - A new session shows its composer mid-screen with the starter prompts below it, like a chat app's first
        screen; after the first message the composer moves to the bottom.
    - Owner note (2026-10-30): Workspace settings' section list looked like a second app sidebar next to the real
      one. It now has the page's surface with an accent bar on the active section, and the sidebar marks no session
      while a page is open over it.
    - Owner note (2026-10-30): New task with no workspace showed a banner ("Choose a workspace folder first") that
      stayed after a folder was picked. New task now opens on a workspace step (Home's card, then Continue).
    - Open: owner click-through, and the in-app guide.
- [ ] **UX-07** Keyboard shortcuts and a command palette.
  - Progress (2026-10-30), the command palette (⇧⌘P / Ctrl+Shift+P, View → Command Palette…):
    - It's Radix Dialog + `fuzzy.ts`, with no new dependency (ADR-0008 note).
    - It finds every action:
      - session: new, open folder, stop, resume, fork, close, permission profile, model;
      - open sessions and recent workspaces;
      - Workspace settings sections;
      - panels and panel tabs, and the theme;
      - Settings, updates, diagnostics, help.
    - Displayed shortcuts come from one map (`MENU_SHORTCUTS`), which a test checks against `menu.rs`.
  - Progress (2026-10-29):
    - Native menu (`src-tauri/src/menu.rs`): App, File, Edit, View, Window and Help.
    - Shortcuts:
      - ⌘N new session; ⌘O open folder; ⌘W close session;
      - ⌘, Settings;
      - `⌘\` sidebar; ⌘B right panel; ⌘J terminal.
    - The UI maps menu ids in `useMenuCommands.ts`; a test checks it against the Rust list.
    - Open:
      - the command palette;
      - checking the shortcuts on Windows and Linux, where the menu bar sits in the window **(verify)**;
      - a full menu bar like VS Code's (owner note, 2026-10-29: later, once the features exist):
        - **File:** New Session, Open Folder, Open Recent ▸, Close Session, Close Window;
        - **Edit:** standard items, plus Find;
        - **View:** Command Palette, Appearance ▸ (sidebar, panel, terminal, panel tabs), Theme ▸, Zoom, Full Screen;
        - **Session:** stop, resume, fork, rewind, mode ▸, model ▸;
        - **Workspace:** Workspace Settings, Permissions, Git ▸, Open in Editor, Reveal in Finder;
        - **Terminal** and **Window**;
        - **Help:** docs, install guide, shortcuts, privacy, release notes, updates, About.
- [ ] **UX-08** App icon and visual identity, after naming and branding are settled (M0-01).
- [ ] **UX-09** Usability test with 3–5 target users on macOS, Windows and Ubuntu; fix the top issues.
- [ ] **UX-10** A Plugins page like Android Studio's, after M3 step 1. Owner request, 2026-10-30.
  - Marketplace and Installed tabs, search, a detail page (vendor, version, license, permissions, risk, review
    status, source link), Install/Uninstall per workspace, and update notices.
  - It lists the reviewed catalog **and the whole official marketplace**; unreviewed plugins are clearly marked.
    That changes ADR-0005's trust model, so a new ADR comes first.
  - Plugins keep installing through the Claude CLI, from their original marketplace.
- [ ] **UX-11** Task pages pass. Owner feedback, 2026-10-30, with screenshots: "still messy".
  - Found:
    - content sat left-aligned with empty space on the right;
    - criteria and list items were one-line fields cut off mid-sentence, in three narrow columns;
    - the approved view joined lists with " · " into run-on lines, with a different label column per card;
    - triage labels like "Risk Keywords".
  - Progress (2026-10-30):
    - one centered frame (a 960 px reading column, a 1180 px draft grid);
    - list rows that wrap and grow with their text, with the criteria's checks in a fixed column;
    - Constraints, Out of scope and Risks stacked full width, and areas two per line;
    - one Contract card on a shared label column, with bullet lists, folding to its objective once the task has run;
    - triage signals stacked, in sentence case.
  - Open: owner click-through in light and dark.

### Exit criteria

- [ ] **UX-E1** All M1/M2 screens use the design system, in light and dark themes.
- [ ] **UX-E2** Usability test participants complete the M1 exit scenarios without help.

---

## R1 — v0.1 release

Decisions: [ADR-0009](adr/0009-release-signing-and-updates.md). Maintainer steps: [RELEASING.md](RELEASING.md).

- [x] **R1-01** Bundles: macOS dmg, Windows msi/nsis, Linux AppImage + deb + rpm.
      — evidence: the release dry run of #31 ([run 40998609031](https://github.com/hafizhrf/AgentChainer/actions/runs/40998609031)).
      - All four runners and the finalize job passed: macOS arm64, macOS x64 (`macos-15-intel`), Windows x64 and
        Ubuntu 22.04.
      - Each runner installed its `.dmg`, `.msi` or `.deb` and launched the installed app.
      - `scripts/release-assets.mjs` gives the assets names that don't collide, and writes `SHA256SUMS` and
        `latest.json`.
      - Earlier dry runs found two problems, both fixed: pnpm's self-update on Intel macOS (#29), and Git's tar
        breaking the SDK extraction on Windows (#31).
- [x] **R1-02** Ship the sidecar per target triple via `bundle.externalBin`. No Claude binary is bundled. M0-03 is resolved.
      — evidence: the same run.
      - Each runner builds its own sidecar (`build:sea` in `beforeBuildCommand`).
      - On every OS, the installed sidecar downloaded and verified the Agent SDK, then started from the cache.
- [ ] **R1-03** Signing:
  - macOS: Developer ID + notarization, with every embedded binary signed.
  - Windows: Azure Artifact Signing, or unsigned with SmartScreen guidance.
  - Linux: checksums (+ GPG).
  - Record the budget decision.

      **Decided for v0.1** ([ADR-0009](adr/0009-release-signing-and-updates.md)): no budget yet, so installers are
      unsigned. [INSTALL.md](guides/INSTALL.md) covers opening them and checking `SHA256SUMS`. The workflow passes
      Apple signing secrets through once they exist. Open: macOS Developer ID, Windows signing, GPG.
- [ ] **R1-04** Auto-updater (`tauri-plugin-updater`) with signed manifests on GitHub Releases.
      - Built in: **Help → Check for Updates** and **Settings → About**, which check only when clicked and install
        after confirmation. `requireSignedVersion` is on. The finalize job writes `latest.json` from the `.sig` files.
      - The key is the owner's: [RELEASING.md](RELEASING.md#update-key). Dry runs sign with a throwaway key.
      - Remaining: the owner sets up the key, then an update from one real release to the next is checked.
- [x] **R1-05** Privacy statement: no telemetry by default; what data stays local.
      — evidence: [PRIVACY.md](PRIVACY.md) (PR #27), linked from Settings → About and the README.
- [x] **R1-06** Security review:
  - update the threat model (X-01);
  - review Tauri capabilities and the IPC surface;
  - run the `cloudflare-security-audit` skill on this repo, then fix or document the findings.

      — evidence: [THREAT_MODEL.md](THREAT_MODEL.md#security-review-of-2026-10-29) (PR #27):
      - **CSP:** set, instead of `null`.
      - **Capabilities:** narrowed to what the UI calls.
      - **Audit:** its confirmed finding is fixed (forged rollback records), and two manual findings are fixed
        (opening runnable files with the default app; folder names on Windows' `cmd`).
      - **Coverage:** the areas the audit didn't reach are listed.
- [ ] **R1-07** README quickstart, screenshots, and a short demo GIF or video. AUTH_SETUP is linked from both the app and the README.
      - The quickstart is in the README. Remaining: screenshots and a GIF from a clean profile.
- [ ] **R1-08** Changelog and release automation (release-please or changesets).
      - release-please v5 (`release-please-config.json`) bumps `Cargo.toml`, `Cargo.lock` and `package.json`. Its
        `Cargo.lock` filter was checked against release-please 17.6.0. It creates draft releases, with tags.
      - Remaining: the first release PR on `main`.
- [ ] **R1-09** Install the release artifacts on clean VMs (macOS, Windows 11, Ubuntu LTS) and smoke-test them.

### Exit criteria

- [ ] **R1-E1** M1 and M2 exit criteria pass when re-run on the release artifacts, not dev builds.
- [ ] **R1-E2** Release v0.1.0 is published with checksums and notes.

---

## M3 — Adaptive planner & task contracts (v0.2)

→ PRD [F3](PRD.md#f3--adaptive-planner-task-contracts-and-evidence-p1)

- [x] **M3-01** Design doc `docs/design/planner.md`, approved before any code.
      - Draft merged in #33; the owner decided §15's questions on 2026-10-30, and marked it approved in the step 1
        plan. Two later decisions are recorded there too: triage runs on the draft, and tasks stay behind a preview
        toggle until they can run.
- [ ] **M3-02** TaskContract schema: task, objective, constraints, acceptance criteria / Definition of Done, out-of-scope,
      risk notes. The agent drafts it as structured output; the user edits and approves it.
      Progress (step 1, behind Settings → Tasks (preview)):
      - Schema in `packages/protocol` (criteria checked by `gate:<kind>`, `review` or `manual`; open questions);
        files in `.agentchainer/tasks/<id>/`, git-ignored, read back through zod (forged or symlinked folders are
        refused).
      - Drafting is a read-only session (Read, Grep, Glob; the generators' hook; the workspace guard) with structured
        output. Tests use a stand-in SDK and check the options and that a stray write is reverted.
      - The task page: request, contract form, approval. Live on a `ts-pnpm-vite` copy: drafted and triaged in under
        25 s for ≈$0.11; the draft noticed the missing `index.html` and asked about it; git saw only
        `.agentchainer/.gitignore` afterwards.
      - Clicked through on macOS (2026-10-30, debug build, a haiku draft): request, drafting with Cancel, the review
        with editable lists, an override with its reason, approval and the ready view. Haiku annotated paths
        ("index.html (new)", "a.tsx or b.tsx"), which inflated the scope signal; drafted areas are now cleaned to
        paths.
      - Remaining: owner click-through in the app.
- [ ] **M3-03** Triage into tiers S/M/L/XL, with a rationale the user can override. Inputs:
  - deterministic signals: estimated scope (via the code graph when available), risk keywords (auth, payments, migrations,
    infra, secrets), repo size, whether tests exist;
  - a cheap-model classification.

  Progress (step 1): signals and floors in `tasks/triage.ts` (planner.md §4), haiku classification with structured
  output (checked live: it arrives with `tools: []`), proposal = the higher of the two. The triage card shows the
  signals and the rationale; another tier needs a reason, recorded in `triage.json`. An edited contract must be
  triaged again before approval. Owner note (2026-10-30): "theme tokens" in a restyle task counted as a risk
  keyword; a bare "token" no longer does, only phrases like access token or API key (the signals-only benchmark is
  unchanged). Remaining: owner click-through, and tuning after the labels (M3-E1).
- [ ] **M3-04** Workflow templates as versioned YAML in `catalog/workflows/`, one per tier as described in the PRD.
      Progress (step 2): S and M in `catalog/workflows/`, validated by zod and compiled with the roles into
      `tasks/library.json` (`library.test.ts` fails while it's stale). Step 3: L, with a `parallel` step of read-only
      planners (the schema refuses write steps there). Step 4: XL (`xl.yaml`: the split step, `maxParallel`, the
      integration gates), so every tier has its template. Remaining: owner click-through.
- [ ] **M3-05** Agent library, installable into `.claude/agents/`: architect, test-planner, security-reviewer, docs-writer,
      and independent-reviewer (fresh context: it gets the diff and contract, not the implementer's transcript).
      Progress (step 2): all six roles in `agents/ac-*.md` (`.claude/agents/` format), used as step prompts; the
      reviewer runs fresh on Opus with only the contract, the diff and the gate results. Step 3: Install into project
      as the setup plan's optional fix `fix:install-agents` (files preview; apply and rollback tested in
      `apply.test.ts`; a test checks each role renders back to its exact file). Remaining: owner click-through.
- [ ] **M3-06** Orchestrator that executes a template:
  - sequential and parallel steps;
  - hand-offs as files (`plan.md`, `contract.json`);
  - budget and turn caps per step.

  Progress (step 2): `tasks/orchestrator.ts` runs S and M as sessions per step (read steps isolated and read-only,
  write steps with approvals in the profile picked at Run), with hand-off files, a base snapshot, persistence, Stop
  and Resume; tested with a fake runner (9 cases). Live (2026-10-30, `scripts/live-task.ts` on `sample-app`): an S task
  done in 8 s for ≈$0.01; an M task through plan, implement, gates and an Opus review in 38 s for ≈$0.13, the review
  arriving as structured output; and an M task that failed honestly after 2 fix rounds; Stop (`--stop-after`) ends a
  run `cancelled` and leaves no process behind. Clicked through on macOS (2026-10-30, debug build): Approve and run,
  the step's Edit and Bash approvals over the task page, the timeline with the step's transcript, the gates panel, Run
  again. Two fixes from it: the reply to `task.start` could overwrite newer step updates (the timeline stayed empty
  while a step ran), and a step's approval covered the page's Stop, so it now offers Stop task itself.

  Step 3: parallel steps (L's planners, up to 3 at once, merged into `plan.md`) and baseline gates before the first
  step. Live (2026-10-30): an L task on `sample-app` ran the three planners at the same time, then implement, gates
  and the Opus review, and ended Done in 65 s for ≈$0.18. Remaining: owner click-through.
- [ ] **M3-07** XL path: split into sub-tasks, each with its own contract and worktree. Evaluate the SDK `Workflow` tool
      where the user's plan supports it.
      Progress (step 4, planner.md §8):
      - **Split:** a read-only session; the sub-tasks are draft child tasks with their own contracts and triage,
        approved one by one or all at once.
      - **Run:** in worktrees on `agentchainer/*` branches, in dependency order, two at once. Each sub-task that ends
        Done is committed and merged into the task branch, then the integration gates run there with the baseline
        rule. Continue picks up after a failure or a stop. The user merges the result with a click and cleans the
        worktrees up.
      - **Tests:** `xl.test.ts`, `worktree.test.ts`, `split.test.ts`, the service tests.
      - **Live** (2026-10-30, `live-task.ts --tier XL` on `sample-app`, haiku with the Opus review):
        - the split gave 2 sub-tasks, S then M after it;
        - the baseline found `test` already failing, and the S sub-task fixed it;
        - both ended Done and were merged; the integration gates passed;
        - 50 s, ≈$0.11;
        - the task branch's log has one commit and one merge per sub-task; the report's gate runs match the recorded
          ones and a re-run by hand;
        - Clean up removed the worktrees and the user's branch was untouched.
      - **Windows 11** (2026-10-30, CLI 2.1.314): the first XL run stopped after merging sub-task 1 with `EPERM`
        removing its worktree. The step's `claude` (and the MCP servers it started there) was still exiting, and
        Windows won't remove a folder a process runs in. `Session.close()` now resolves when the CLI has exited, the
        orchestrator waits for it, and a merged sub-task's worktree that still can't go is left for Clean up instead
        of stopping the run. After that: 5 XL runs ended Done (two with 2 sub-tasks), Clean up removed the worktrees;
        S, M and L also ended Done with the evidence matching the recorded gate runs.
      - **Workflow tool** ([spike S7](spikes/S7-workflow-tool.md)): available on the owner's account; not the
        executor, since gates and evidence must stay the app's; usable inside a step.
      - Remaining: owner click-through.
- [ ] **M3-08** Verification gates from WorkspaceProfile commands (format, lint, typecheck, test, smoke), with a bounded fix loop
      (iteration and budget caps).
      Progress (step 2): `tasks/gates.ts` resolves gates from the profile (root or per package) plus `scripts/smoke.*`,
      runs format in write mode and checks under the workspace guard, all gates after a failure, with fix rounds
      capped (2) across the run. In the live runs, every recorded exit code matched the command re-run by hand.
      Step 3: a baseline run before the task; failures already there don't use fix rounds and are marked for the
      implementer and the reviewer. Live (2026-10-30): the coupon M task that spent 2 rounds and failed in step 2 now
      spends none, still gets its review, and ends Failed with "test was already failing before the task".
      Remaining: owner click-through.
- [ ] **M3-09** Evidence report per task, stored and exportable as markdown:
  - changed files and their purpose;
  - gates run, with real exit codes; gates not run, with reasons;
  - security notes, remaining risks and manual steps.

  Progress (step 3): `tasks/evidence.ts` builds `evidence.json` and `evidence.md` from the run's records only
  (planner.md §9), including the approvals Claude asked for and guard blocks, and a gitleaks scan when it's
  installed; `task.evidence`; the task page's Evidence card with Copy and Open in editor. Live (2026-10-30):
  `live-task.ts` checks that the report's gate runs are the recorded ones (they were, on two M runs and an L run).
  Remaining: owner click-through.
- [ ] **M3-10** The UI shows a task as "Done" only when the required gates passed, or the user explicitly accepted the risk.
      Progress (step 3): Done only when every gate's latest run passed; otherwise Failed or Not verified, and Accept
      risk… (`task.acceptRisk`, a reason required) ends it as Accepted with risk, which the report records. Live
      (2026-10-30): the coupon M task accepted with a reason over JSON-RPC. Remaining: owner click-through.

### Exit criteria

- [ ] **M3-E1** On a benchmark of ≥ 20 fixture tasks, triage agrees with a human reviewer's tier in ≥ 80% of cases
      (measure the baseline first, then tune).
      - 24 tasks in `packages/sidecar/test/triage-benchmark.json`, run by `scripts/benchmark-triage.ts`.
      - First baseline (2026-10-30), against the author's suggested tiers, not yet human labels: 20/24 (83%), about
        $0.02.
      - Remaining: the owner labels the tasks (`label`), then the real baseline and tuning.
- [ ] **M3-E2** Every completed task has an evidence report whose gate results match the actual command outputs.
      - `live-task.ts` re-runs the last round's commands by hand and compares the report's gate runs with the
        recorded ones; a unit test checks the same (`evidence.test.ts`). Remaining: the run over benchmark tasks.

---

## M4 — Agent observability (v0.2–v0.3)

→ PRD [F4](PRD.md#f4--agent-observability-p1)

- [ ] **M4-01** Agent tree store built from normalized events (main → subagents → nested). Tracks status, current tool,
      start/end and attributable tokens and cost.
- [ ] **M4-02** Live graph with `@xyflow/react` and elkjs auto-layout. Nodes are agents and key tool calls; edges are spawns and hand-offs.
- [ ] **M4-03** Node drawer: subagent prompt, transcript (SDK `getSessionMessages` / `agent_transcript_path`), tool calls, cost.
- [ ] **M4-04** Timeline (Gantt) view that shows parallelism and waiting.
- [ ] **M4-05** Controls: interrupt the session; stop a single subagent if the SDK supports it (verify).
- [ ] **M4-06** Agent library manager: list, create and edit `.claude/agents/*.md` and programmatic agents; mark each as manual or auto-spawned.
- [ ] **M4-07** Background tasks and shells panel.
      Note: until then the sidecar runs every `query()` with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, because CLI
      2.1.314 backgrounds subagents by default ([S4 update](spikes/S4-S5-S6.md)). This item lifts it: the session
      stays busy while background tasks live (`background_tasks_changed`), each one can be stopped, and a task step
      waits for them before its gates.
- [ ] **M4-08** Replay a finished session as a graph.

### Exit criteria

- [ ] **M4-E1** A session with ≥ 3 parallel subagents renders correctly live and on replay.
- [ ] **M4-E2** Pan and zoom hold 60 fps with 200 nodes on the slowest supported WebView.

---

## M5 — Git workflow, PR & quality gates (v0.3)

→ PRD [F5](PRD.md#f5--git-workflow-prs-and-quality-gates-p1)

- [ ] **M5-01** Each task runs in an isolated worktree and branch. Parallel tasks are supported, with a warning when two touch
      the same files. Worktrees are cleaned up afterward.
      Note (2026-10-30): XL tasks already run in worktrees (`tasks/worktree.ts`, M3-07); M5-01 extends them to every
      tier.
- [ ] **M5-02** PR creation (gh CLI or GitHub API) with the contract and evidence report in the body.
- [ ] **M5-03** CI status polling, plus a "Fix CI" loop that reads failing logs. The loop is gated by approval and budget.
- [ ] **M5-04** Merge gates: independent AI review of the diff, plus deterministic scanners (gitleaks; semgrep and trivy if installed).
- [ ] **M5-05** Merge, force push and release tags always require a human.
- [ ] **M5-06** GitLab support (optional).

### Exit criteria

- [ ] **M5-E1** End to end on a test repo: task → worktree → gates → PR → CI green → human merge.

---

## M6 — Deployment & workflow canvas (v0.4)

- [ ] **M6-01** Deploy adapter interface (detect, plan, deploy, smoke, rollback), with adapters for Vercel, Cloudflare (wrangler),
      Fly.io, Docker image → registry, and Firebase.
- [ ] **M6-02** Environments are labeled preview or production. Production deploys always need explicit human approval.
      Credentials stay in each provider's own CLI.
- [ ] **M6-03** Post-deploy smoke test and one-click rollback.
- [ ] **M6-04** Editable workflow canvas: React Flow ⇄ workflow YAML round-trip, with validation, import/export and sharing.

### Exit criteria

- [ ] **M6-E1** Preview deploy, smoke test and rollback work for at least 2 adapters.

---

## M7 — Evals & analytics (v0.5)

- [ ] **M7-01** Local metrics dashboard: gate pass rate, cost per task, cost per successful task, duration, retries, human-fix rate.
- [ ] **M7-02** Eval harness: fixture tasks with acceptance tests, run headless to compare workflow templates, models and skill versions.
- [ ] **M7-03** CI regression job for first-party skills and workflow templates.
- [ ] **M7-04** Optional OpenTelemetry export (verify Claude Code's OTel support).

### Exit criteria

- [ ] **M7-E1** A change to a workflow template reports its success and cost delta on the benchmark before merge.

---

## M8 — Multi-folder workspaces & agent fleet (proposed)

→ PRD [F9](PRD.md#f9--multi-folder-workspaces-p2). Owner requests, 2026-10-30. Several ideas come from
[CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (CAO, AWS Labs, Apache-2.0). They're
reference only: no code is copied, and each one gets a plan before it's built.

- [ ] **M8-01** Multi-folder workspaces (F9): a workspace is a named set of folders, e.g. an app repo and its API
      repo.
  - Sessions run in the primary folder and add the others with the SDK's `additionalDirectories` (the CLI's
    `--add-dir`; in the installed SDK's types).
  - Readiness, the setup plan and git work per folder, and the guard allows all the workspace's folders.
  - Tasks name the folder in their affected areas; XL sub-tasks can target different folders, each in its own
    worktree.
  - **(verify)** whether project settings, hooks and CLAUDE.md load from the added folders.
  - Open: where the definition lives (the app's database, or a file like VS Code's `.code-workspace`).
- [ ] **M8-02** A fleet view: every running session and task step across workspaces, with live status (working,
      waiting for approval, idle, done), cost, and one click to open it. From CAO's dashboard and status badges; it
      extends M4's agent tree.
- [ ] **M8-03** Supervisor and worker sessions: a supervisor session hands work to worker sessions (assign, hand
      off, send a message, an inbox) through an in-app MCP server, under the app's approvals and budgets. From CAO's
      supervisor/worker model; it goes beyond XL's fixed split (M3-07).
- [ ] **M8-04** An agent profiles manager: create from a template, edit, clone and delete, validated before saving,
      with per-profile tool allowlists. From CAO's profile editor; builds on M3-05's roles and UX-10's Plugins page.
- [ ] **M8-05** Scheduled flows: run a task template on a schedule (e.g. a nightly dependency bump), locally, with a
      budget cap and an evidence report per run. From CAO's flows.
- [ ] **M8-06** Lessons from outcomes: suggest CLAUDE.md additions from finished tasks' evidence, each one approved
      by the user (opt-in). From CAO's memory and self-learning loop.
- **Not adopted from CAO:**
  - other providers' CLIs (PRD §7 non-goal);
  - tmux terminal backends (the app has its own terminal and sessions);
  - an HTTP server with a web UI, since the sidecar has no network port (THREAT_MODEL T-05).

---

## Cross-cutting tracks (ongoing)

### Security & privacy

- [ ] **X-01** Threat model doc (`docs/THREAT_MODEL.md`), updated every milestone.
      - Written for v0.1 (R1-06). Next review: end of M3.
- [ ] **X-02** Least-privilege Tauri capabilities, a sidecar argument allowlist, and IPC validation on both ends.
      Replace the scaffold's `"csp": null` (Tauri template default) with a strict Content Security Policy.
- [ ] **X-03** Secrets never appear in logs or the UI: a redaction filter covers logs, displayed tool output and diagnostics.
- [ ] **X-04** No telemetry by default. Any future telemetry is opt-in and documented.

### Quality & performance

- [ ] **X-05** Weekly CI job runs the latest Agent SDK and CLI against the recorded-fixture contract tests, and opens an issue on drift.
- [ ] **X-06** E2E with `tauri-driver` on Linux and Windows. macOS uses a manual checklist (verify WebDriver support).
- [ ] **X-07** Performance budgets for startup time, idle memory and stream latency, tracked every release.

### Compatibility

- [ ] **X-14** Test the packaged app behind an HTTP proxy (`NODE_USE_ENV_PROXY=1` is set; spike S1).
- [ ] **X-08** Compatibility matrix in the docs (OS versions, CLI versions, SDK version). The health check enforces the minimum CLI version.

### Docs & community

- [ ] **X-09** Every decision that is expensive to reverse gets an ADR, and this checklist stays current.
- [ ] **X-10** User docs, a contributor guide, and good-first-issues tagged for each milestone.
- [ ] **X-11** Review [RISKS](RISKS.md) at every milestone boundary.

### Accessibility & i18n

- [ ] **X-12** Keyboard-first navigation, focus management, screen-reader labels, and sufficient contrast in both themes.
- [ ] **X-13** i18n-ready strings: English first, Indonesian next.
