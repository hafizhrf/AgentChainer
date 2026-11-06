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
| [M1](#m1--agent-session-core-v01-a) | v0.1 | Agent session core | ◐ Built. E1–E5 pass on macOS and Windows, and in the app on Windows; left: Ubuntu, E6 by hand, the click-through on macOS and Ubuntu |
| [M2](#m2--workspace-bootstrap-v01-b) | v0.1 | Workspace bootstrap | ◐ Built. E1, E3, E4 pass; E2 (real repositories) deferred by the owner; more MCP items (M2-33, M2-34) after v0.1 |
| [UX](#ux--product-design--ui-polish-before-r1) | v0.1 | Product design & UI polish (after M1/M2 work functionally) | ◐ Design system, shell, chat room (UX-12), tasks as chats (UX-13), live flows (UX-14), icon (UX-16) and canvas (UX-17) in; title bar (UX-15) and Plugins page (UX-10) built, not yet ticked; left: research, click-throughs, usability tests |
| [R1](#r1--v01-release) | v0.1 | Packaging & release | ◐ Pipeline, updater, security review and docs in place; publishing waits for M0-01 and M0-22 |
| [M3](#m3--adaptive-planner--task-contracts-v02) | v0.2 | Adaptive planner, contracts, evidence | ◐ Every tier (S, M, L, XL) runs live on macOS and Windows, with gates, evidence and accepted risk (preview); E2 passes; left: the owner's click-through and E1 (benchmark labels) |
| [M4](#m4--agent-observability-v02v03) | v0.2–0.3 | Agent observability graph | ◐ Agent tree, graph, drawer, stop, timeline, replay, background tasks and agent library in; E2 frame times pass on Windows and, after the canvas fix, on an Intel Mac; Ubuntu not run |
| [M5](#m5--git-workflow-pr--quality-gates-v03) | v0.3 | Git workflow, PRs, gates | ◐ Done for GitHub ([git-workflow.md](design/git-workflow.md)): worktrees, PRs, CI and Fix CI, merge gates, human merge; E1 passed on Windows. GitLab (M5-06, optional) left |
| [M6](#m6--deployment--workflow-canvas-v04) | v0.4 | Deploy adapters, workflow canvas | ◐ Built ([deploy-and-canvas.md](design/deploy-and-canvas.md)): Vercel, Cloudflare Workers, Firebase, Fly.io and Docker adapters, production with typed confirmation and rollback, the workflow canvas; left: live deploys with the owner's logins (E1), canvas Import/Export by hand |
| [M7](#m7--evals--analytics-v05) | v0.5 | Evals & analytics | ◐ Metrics, the eval benchmark and the CI report check in ([evals.md](design/evals.md)); OpenTelemetry deferred; E1 ticks with the first PR that changes a workflow |
| [M8](#m8--multi-folder-workspaces--agent-fleet-proposed) | later | Multi-folder workspaces, agent fleet | ◐ All six built: multi-folder workspaces, the fleet view, supervisor and worker sessions, agent profiles, scheduled runs, lessons; M8-07 (resuming a multi-folder chat) fixed in #119 |
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
- **Windows 11: the UI click-through of E1–E5 passes** (2026-10-31, `pnpm dev`, haiku, ≈$0.03). Claude drove the app
  through WebView2 remote debugging, clicking and reading the page as a user would:
  - E1: in Safe, Bash, Edit and Bash each asked; the diff viewer showed one hunk; staged and committed from the Git
    panel under the owner's identity.
  - E3: Rewind files to the first message brought `src/cart.js` back to the seeded bug.
  - E4: Stop during `sleep 60` ended the turn at 16 s; the next message got "alive".
  - E2: the app was killed, relaunched, and the session resumed from Previous sessions; the agent named the file.
  - E5: with Plan first picked in the mode menu, *Review the plan* appeared (Reject, Revise, Approve & run); the
    subagent card showed during execution and the subagent asked for its own Edit; tests pass.
  - Fixed from it: recent workspaces listed one folder twice (case), the rewind notice said 0 files, and Home claimed
    the agent can't change anything outside the folder (#49); clippy failed on Windows only (#50).
- Still to do: the same runs on Ubuntu; E6 by hand on each OS (never automated: it would mean signing the user out);
  and the UI click-through on macOS and Ubuntu.

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

- [x] **M2-29** Carry license notices for git-source items: a `licensePath` pinned with its own hash and copied with
      the files. This unblocks cloudflare-security-audit.
      — evidence: git sources take `license: {path, sha256}` (a file inside the repository, no `..`). Apply checks it
      with the tree hash before anything is written, copies it next to the files of each copy step (in the lock and
      rolled back with them), and refuses when the copied folder already has a file of that name. The preview, the
      weekly source check and the update bot cover it too. `cloudflare-security-audit` pins its root `LICENSE`
      (sha256 `e598e694…`); `verify-catalog-sources.ts` passed for its tree and license (2026-10-30). Tests:
      `apply.test.ts` (copied, wrong hash, name clash, rollback) and `schema.test.ts` (paths). The item still needs
      its review before it's offered.
- [x] **M2-30** The gitleaks hook wrapper prefers a gitleaks on PATH and doesn't hash-check the tools-folder copy:
      prefer the pinned copy and check it against its marker.
      — evidence: the committed wrapper (`git-hooks.ts`) looks for the item's exact pinned version in the app's tools
      folder first and checks its sha256 against `binarySha256` in `.agentchainer-tool.json`; a copy that fails the
      check stops the commit, and gitleaks on PATH is used only when no pinned copy is installed. The local
      `.git/hooks/pre-commit` checks the same way. Tests: `git-hooks.test.ts` commits through both hooks (pinned
      preferred over PATH, a changed copy stops the commit, PATH only, neither); on Windows the same commits were run
      by hand through Git Bash with the same results (2026-10-30).
- [x] **M2-31** `merge-json` replaces arrays. Merge permission lists (allow/deny) by union, so an item can add a deny
      rule to `.claude/settings.json`.
      — evidence: `mergeJson` (`bootstrap/steps.ts`) keeps the rules in `permissions.allow`, `ask` and `deny` and adds
      new ones once each; other arrays (an MCP server's `args`) are still replaced. Tests: `steps.test.ts` (unit) and
      `apply.test.ts` (a deny rule added next to existing ones in `.claude/settings.json`, then a rollback restores it
      byte for byte).
- [ ] **M2-32** Re-pin codebase-memory-mcp to 0.12.1 (the weekly bot proposes it) and review it again; it needs two
      reviews as a community item.
      Progress (2026-10-31): re-pinned to 0.12.1 by the update bot once it passed the 14-day minimum; hashes checked by
      `verify-catalog-sources.ts`. A [draft review](catalog-reviews/2026-10-31-codebase-memory-mcp-0.12.1.md) proposes
      approval. It found the binary makes no outbound requests and the 0.11.0 security fixes are in. It also found that
      the web UI on 127.0.0.1:9749 is on by default with no sign-in (0.11.0 too). The owner chose to disclose it in
      `permissions` rather than pass `--ui=false`, which is saved for the whole account. Remaining: two signed reviews.

### More catalog items (after v0.1)

Owner request (2026-11-05). Not part of M2's exit criteria or of v0.1. Each candidate gets the
[§4 review](CATALOG.md#4-review-checklist-adding-or-updating-an-item) like the seed items, and its tier comes from
that review, never from the list it was found on.

- [ ] **M2-33** Pick useful MCP servers for the catalog from
      [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) (MIT; read at `29f2d49`, 2026-11-02).
      - **The list:** about 5,000 lines in 60+ categories. Its 🎖️ "official" mark is the submitter's own claim: some
        entries marked official are published from personal accounts, not by the vendor. It's a source of candidates,
        not of trust.
      - **Where to look:** the categories that serve work in a repository: Version Control, Developer Tools,
        Databases, Cloud Platforms, Monitoring, Security, Browser Automation, Code Execution, Search & Data
        Extraction.
      - **What qualifies:**
        - published by the tool's vendor from its own organization (`verified-vendor`);
        - a pinnable release: an npm or PyPI version, or a release asset with its sha256;
        - a detection signal that can offer it, such as a Terraform, Supabase or Cloudflare config in the repo.
        - Servers that need a sign-in follow ADR-0002: the user's own environment provides the token, as with
          `github`, and the app never handles it.
      - **First candidates (verify each):** `cloudflare/mcp-server-cloudflare`, `hashicorp/terraform-mcp-server`,
        `awslabs/mcp`, `supabase-community/supabase-mcp`, `localstack/localstack-mcp-server`.
      - **Done when:** a note in `catalog-reviews/` lists what was considered and why each was taken or left. The
        accepted items are in `catalog/items/`, with the profiles or detection rules that offer them.
- [ ] **M2-34** Review [api-anything](https://github.com/goodnight000/api-anything) as a `community` MCP item (MIT;
      created 2026-09-27; read at `6617d9e`, 2026-11-04).
      - **What it does:** it learns an HTTP API for a website that has none, from the site's own frontend in a
        headless browser, and serves it over MCP (`api-anything mcp`).
      - **What the review must settle** (from its README; verify at the pinned version):
        - **Install:** its `setup` edits agent config files and adds a skill. ADR-0005 rules out upstream install
          scripts, so the item registers the pinned package itself (`npx -y api-anything@<version> mcp`) and never
          runs `setup`.
        - **Network:** search words go to a shared catalog (a Cloudflare Worker). With sharing on, as `setup` leaves
          it by default, learned operations and usage reports go there too. An idle server also runs a few checks a
          day. The item turns sharing off (verify how for `mcp`), or `permissions` says plainly what's sent.
        - **Credentials:** `login` imports cookies from signed-in browser profiles. Specs keep references, not the
          cookies. That's `high` risk and must be stated. The app itself never reads them (ADR-0002).
        - **Writes:** these are blocked unless `--allow-writes` is passed. The item never passes it.
        - **Terms:** the README leaves each site's terms to the user. The item's `why` says so.
        - **Age:** the project is about five weeks old, and the pinned release must clear the 14-day minimum.
      - **Tier:** `community`: two reviews, never pre-selected.
      - **Done when:** the review is in `catalog-reviews/` with a decision.

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
  - Progress (2026-11-04), built as Workspace settings → Plugins
    ([ADR-0010](adr/0010-unreviewed-marketplace-plugins.md)):
    - **The listing:** the user's CLI lists 3,920 plugins (`claude-plugins-official` and the built-in
      `anthropic-plugin-directory`).
      - The catalog's 8 approved plugins are marked Reviewed; everything else is Not reviewed.
      - Search, a Reviewed-only filter, 100 rows at a time.
    - **The detail pane:**
      - publisher, versions (installed, listed, reviewed), marketplace, a source link at the pinned commit, installs;
      - license, permissions and risk for reviewed plugins;
      - for installed ones, the CLI's inventory, flagging hooks and MCP servers as running code.
    - **Changes:**
      - Install… with the scope (local by default when unreviewed) and the not-reviewed notice. A command the
        marketplace declares is confirmed by a person first.
      - Update, turn off/on, Uninstall.
      - Installs are History runs, with lockfile entries.
    - **Live check** with CLI 2.1.293 in a scratch repo, through the sidecar's JSON-RPC:
      - the listing;
      - an unreviewed plugin installed locally, its details, off and on, uninstalled;
      - a reviewed plugin installed at project scope and rolled back from History;
      - the settings files and `installed_plugins.json` clean afterwards.
    - Clicked through in the app on macOS, in light and dark (2026-11-04, a debug build, haiku ≈$0.02 for the
      self-test turns):
      - the list and search, a reviewed plugin's detail (risk, license, review, permissions) and an unreviewed one's;
      - Install… with the not-reviewed notice and the local default, and a real install;
      - the Installed tab, then Uninstall with its confirm. The scratch repo's `.claude/` was gone afterwards.
    - Fixed from the click-through:
      - a local install showed as Off: the CLI reports `projectEnabled: false` for it, which is about the shared
        settings file only;
      - "1 agents";
      - the radio buttons sat below their labels: radios got the text inputs' 32 px height;
      - the not-reviewed notice still said "before you install it" on an installed plugin;
      - the configure command wrapped mid-word.
    - Open: the owner's own look.
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
  - Clicked through in light and dark on Windows (2026-10-31, `pnpm dev`, haiku, ≈$0.02): request, drafting, the
    review with triage and a tier override, approve and run, the run's approvals, Done, gates, the evidence report,
    the folded contract on reopening, and the task list. Fixed from it: the Add button under Affected areas sat in
    the middle of the row; the evidence report scrolled inside the scrolling page, with a banner-sized title and
    cramped sections; its gates table said "." for the root package (now "root").
  - Open: the owner's own look in both themes.
  - Superseded by UX-13 (owner, 2026-11-03): a task becomes a chat thread with cards instead of a page.
- [x] **UX-12** A complete chat room. → design: [chat-and-tasks.md](design/chat-and-tasks.md) §4. Owner request,
      2026-11-03: Shift+Tab cycles the mode; slash commands with descriptions and the app's own commands; question
      cards for `AskUserQuestion`; the agent switches to plan mode by itself (`EnterPlanMode`); input history,
      attachments and an editable queue; a todo panel, a context meter and compaction dividers.
      Note: built (step 1 of the design). Checked live against CLI 2.1.314: 72 commands with descriptions arrive
      before the first message; an `AskUserQuestion` round trip in the app (an option and an "Other" answer, both
      used by Claude; Skip); Claude's own `EnterPlanMode` switches the chat to Plan first with "Back to Safe"; the
      context meter, `/cost`, Shift+Tab and ↑ history; light and dark. Not checked live: a compaction divider and the
      todo panel (unit tests only).
      Follow-up (owner, 2026-11-03): Claude's questions are tabs, one at a time, with a Submit tab, keys 1–9 and ←/→;
      the composer's border shows the mode (Standard violet, Plan first cyan, Autonomous orange, Safe neutral, with
      the mode's name beside it); the models are the CLI's own list and names (`supportedModels()`), kept for the
      start screen and Settings; Enter on a `/` command runs it, and `/model`, `/mode`, `/effort`, `/usage` (alias
      `/cost`, `/stats`, `/context`) and `/help` open a picker or a panel above the composer. Checked in the app.
      Follow-up (2026-11-03):
      - The todo panel never appeared: the to-do tool is off by default for SDK sessions on newer models
        ([todo tracking](https://code.claude.com/docs/en/agent-sdk/todo-tracking.md)). Sessions now set
        `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, which gives `TodoWrite` on CLI 2.1.314 (probed live).
      - The ⇧⇥ chip is gone (owner, 2026-11-03). A context ring fills up as the context is used; its label says what's
        left, and a click runs `/compact`.
      Checked live with haiku in the app: a TodoWrite list showed "Todos 1 of 3 done" with its three items; `/compact`
      and a click on the ring each added the "Earlier messages summarized" divider (48k → 9k tokens).
- [x] **UX-13** One thread for chats and tasks (§5). One New with a Chat | Task switch; tasks as tabs with the right
      panel; drafting streams in the thread; the contract and triage as editable cards refined by replying; steps
      stream in the thread and the running step can be messaged; approvals and results as cards; a Task tab; "Make
      this a task".
      Note: step 2 is built: one New (Chat | Task in the composer; ⌘⇧N opens a chat in Task mode; `/task <what>` makes
      a task from a chat, with its last messages as drafting's context); tasks open as tabs with their own sidebar
      section and status; a task's thread shows the request, drafting as it reads (`agent.event`s on the `draft`
      step), the contract as a card (read, or edit in place) and triage, Approve on the card, and a composer whose
      reply redrafts the contract (`task.redraft`); a right panel with the task's facts; Home lists the workspace's
      tasks. The run, its results and the footer actions stay as they were inside the thread until step 3. Checked in
      the app with haiku: a task from an empty chat, streamed drafting, a reply that removed a constraint, Approve and
      run to Done with its gates, result and evidence in the thread; `/task` from a chat with history.
      Step 3 is built: the run's steps are blocks in the thread, with running steps' transcripts live (from their
      events, before the step records its session); a step's approvals and questions are cards in its thread (the
      dialog only for a task with no open thread); the composer messages the running step (`task.message`, which
      joins the step's turn); and an S, M or L task can run with **no budget** (owner request, 2026-11-03). Checked in
      the app with haiku: an Edit approval as a card, a message sent mid-step that Claude acted on ("the
      negative-percent test you asked for is in"), and a no-budget run to Done with "no budget" in the run, the panel
      and the evidence report. Evidence: #86 and this step's PR.
- [x] **UX-14** A live and AI-made workflow canvas (§6). A Flow tab shows the run's workflow with each step's live
      status, hand-offs and fix rounds; Generate with AI drafts project workflows; M/L/XL tasks may get their own
      flow, approved with the contract.
      Note: step 4 (the live flow) is built: a task's right panel has Task | Flow tabs; Flow draws the run's workflow
      (`task.workflow`) on the canvas with each step's state from the run's timeline (waiting, running, done, failed,
      stopped, not run; an icon and a word), its turns and cost, and the fix rounds used on each fix edge; clicking a
      step opens it in the thread. An XL task draws its sub-tasks in rows by what they wait for; clicking one opens it.
      Checked in the app with haiku: a finished run's flow, a jump to its Implement step, and a new run drawn live
      (Implement running, Gates waiting, then both done). Evidence: #88.
      Step 5 is built: Generate with AI in the workflow editor (`workflow.generate`: the description, then a diff to
      keep or discard; nothing saved), and a draft S, M or L task's own flow (`task.proposeFlow`, shown on the Flow
      tab with "Use the tier's flow"), approved with the contract and followed by the run (`source: "task"`, its hash
      in the evidence and Metrics). Checked in the app: a generated S workflow that added a test planner (sonnet,
      ≈$0.02, passed the checks, kept in the editor, not saved); a task's own flow (Claude kept the S flow for a small
      task and said why), then a haiku run to Done whose run and evidence name the task's own flow.
- [ ] **UX-15** A proper title bar, like an IDE's. Owner request, 2026-11-03, with screenshots of today's bar and
      VS Code's: today the OS title bar and a separate native menu row take two rows.
  - On Windows and Linux: one custom title bar (`decorations: false`, a drag region) with the icon, the menus (File,
    Edit, View, Help, the same items and shortcuts as `menu.rs`), the command palette's search field in the middle,
    the panel toggles (sidebar, right panel, terminal), and the window buttons (minimize, maximize or restore,
    close).
  - On macOS: the native menu bar stays, with an overlay title bar (`titleBarStyle: Overlay`) and the traffic
    lights inset.
  - It follows the theme (light and dark), with keyboard access to the menus (Alt opens them on Windows), double-click
    to maximize, and snap layouts on Windows 11 **(verify)**.
  - It needs the window capabilities (minimize, maximize, close, start dragging), with a THREAT_MODEL note.
  Note: built, in `TitleBar.tsx`.
  - Windows and Linux: `tauri.windows.conf.json` and `tauri.linux.conf.json` set `decorations: false`. The native
    menu is built on macOS only.
  - The bar holds:
    - the mark (`BrandMark.tsx`);
    - Radix Menubar menus with the same items and shortcuts as `menu.rs`, sent through `menu_select`;
    - Edit runs on what had focus, and Paste reads the clipboard's text through the official clipboard plugin;
    - the search field (it opens the palette and names the workspace);
    - the sidebar, terminal and workspace panel toggles;
    - minimize, maximize or restore, and close.
  - The menus' shortcuts are caught in the webview (`commandForKey`), and Alt alone focuses the menus.
  - macOS: `titleBarStyle: Overlay` with the traffic lights over the bar's inset left end.
  - Checked on Windows in the app (CDP), dark and light:
    - every menu;
    - Ctrl+Shift+P and Ctrl+\;
    - the toggles, and maximize and restore;
    - Edit → Select All, Cut, Copy and Paste with real clicks;
    - Alt.
  - Still to check by hand: dragging and snap layouts on Windows 11 (the custom buttons don't show the snap flyout
    **(verify)**), and macOS and Linux.
- [x] **UX-16** An app icon with its own meaning. Owner request, 2026-11-03: minimal like VS Code's, but on theme.
  - The idea: AgentChainer chains agents into checked work. The first sketch was two chain links whose join is a
    check mark; the owner chose three nodes linked into a check instead (2026-11-03), which reads at 16 px. Each node
    is an agent, each link a hand-off, and the chain they make is a check: work passed along and verified. It's a flat
    shape in one or two colors from the tokens, with no gradient or text.
  - Deliverables:
    - the SVG source in `apps/desktop/src-tauri/icons/`;
    - every size regenerated with `tauri icon`;
    - the title bar's and the About dialog's mark;
    - a monochrome version for the macOS menu bar or tray, if one is ever added.
  - No "Claude" or Anthropic marks (ADR-0002).
  Note: done.
  - `icons/icon.svg` is the dark theme's accent (`#7fb89a`) mark on its surface (`#1c201e`), on a rounded tile with
    the macOS grid's margin. Every desktop size (`.ico`, `.icns`, the PNGs) was regenerated from it with
    `tauri icon src-tauri/icons/icon.svg`; the mobile outputs aren't kept.
  - The title bar shows the same path (`BrandMark.tsx`, UX-15) in `currentColor`, which is also the monochrome
    version. The macOS About dialog uses the app icon.
  - Checked: the 128 px and 32 px PNGs read as the check on its tile.

### Exit criteria

- [x] **UX-17** A tidy workflow canvas. Owner feedback, 2026-11-03, with a screenshot of a task's Flow tab: "tampilannya
      masih kurang rapih".
  - The fix-loop labels ("fix round 0 of 2", "fix round 0 of 1") overlap each other and sit on the edges.
  - The dashed loop edges leave the nodes on their left side and run outside the column.
  - The nodes' subtitles are cut off ("format, lint, typecheck, test, build, sm…").
  - The zoom controls are heavy bordered boxes, unlike the app's other controls.
  - Wanted: loop edges that route cleanly beside the column with readable labels that never overlap; full subtitles,
    wrapping or with a tooltip; quiet controls. Checked in both themes, on the editor and on a task's live Flow tab.
  Note: done.
  - Each fix loop runs in its own lane right of the column. Its pill label ("fix ×2", or "fix 0/2" on a run) sits
    halfway along the lane, and its tooltip says where failures go.
  - Step details wrap to two lines.
  - Invisible spacer nodes make fitting the view keep room for the lanes and for the zoom controls, now one quiet
    panel.
  - A step a stopped run left "running" (the app closed mid-run) shows as stopped.
  - Checked over CDP on Windows:
    - the S and L workflows in the editor, dark and light;
    - an interrupted M task's Flow tab, where the two loops' labels no longer overlap and the controls cover no
      step.
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
- [x] **M3-E2** Every completed task has an evidence report whose gate results match the actual command outputs.
      - `live-task.ts` re-runs the last round's commands by hand and compares the report's gate runs with the
        recorded ones; a unit test checks the same (`evidence.test.ts`).
      - The eval benchmark checks every run it makes (`src/evals/run-case.ts`): the report's gate runs must be the
        recorded ones, and the last round's commands, run again by hand before the hidden files go in, must give the
        recorded exit codes. Its report has an "Evidence (M3-E2)" section.
      - Run (2026-11-04, macOS, `benchmark.ts -n 2`, the app's workflows on haiku, ≈$0.27): 14 tasks over the 7-case
        suite.
        - 14/14 reports held exactly their run's recorded gate runs.
        - 26/26 last-round gate commands gave the recorded exit code again.
        - This includes the 4 Go runs that ended Failed because `make lint` needs golangci-lint, which this computer
          doesn't have. Their reports recorded that failure, and the re-run failed the same way.
      - Evidence: the PR that adds the check, with the run's report in its body.

---

## M4 — Agent observability (v0.2–v0.3)

→ PRD [F4](PRD.md#f4--agent-observability-p1) · design: [observability.md](design/observability.md) (approved
2026-10-31)

- [x] **M4-01** Agent tree store built from normalized events (main → subagents → nested). Tracks status, current tool,
      start/end and attributable tokens and cost.
      Evidence: [#54](https://github.com/hafizhrf/AgentChainer/pull/54) (tree, `agent.progress`/`agent.updated`, the
      `subagents-nested` fixture) and the step-2 PR (≈USD from the session's cost per token, `agentUsd`).
- [ ] **M4-02** Live graph with `@xyflow/react` and dagre auto-layout (design §17). Nodes are agents and key tool calls; edges are spawns and hand-offs.
      Note: built (Chat | Graph in the session header, folding, keyboard), checked live on Windows with three
      parallel subagents; ticked with E2's 200-node frame times.
- [x] **M4-03** Node drawer: subagent prompt, transcript (SDK `getSessionMessages` / `agent_transcript_path`), tool calls, cost.
      Evidence: the live drawer (prompt, activity, tokens, ≈USD) in [#55](https://github.com/hafizhrf/AgentChainer/pull/55);
      stored transcripts through `getSubagentMessages` in the step-4 PR (a reopened subagent has no stored tokens or
      cost).
- [x] **M4-04** Timeline (Gantt) view that shows parallelism and waiting.
      Evidence: the step-3 PR. Chat | Graph | Timeline, one turn at a time; approval waits recorded per tool call
      (`permissionAsked`/`permissionAnswered`) and drawn on the owning agent's row; tests on both subagent fixtures.
      In the app on Windows with haiku: three parallel subagents as overlapping bars, and a subagent's Bash approval
      as a 21 s wait on its row; light and dark checked.
- [x] **M4-05** Controls: interrupt the session; stop a single subagent if the SDK supports it (verify).
      Evidence: `session.stopAgent` → `Query.stopTask` (SDK 0.3.311); in the app on Windows, Stop this agent ended a
      subagent mid-`sleep` as stopped while the rest of the turn finished (step-2 PR).
- [x] **M4-06** Agent library manager: list, create and edit `.claude/agents/*.md` and programmatic agents; mark each as manual or auto-spawned.
      Evidence: the step-6 PR ([design §10](design/observability.md)).
      - What it does:
        - `agents.list`, `agents.save` and `agents.delete`, behind Workspace settings → Agents;
        - project agents can be created, edited, renamed and deleted, each change as a run History can roll back;
        - the user's agents are listed read-only;
        - Auto/Manual rewrites the "use proactively" wording.
      - Tests: `agents.test.ts`, covering listing, the wording, the YAML, and create, rename and delete with rollback.
      - In the app on Windows:
        - edited an agent to manual, keeping its `color`;
        - created one whose description has a colon;
        - deleted it, then rolled the delete back from History;
        - checked light and dark.
      - The CLI listed both agents in `system/init`.
      - Programmatic agents: the app defines none for its sessions, so there are none to list.
- [x] **M4-07** Background tasks and shells panel.
      Evidence: the step-5 PR ([design §8](design/observability.md)).
      - Interactive sessions run background work: `background.changed`, `turn.started` for the CLI's own turn, Stop per
        task, and `perTaskStopAffordance`. Task steps, generators and triage stay in the foreground.
      - Tests: the recorded `subagents-background` fixture (CLI 2.1.314), and Session tests for the CLI's own turn.
      - The M1 exit run on Windows passed 8/8 with background on.
      - In the app on Windows:
        - a background subagent outlived its turn and showed in the strip and the sidebar;
        - Esc stopped the turn but not the background tasks;
        - Stop ended a background shell;
        - the CLI's own turn reported back.
      - Not in: a shell's output tail; the SDK has no public method for it yet.
- [x] **M4-08** Replay a finished session as a graph.
      Evidence: the step-4 PR. `session.history` adds each subagent's stored transcript (`listSubagents`,
      `getSubagentMessages`) under its spawn call, plus the stored times; `replayEvents` tests cover nesting, order,
      side agents, times and stopped/failed. In the app on Windows: a reopened session showed its five subagents in
      the graph, with long Bash calls as nodes, the timeline matched the live run (9.2 s vs 9.1 s), and the drawer
      showed a subagent's prompt and tool calls.

### Exit criteria

- [x] **M4-E1** A session with ≥ 3 parallel subagents renders correctly live and on replay.
      Evidence (Windows, haiku): three parallel subagents live in the graph and timeline (#55, #56), then the same
      session reopened with the same agents, nesting and times (step-4 PR).
- [ ] **M4-E2** Pan and zoom hold 60 fps with 200 nodes on the slowest supported WebView.
      How to run, after a debug build: `node scripts/graph-bench.mjs`. It pans, then zooms, a synthetic 200-node
      session graph for 4 s each, with no model calls: fitted to the window, then close up at zoom 1. A second with
      nothing moving comes first; when even that is below 55 fps, the window was covered and the run doesn't count.
      - Windows (2026-11-01): passed. WebView2 (Edge 156), 144 Hz display, 1280×780:
        - pan: 143 fps, p95 7.1 ms, 0.3% dropped;
        - zoom: 144 fps, p95 7.2 ms, 0% dropped.
        - That ran before the canvas fix below, which only takes paint work away; the next Windows run checks it
          again, with the close-up phases.
      - macOS (2026-11-04): passed after a fix.
        - Hardware: an Intel MacBook Pro 16" (2019) with UHD 630 and Radeon Pro 5300M, the built-in Retina display at
          60 Hz, a 1280×800 window @2x.
        - Build: a debug build (`tauri build --debug`; the UI is Vite's production bundle).
        - Conditions: Low Power Mode off, on AC. The app's window was the frontmost on screen for the whole run
          (sampled every 1.5 s, other apps hidden), so WebKit wasn't throttling a hidden window.
        - Before: pan 22–23 fps (p50 43 ms), zoom 34–41 fps.
        - Cause, from runs with parts of the graph left out (idle frames ran at 60 fps throughout):
          - React Flow's `<Background>` is an SVG pattern the size of the canvas, repainted on every frame. Without
            it, pan rose to 45 fps;
          - the nodes' text and icons at zoom 0.1, where it can't be read;
          - script was about 1 ms a frame, and the edges cost nothing measurable.
        - Fix:
          - a CSS dot grid (`graph/DotGrid.tsx`) that the compositor moves and scales, repainted only when the zoom
            crosses a quarter octave, and not drawn when its dots would be under half a pixel;
          - below zoom 0.4, nodes are drawn as plain boxes.
        - After, two runs:
          - fitted (zoom 0.1): pan 59.8 and 59.9 fps, zoom 59.9 and 59.9 fps, p95 18 ms, ≤ 0.4% dropped;
          - close up (zoom 1): pan 59.7 and 59.7 fps, zoom 59.9 and 59.1 fps, p95 18 ms, ≤ 1.7% dropped.
      - Still to run: Ubuntu (WebKitGTK, likely the slowest). The box is ticked once macOS and Ubuntu pass, and M4-02
        with it.

---

## M5 — Git workflow, PR & quality gates (v0.3)

→ PRD [F5](PRD.md#f5--git-workflow-prs-and-quality-gates-p1) · design: [git-workflow.md](design/git-workflow.md)
(approved 2026-11-01)

- [x] **M5-01** Each task runs in an isolated worktree and branch. Parallel tasks are supported, with a warning when two touch
      the same files. Worktrees are cleaned up afterward.
      Evidence: the step-1 PR ([design §3](design/git-workflow.md)).
      - Every tier runs in `.agentchainer/worktrees/<id>` on `agentchainer/<id>`, behind a "Task branch" setup step
        that installs dependencies.
      - Merge and Clean up work for every tier; each commits what the run left on the task's branch first.
      - `task.overlaps` drives a warning on the task page.
      - Tests: `service.test.ts` (branch, no git, merge, keep work on Clean up, overlaps) and `orchestrator.test.ts`
        (setup step).
      - Live on Windows (haiku): an S task ran in its worktree, `npm install` 1.1 s, then the gates; Clean up worked.
      - In the app: two M tasks touching `src/cart.js` showed the warning; Merge committed and merged the first; Clean
        up kept the second's work on its branch.
- [x] **M5-02** PR creation (gh CLI or GitHub API) with the contract and evidence report in the body.
      Evidence:
      - [#63](https://github.com/hafizhrf/AgentChainer/pull/63) built it: `github.status`, `task.prPreview` and
        `task.createPr` through the user's `gh`, and the GITHUB_SETUP guide.
      - Tests: `github.test.ts`, plus `service.test.ts`, which pushes to a local bare remote with a `gh` stand-in.
      - Live (2026-11-01): `live-task.ts --tier S --cwd <clone> --pr` on the private test repository
        `hafizhrf/agentchainer-e2e`.
        - The S task fixed the seeded bug in its worktree, and the gates passed (≈$0.01, haiku).
        - It opened draft PR #1 into `main`, with the contract and the evidence in its body.
        - The repository's `test` workflow passed on it.
- [x] **M5-03** CI status polling, plus a "Fix CI" loop that reads failing logs. The loop is gated by approval and budget.
      Evidence: the step-3 PR ([design §6](design/git-workflow.md)).
      - Requests: `task.prStatus`, `task.ciLog` (the PR's own GitHub Actions checks only; last 32 KB, redacted) and
        `task.fixCi` (one approved round; gates; commit and push only when they pass; 3 rounds per PR).
      - Tests: `github.test.ts`, `orchestrator.test.ts` (the round, the log as data, a failing gate), and
        `service.test.ts` (the PR's own checks only, failing checks only, the round cap).
      - Live on `hafizhrf/agentchainer-e2e`, haiku, ≈$0.02, through `live-task.ts --pr --fix-ci`:
        - PR #2 was opened;
        - a commit that rounds discounts up made CI fail;
        - the log was read: `actual: 900, expected: 899`;
        - one Fix CI round fixed the code; the gates passed; it was pushed;
        - CI passed on the fix.
- [x] **M5-04** Merge gates: independent AI review of the diff, plus deterministic scanners (gitleaks; semgrep and trivy if installed).
      Evidence: the step-4 PR ([design §7](design/git-workflow.md)).
      - `task.mergeGates` checks the local gates, a review of the current head, gitleaks, offline semgrep and trivy, and
        CI. `task.reviewPr` runs the independent reviewer on the PR's diff.
      - Tests: `service.test.ts`, `scanners.test.ts`, and `orchestrator.test.ts` (`reviewPr`).
      - Live on `hafizhrf/agentchainer-e2e` PR #2:
        - the review gate was missing at first;
        - **Review the PR** ran: approve, no must-fix findings, ≈$0.07;
        - after it, the review and CI gates passed;
        - the scanners showed "not installed".
- [x] **M5-05** Merge, force push and release tags always require a human.
      Evidence:
      - [#66](https://github.com/hafizhrf/AgentChainer/pull/66):
        - `task.mergePr` runs only from the Merge dialog, with `--match-head-commit` and never `--auto`, and asks for a
          reason when a gate isn't green;
        - the guard denies agents `gh pr merge`, `gh release`, writes through `gh api`, tags, and pushes that delete
          refs;
        - tests: `guard.test.ts` and `service.test.ts`.
      - Live (2026-11-01): the owner clicked **Merge** in the app on `hafizhrf/agentchainer-e2e` PR #3. It merged at the
        reviewed head `504950c`, as merge commit `cfc5755`. The task recorded `pr.merged`, and its evidence says
        "Merged by a person".
- [ ] **M5-06** GitLab support (optional).

### Exit criteria

- [x] **M5-E1** End to end on a test repo: task → worktree → gates → PR → CI green → human merge.
      Evidence (Windows, in the app, on the private test repository `hafizhrf/agentchainer-e2e`, haiku, ≈$0.09):
      1. The task was drafted (the S triage) and approved.
      2. It ran in `.agentchainer/worktrees/<id>` on `agentchainer/<id>`, with `npm install`, a red baseline and green
         gates.
      3. Create PR opened PR #3 (draft, with the contract and evidence), and its `test` check passed.
      4. Review the PR approved it, with no must-fix findings, and the merge gates were green.
      5. The owner merged it from the app; `main`'s CI passed after the merge.
      - The run exposed two bugs, fixed in [#67](https://github.com/hafizhrf/AgentChainer/pull/67): a blocking push
        restarted the sidecar, and the push depended on git's credential helper.
      - Fix CI was checked live separately ([#65](https://github.com/hafizhrf/AgentChainer/pull/65), PR #2).

---

## M6 — Deployment & workflow canvas (v0.4)

→ PRD [F6, F7](PRD.md#f6f9-p2) · design: [deploy-and-canvas.md](design/deploy-and-canvas.md) (approved 2026-11-01)

- [ ] **M6-01** Deploy adapter interface (detect, plan, deploy, smoke, rollback), with adapters for Vercel, Cloudflare (wrangler),
      Fly.io, Docker image → registry, and Firebase.
      Note: step 1 is built: the interface, CLIs run without a shell (npm shims resolved; wrangler checked live), the
      Vercel adapter, `deploy.targets`, `deploy.preview` and `deploy.list`, the task page's Deploy card, and records in
      `.agentchainer/deploys/`. Tested with stand-in CLIs. A live Vercel deploy waits for the owner's `vercel login`.
      Step 2 adds Cloudflare Workers: preview through `wrangler versions upload --preview-alias`, rollback to a
      version; Pages configs are detected and deferred. Tested with stand-in CLIs and wrangler's output shape.
      Step 4 adds Firebase Hosting (channels for previews, `hosting:clone` to roll back) and Fly.io (production only,
      rollback by redeploying the recorded image). Tested with stand-in CLIs; firebase-tools checked against its 15.34.2
      source, flyctl only against its docs. Docker → registry follows in its own PR.
      Step 4b adds Docker → registry: the image is named on the Deploy page, `buildx build --push` pushes the
      commit's tag and `latest`, and rollback moves `latest` back with `buildx imagetools create`. Tested with
      stand-in CLIs; the image form and the "Docker isn't running" state checked in the app.
- [ ] **M6-02** Environments are labeled preview or production. Production deploys always need explicit human approval.
      Credentials stay in each provider's own CLI.
      Note: step 3 is built: Workspace settings → Deploy plans a production deploy of the current branch (command,
      project, branch and commit), refuses a dirty tree or a detached HEAD, and runs only after the project's name is
      typed; the sidecar checks the name and the commit again. Checked in the app with a seeded workspace (the dialog
      only, no live deploy) and with stand-in CLIs.
- [ ] **M6-03** Post-deploy smoke test and one-click rollback.
      Note: the smoke test is in the step-1 PR: `scripts/smoke.*` with `SMOKE_URL`, or a GET that must answer 2xx. The
      Vercel adapter has its rollback command; the Roll back button arrives with production (step 3).
      Step 3 adds Roll back on the live production deploy: back to the recorded previous one (or the provider's own
      previous), typed-name confirmation, the smoke test again, and both records linked.
- [ ] **M6-04** Editable workflow canvas: React Flow ⇄ workflow YAML round-trip, with validation, import/export and sharing.
      Note: step 5 is built: a project's `.agentchainer/workflows/<tier>.yaml` replaces the app's workflow when it
      passes the library's checks (otherwise the app's runs and Workspace settings → Workflows says why); a run keeps
      a copy of the project workflow it started with, and the evidence names the file and its hash. The canvas
      editor is step 6.
      Step 6 adds the canvas (Workflows → Edit): React Flow from the YAML, a form per step that edits the YAML in
      place (comments kept), a YAML view, the sidecar's check as you edit, Save, Reset to the app's, Import and
      Export. Checked in the app on Windows except Import and Export, whose system file dialog the CDP checks can't
      drive (they're unit-tested); left unticked until those are tried by hand.

### Exit criteria

- [ ] **M6-E1** Preview deploy, smoke test and rollback work for at least 2 adapters.

---

## M7 — Evals & analytics (v0.5)

→ PRD [F8](PRD.md#f6f9-p2) · design: [evals.md](design/evals.md) (draft)

- [x] **M7-01** Local metrics dashboard: gate pass rate, cost per task, cost per successful task, duration, retries, human-fix rate.
      Note: step 1 is built: "Run again" keeps the replaced run as a summary in `task.runs` (workflow, model, end
      state, cost, gate rounds, whether the last round passed, fix rounds, times), so retries can be counted.
      Step 2 adds `metrics.summary` and Workspace settings → Metrics: gate pass rate, cost per task and per
      successful task, run time p50/p90, retries, and tasks that needed a person, by tier and by workflow, each
      tile listing its tasks. Checked in the app with seeded task records; hand edits after Done are shown as not
      measured. Evidence: #78 (run history) and #79 (metrics and the view).
- [x] **M7-02** Eval harness: fixture tasks with acceptance tests, run headless to compare workflow templates, models and skill versions.
      Note: step 3 is built: `scripts/benchmark.ts` with the library in `packages/sidecar/src/evals/` (shared with
      `live-task.ts`), a 7-case suite in `test/evals/suite.json` with hidden acceptance tests, and a report with
      each variant's pass and cost delta against the baseline and 95% intervals. Variants are a model and/or a set
      of tier workflows (a folder, or `catalog/workflows/` at a git revision). Evidence: #80, and the first report
      (`packages/sidecar/test/evals/report.md`, step 4): 7 cases × N=3, an A/A run of `origin/main`'s workflows
      against the branch's, 21/21 each, ≈$0.75. Skill versions aren't a variant: `skills/` feed the setup generators,
      not task runs (design §5).
- [x] **M7-03** CI regression job for first-party skills and workflow templates.
      `scripts/check-eval-report.ts` in the Checks job fails when a tier workflow or role prompt differs from the
      files the committed report was made with (shown failing on an edited `s.yaml`, passing when restored).
- [ ] **M7-04** Optional OpenTelemetry export (verify Claude Code's OTel support).
      Deferred (owner, 2026-11-02): the app sends no telemetry (X-04), and Claude Code's OTel settings need
      verifying first. Reopen when a user asks for it.

### Exit criteria

- [ ] **M7-E1** A change to a workflow template reports its success and cost delta on the benchmark before merge.
      Note: in place since M7-03: CI blocks a workflow change until its report is committed, and CONTRIBUTING asks
      for the report's summary in the PR. Ticked with the first PR that changes a workflow and carries its delta.

---

## M8 — Multi-folder workspaces & agent fleet (proposed)

→ PRD [F9](PRD.md#f9--multi-folder-workspaces-p2). Owner requests, 2026-10-30. Several ideas come from
[CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (CAO, AWS Labs, Apache-2.0). They're
reference only: no code is copied, and each one gets a plan before it's built.
→ design: [workspaces-and-fleet.md](design/workspaces-and-fleet.md) (draft; M8-01 and M8-02 in detail, M8-03…06
sketched). Owner decisions (2026-11-03): workspace definitions live in the app's settings; the fleet view is built
first.

- [x] **M8-01** Multi-folder workspaces (F9): a workspace is a named set of folders, e.g. an app repo and its API
      repo.
  - Sessions run in the primary folder and add the others with the SDK's `additionalDirectories` (the CLI's
    `--add-dir`; in the installed SDK's types).
  - Readiness, the setup plan and git work per folder, and the guard allows all the workspace's folders.
  - Tasks name the folder in their affected areas; XL sub-tasks can target different folders, each in its own
    worktree.
  - Checked live on CLI 2.1.314: project settings, hooks and CLAUDE.md load only from the primary folder, not from
    the added ones.
  - The definition lives in the app's settings (owner decision, 2026-11-03).
  - Progress (design §10, steps 2 and 3, #91):
    - workspaces are saved in settings, from a New workspace dialog;
    - Home and the sidebar list them, and a session started from one gets `session.start {folders}`;
    - `additionalDirectories` is passed, and the guard allows recursive deletes inside any of the folders;
    - the sidecar refuses a relative path, a drive, the home folder, a repeat or a nested folder;
    - a resumed chat keeps its folders.
  - Step 4:
    - in a multi-folder session, a folder switcher above the right panel picks which folder its changes, files,
      diff and git show;
    - Workspace settings switch between the workspace's folders too, so readiness, the setup plan, commands and
      permissions are per folder.
  - Step 5a:
    - a task made from a multi-folder chat works across its folders (`task.create {folders}`);
    - drafting reads them and names areas `api:path`;
    - each git folder gets a worktree on the task's branch, and steps reach the other worktrees;
    - gates run in each folder with its own commands;
    - the evidence lists changed files as `api:path`, and the secrets scan covers them;
    - Merge and cleanup cover every folder, and a PR's body says which folders' branches aren't in it.
    Checked live with haiku (≈$0.013) on two scratch git repos:
    - drafted areas `api:routes.js`, `api:routes.test.js` and `README.md`;
    - both worktrees were set up, and `npm test` passed in `.` and `api`;
    - the api checkout was untouched until Merge, which went into both folders' `main`;
    - cleanup removed both worktrees.
  - Step 5b, PRs:
    - Create PR opens a draft PR in each other repository the task changed, then the main one;
    - every repository's GitHub state, commits and gitleaks scan are checked before anything is pushed;
    - the main PR lists the others, and each links back to it (`gh pr edit`);
    - the task records each folder's PR, and its page lists them;
    - the preview says which folders get their own PRs.
    Tested with a stand-in `gh` and local bare origins (`service.test.ts`). Not checked on real GitHub, which needs a
    second throwaway repository.
  - Step 5b, XL:
    - the split knows the folders and gives each sub-task one (`Task.folder`);
    - the XL task branches in every folder (all must be in git) and sets them all up;
    - a sub-task branches from the task's branch in its own folder's repository and merges back there;
    - the baseline and integration gates run in every folder.
    Checked live with haiku (≈$0.036) on two scratch repos:
    - the split put "Add ready() to api routes" in `api` and the client helper in the main folder;
    - both sub-tasks ran and merged, and the integration gates passed in `.` and `api`;
    - the evidence lists `api:routes.js`;
    - Merge went into both folders' `main`, and cleanup left one worktree in each.
    Evidence: #91, #92, #93, #94 and this step's PR.
- [x] **M8-02** A fleet view: every running session and task step across workspaces, with live status (working,
      waiting for approval, idle, done), cost, and one click to open it. From CAO's dashboard and status badges; it
      extends M4's agent tree.
      Note: built (design §4, step 1). Sessions track their own fleet status (working, waiting for the person, idle,
      ended) and report it (`fleet.list`, `fleet.changed`); the Fleet page groups chats and task steps by workspace,
      the ones waiting first, with time in status, cost, Answer or Open, and Stop; the sidebar's Fleet entry counts
      what's waiting and working. Checked in the app: a chat waiting for an approval in one workspace and a task step
      waiting in another at once; Answer opened the task's thread at its approval card; Stop moved the chat to idle
      and ended the task. Not built: listing a row's subagents (the session's graph has them).
- [x] **M8-03** Supervisor and worker sessions: a supervisor session hands work to worker sessions (assign, hand
      off, send a message, an inbox) through an in-app MCP server, under the app's approvals and budgets. From CAO's
      supervisor/worker model; it goes beyond XL's fixed split (M3-07).
      → design: [supervisor.md](design/supervisor.md) (owner decisions, 2026-11-03).
  - Sidecar (PR 1): the Team, its in-process MCP server and `session.opened`. Unit tests, and the live `team`
    scenario on haiku: 5 of 5 checks passed, about $0.03.
  - UI (PR 2):
    - a **Team** toggle in a new chat's composer (the chat starts over as a Team chat, with Settings' cap or $2);
    - worker tabs nested under their supervisor, with their access;
    - Team tool rows named by what they do, with a `read`/`write` badge;
    - worker reports as cards;
    - the team's spend against its cap in the composer;
    - "worker of …" rows in the fleet view.
  - Checked in the app over CDP, dark and light, on haiku:
    - a read worker and a write worker were assigned;
    - the write worker's approval showed in its own tab, and the sidebar and Fleet showed it waiting;
    - `notes.txt` was written after Allow once;
    - both reports reached the supervisor as cards, and it summed them up;
    - closing the supervisor ended both workers.
- [x] **M8-04** An agent profiles manager: create from a template, edit, clone and delete, validated before saving,
      with per-profile tool allowlists. From CAO's profile editor; builds on M3-05's roles and UX-10's Plugins page.
      → design: [agent-profiles.md](design/agent-profiles.md) (owner decisions, 2026-11-03).
  - Sidecar (PR 1):
    - `agentProblems` checks;
    - `agents.templates`;
    - user-scope saves;
    - profiles running chats (`session.start {profile}`) and Team workers, with only their tools.
  - Evidence: unit tests, and the live `profile` scenario on haiku, 3 of 3 passed. It checked that:
    - an unknown tool is refused;
    - a chat ran as a read-only profile with its prompt and model, and Write was "No such tool available";
    - a Team worker ran as the profile.
  - UI (PR 2), in Workspace settings → Agents:
    - Start from (a task role, whose copy gets a free `-copy` name, or a starter);
    - Clone;
    - Save to (this project, or all my projects after a confirm);
    - editable user agents;
    - a grouped tool picker with MCP entries;
    - problems listed live, which keep Save disabled.
  - Also in PR 2:
    - an Agent profile select in the start screen's Options;
    - the profile shown as a chip in the session header and in the sidebar, and on Team workers;
    - `/clear`, the Team toggle and Resume keep the profile.
  - Checked in the app over CDP, dark and light:
    - the explainer starter filled the form, and a bad tool ("Teleport") was flagged live with Save disabled;
    - saving to the project wrote `.claude/agents/m804-explainer.md`;
    - Clone, then "All my projects" and the confirm, wrote `~/.claude/agents/m804-explainer-copy.md`;
    - a haiku chat started as the profile showed its chip, used only Glob and Read, and didn't create the file it was
      asked to write;
    - both test agents were deleted through the UI, with the scope's wording in the confirm, and the empty user folder
      removed.
- [x] **M8-05** Scheduled flows: run a task template on a schedule (e.g. a nightly dependency bump), locally, with a
      budget cap and an evidence report per run. From CAO's flows.
      → design: [scheduled-flows.md](design/scheduled-flows.md) (owner decisions, 2026-11-03).
  - Sidecar (PR 1):
    - schedules in `.agentchainer/schedules.json`, checked once a minute;
    - one catch-up for a missed time;
    - runs in `acceptEdits` with the last run's model, tagged `scheduled`;
    - every run keeps `evidence-<n>.md`.
  - Evidence: unit tests, and the live `schedule` scenario on haiku, 3 of 3 passed:
    - an unknown task is refused;
    - a scheduled run started at its minute with the same model, and the next time moved a day on;
    - both runs kept their own report.
  - UI (PR 2):
    - **Schedule…** on an approved S/M/L task: presets, the next three times, the run's budget and model, and what a
      run may do on its own.
    - **Fleet → Scheduled:** every schedule, with its cadence, next and last run, an on/off toggle, Run now, Edit and
      Delete.
    - **OS notifications** through `tauri-plugin-notification` 2.7.0, asked for on the first save: a scheduled run
      needs an approval, or it ended.
    - A workspace with a schedule is remembered, so it stays watched after a restart.
  - Checked in the app over CDP (Windows, dark and light), on a sample-app task that had run on haiku:
    - It was scheduled daily at the next minute and fired at 22:56. The Fleet showed the step working, then the row
      showed "Ran today 22:56 · next tomorrow 22:56".
    - The run waited on a Bash approval ("Waiting for you", with notifications granted). Once it was allowed, the run
      ended and `evidence-3.md` was written.
    - Toggle off, Run now (then stopped), Edit and Delete all worked.
    - The recent workspaces were restored afterwards.
- [x] **M8-06** Lessons from outcomes: suggest CLAUDE.md additions from finished tasks' evidence, each one approved
      by the user (opt-in). From CAO's memory and self-learning loop.
      → design: [lessons.md](design/lessons.md) (owner decisions, 2026-11-03).
  - **Opt-in:** Suggest lessons on a finished task is the opt-in; nothing runs otherwise.
  - **Signals:** from the evidence, no model: gates fixed in a later round, the formatter's rewrites, must-fix and
    should-fix review findings, guard blocks, denied approvals, and the implementer's notes.
  - **Suggestions:** one haiku call words up to 5 lessons, each citing its signals. Duplicates of CLAUDE.md or of
    dismissed lessons are dropped, and so are home paths and token shapes.
  - **Adding:** picked lessons go under `## Lessons` in CLAUDE.md as a History run, after a diff; the rest are
    dismissed for the workspace.
  - **Live:** `spike-host.ts --scenario lessons` on haiku, about $0.01, 4 of 4 passed:
    - 4 lessons came from a run whose commands were denied, including "don't retry a denied command through another
      shell", which the run had done;
    - one was added as previewed;
    - it rolled back cleanly from History;
    - the rest were dismissed.
  - **In the app,** checked over CDP on Windows:
    - Suggest showed 2 lessons with their why, source chips and the CLAUDE.md diff;
    - adding 1 wrote it;
    - Workspace settings → History → Roll back removed it.
  - **Bug fixed along the way:** dismissing the rest used to change `.agentchainer/.gitignore` after the run was
    recorded, which stopped that run from rolling back cleanly. The entry is now written first.
- [x] **M8-07** Bug (owner report, 2026-11-04): a multi-folder workspace's chat resumes as a single-folder session in
      its main folder.
  - **Cause:** `resume()` (`App.tsx`) takes the folders from the session's open tab only
    (`tabs.find(…)?.folders ?? []`). Two paths have no such tab:
    - **Opening a stored session** from the sidebar or Home (`openStored`), e.g. after the app restarts. It resumes
      with `folders: []`, so Claude sees only the primary folder, and the guard, the changes panel and the git panel
      treat it as single-folder.
    - **A fork** (`forkTab`): the copy has no tab yet, so it loses the folders even while the original's tab has them.
  - **Fix:**
    - Record each session's folders when it starts, keyed by session id, in the app's data, not the repository.
    - Resume and fork use the record, and fall back to the named workspace whose primary folder is the session's
      folder.
    - The resumed tab shows the folder switcher as before.
  - **Check:** a unit test for the lookup. In the app: start a chat in a two-folder workspace, quit, reopen, resume
    it from the sidebar, and see Claude list both folders; then fork it.
  Note: done.
  - **Storage:** `settings.json` keeps `sessionFolders` (`settings.rs`): each multi-folder session's other folders,
    newest first, at most 200, normalized like the workspaces.
  - **Recording:** `startSession` records them, and so does every resume.
  - **Lookup:** `resume` takes the tab's folders, else the record, else the named workspace whose primary folder it
    is (`foldersFor`). A fork passes the original's folders.
  - **Tests:** `settings.test.ts` (3) and a Rust normalization test.
  - **Checked in the app over CDP (Windows), on haiku:**
    - a chat in a two-folder scratch workspace listed both folders;
    - after quitting and reopening the app, resuming it from Home's previous sessions showed "+1 folder" and read
      `ROUTES.txt` in the second folder;
    - its fork showed "+1 folder" and the folder switcher.

    The settings were restored afterwards.
- **Not adopted from CAO:**
  - other providers' CLIs (PRD §7 non-goal);
  - tmux terminal backends (the app has its own terminal and sessions);
  - an HTTP server with a web UI, since the sidecar has no network port (THREAT_MODEL T-05).

---

## Cross-cutting tracks (ongoing)

### Security & privacy

- [ ] **X-01** Threat model doc (`docs/THREAT_MODEL.md`), updated every milestone.
      - Written for v0.1 (R1-06).
      - Reviewed 2026-11-04 (THREAT_MODEL "Security review of 2026-11-04"):
        - a read-only review of what the 2026-10-29 audit didn't reach, each finding checked against the code, with
          9 findings fixed;
        - entries for the surfaces added since: the drawer, replay, session management, M7, on-demand actionlint;
        - the full command table.
      - Next review: end of R1. The box stays open: the review repeats every milestone.
- [x] **X-02** Least-privilege Tauri capabilities, a sidecar argument allowlist, and IPC validation on both ends.
      Replace the scaffold's `"csp": null` (Tauri template default) with a strict Content Security Policy.
      — evidence: the 2026-11-04 security pass.
      - **Capabilities:** one capability file, with no file-system or shell plugin. The command table in THREAT_MODEL
        covers all commands and their input checks.
      - **The sidecar** takes no arguments, and release builds always run their own bundled one:
        `AGENTCHAINER_SIDECAR_BIN` and `AGENTCHAINER_SELFTEST` work in debug builds only, with a unit test of the
        switch.
      - **IPC:** zod checks params and results in the sidecar (`rpc.ts`) and results and notifications in the UI
        (`rpc-client.ts`).
      - **CSP:** strict, now with `object-src 'none'`, `base-uri 'self'` and `form-action 'none'`.
      - **The Claude CLI path setting** must be an absolute path to an existing file.
- [x] **X-03** Secrets never appear in logs or the UI: a redaction filter covers logs, displayed tool output and diagnostics.
      — evidence: the 2026-11-04 security pass.
      - **One pattern file** (`packages/protocol/src/redact-patterns.json`), read by the UI, the sidecar and the Rust
        core.
      - **Shared vectors** (`test/redact-vectors.json`) run in both TS and Rust, with 17 cases: new key and token
        formats, private keys, URL credentials, already-masked text, and Windows home paths in JSON.
      - **Logs:** the app log and crash logs are masked line by line as they're written; diagnostics are masked as a
        whole.
      - **The UI** masks tool input and output, the drawer, gate tails, and deploy and smoke details. The approval
        dialog's editable input is left as it runs.
      - **Lessons** with a secret are refused.
      - PRIVACY "Secrets on screen".
- [x] **X-04** No telemetry by default. Any future telemetry is opt-in and documented.
      — evidence: the 2026-11-04 security pass found no telemetry, analytics or crash-reporting code or dependencies.
      The app's own network calls are the ones PRIVACY lists. Settings says "AgentChainer sends no telemetry".
      PRIVACY now also notes that the `claude` CLI's own data settings are the user's, and which deploy CLIs get
      their telemetry turned off.

### Quality & performance

- [x] **X-05** Weekly CI job runs the latest Agent SDK and CLI against the recorded-fixture contract tests, and opens an issue on drift.
      - Built (2026-11-04): `.github/workflows/drift.yml`, every Monday and on demand.
        - **The `sdk` job** moves the sidecar to the newest SDK that pnpm accepts (the release-age rule stays on), then
          runs `pnpm typecheck` and the sidecar tests, with the recorded-fixture contract tests.
        - **The `cli` job** installs the newest CLI's binary package (no install scripts) and runs
          `scripts/cli-contract.ts`. It checks:
          - every command and flag in `src/cli-contract.ts` (12 commands), against `--help`;
          - the minimum version;
          - that `auth status --json` still parses.
        - **The `report` job** opens one issue on a failure (or comments on it), and closes it on the next pass.
      - Checked by hand the same day:
        - SDK 0.3.317 (the pin is 0.3.311): typecheck and 486 sidecar tests pass;
        - CLI 2.1.293 and 2.1.318: all 12 commands and their flags pass.
      - Evidence, from dispatched runs on 2026-11-04 (#114, and the retries below):
        - [41820133570](https://github.com/hafizhrf/AgentChainer/actions/runs/41820133570): no drift. SDK 0.3.317
          and CLI 2.1.318 both pass.
        - [41821297123](https://github.com/hafizhrf/AgentChainer/actions/runs/41821297123), with `simulate: cli`:
          it opened [#115](https://github.com/hafizhrf/AgentChainer/issues/115).
        - [41821511002](https://github.com/hafizhrf/AgentChainer/actions/runs/41821511002): it passed again,
          commented on #115 and closed it.
      - The first two runs hit GitHub's incident that day: an internal error creating the report job, then a
        GraphQL error in `gh issue create`. Each `gh` call in the report job now gets three tries.
- [x] **X-06** E2E with `tauri-driver` on Linux and Windows. macOS uses a manual checklist (verify WebDriver support).
      - Built (2026-11-05):
        - **The tests:** `scripts/e2e/`, a WebDriver client over `fetch` (no new dependency), with `node:test` flows
          that need no Claude login:
          1. the setup check;
          2. opening the recent workspace, then Workspace settings;
          3. the "Ignore env and secret files" fix applied, checked on disk, and rolled back from History;
          4. the command palette opening a section;
          5. Settings saving the dark theme.
        - **Isolation:** each run uses temporary settings, data and a git copy of `fixtures/sample-app`. A failing
          flow saves a screenshot and the app log.
        - **CI:** the Build & launch jobs run the tests.
          - **Ubuntu:** `tauri-driver` 2.1.0 with WebKitWebDriver, under Xvfb.
          - **Windows:** the runner's msedgedriver (156.0.4314.50, the same as its WebView2 runtime) attaches to the
            app through WebView2's debugging port.
        - **What it took on Windows:** WebView2 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` once an app sets
          arguments of its own, which wry always does. So msedgedriver couldn't reach a Tauri app it launched
          ("DevToolsActivePort file doesn't exist").
          - A debug build now passes the variable on to its windows itself.
          - A debug build reads its settings from `AGENTCHAINER_CONFIG_DIR`, because Windows takes the config folder
            from the system.
          - Release builds ignore both (X-02, THREAT_MODEL).
        - **macOS:** [MANUAL_CHECKS.md](guides/MANUAL_CHECKS.md), linked from RELEASING.
      - **Evidence:**
        - CI run [41973492480](https://github.com/hafizhrf/AgentChainer/actions/runs/41973492480) (#127): 5/5 on
          Ubuntu and 5/5 on Windows.
        - Locally, in the Ubuntu 22.04 image (`scripts/e2e/Dockerfile`), 5/5 pass in 6–21 s, run after run. With one
          assertion broken on purpose, that flow failed and left its screenshot and log.
- [x] **X-07** Performance budgets for startup time, idle memory and stream latency, tracked every release.
      — evidence: [PERFORMANCE.md](PERFORMANCE.md).
  - **Budgets** (`scripts/perf-budgets.json`): startup 6 s; idle memory 600 MB (850 MB on Linux, where WebKitGTK runs
    partly in the app; 400 MB on macOS, where the WebView isn't counted); stream p95 50 ms.
  - **Measuring:** `scripts/perf-budgets.mjs` measures startup and idle memory through a new `startup` self-test
    bench, with no model call. `selftest-latency.mjs` now fails over the latency budget.
  - **Tracking:**
    - CI measures startup and idle memory on all three OSes on every run (not blocking) and keeps `perf-<OS>.json`;
    - RELEASING.md checks all three before a release.
  - **Windows 11 baseline** (debug build, 2026-11-05):
    - startup 1.6–1.7 s warm, 3.7 s cold;
    - idle memory 475–486 MB (WebView2 about 355, sidecar about 73, app about 42).

### Compatibility

- [x] **X-14** Test the packaged app behind an HTTP proxy (`NODE_USE_ENV_PROXY=1` is set; spike S1).
      — evidence: `scripts/proxy-smoke.mjs` (2026-11-05). It runs the packaged sidecar's first-run SDK download three
      ways, with a local CONNECT proxy that records its tunnels:
      - through the proxy: it succeeds, and the proxy saw `registry.npmjs.org:443`;
      - through a dead proxy: it fails with "offline or blocked by a proxy?", so nothing goes around it;
      - with `NO_PROXY=registry.npmjs.org`: it succeeds directly.

      It passed on macOS here, and runs in CI's Build & launch jobs on macOS, Windows and Ubuntu (this PR's checks).
      INSTALL's "Behind a proxy" and COMPATIBILITY say where to set the variables: the login shell's environment.
- [x] **X-08** Compatibility matrix in the docs (OS versions, CLI versions, SDK version). The health check enforces the minimum CLI version.
      — evidence: [COMPATIBILITY.md](COMPATIBILITY.md), covering:
      - OS and WebView, with what was checked by hand and in CI;
      - the CLI minimum and the versions used;
      - the SDK pin, and the weekly checks of both;
      - other tools, and building from source.

      `scripts/check-compatibility.mjs`, in CI's Checks job, fails when the page's CLI minimum or SDK pin differs from
      `MIN_CLAUDE_VERSION` or `sdk-pin.json`. Readiness enforces the minimum: an older CLI shows "Version older than
      2.1.293" with `claude update`, and the app isn't ready.

### Docs & community

- [ ] **X-09** Every decision that is expensive to reverse gets an ADR, and this checklist stays current.
- [ ] **X-10** User docs, a contributor guide, and good-first-issues tagged for each milestone.
      - User docs: [the user guide](guides/user/README.md), six pages with screenshots from the app (2026-11-06).
      - Contributor guide: [CONTRIBUTING](../CONTRIBUTING.md) refreshed, with a tour of the code (2026-11-06).
      - Good first issues: 20 drafts, two per area, in [GOOD_FIRST_ISSUES.md](GOOD_FIRST_ISSUES.md). The box ticks
        when the owner has reviewed them and they're created on GitHub.
- [ ] **X-11** Review [RISKS](RISKS.md) at every milestone boundary.
      - Reviewed 2026-11-05:
        - R-08, R-09, R-10, R-12, R-14 and R-15 are updated to what's built;
        - a new R-18 covers third-party outages.

        The box stays open: the review repeats every milestone.

### Accessibility & i18n

- [x] **X-12** Keyboard-first navigation, focus management, screen-reader labels, and sufficient contrast in both themes.
      - Built (2026-11-05):
        - **Audits:** `scripts/e2e/a11y.e2e.mjs` runs after the X-06 flows, in CI on Ubuntu and Windows.
          - It injects axe-core 4.14.0 (MPL-2.0, a pinned dev dependency that never ships in the app) and checks
            WCAG 2.1 A and AA.
          - Screens: Home, Workspace settings (Overview, Setup plan, Commands, Plugins, History), a confirm dialog,
            Settings and the command palette, each in light and in dark.
          - Serious and critical violations fail the run. Every violation goes to `e2e-artifacts/a11y-report.json`.
        - **Keyboard flows:**
          - Ctrl+Shift+P opens the palette, and Esc gives focus back to where it was;
          - Tab reaches the sidebar's New and Settings, with a focus ring at every stop;
          - Tab stays inside the Settings dialog, and Esc closes it.
        - **What the first run found, and the fixes:**
          - **Contrast, light theme:** `--muted` #646e69 → #58615c and `--warn` #a16207 → #8f5606, now at least 4.5:1
            on every light surface. The dark theme passed, apart from the New button's shortcut hint, which now
            shows at 85% instead of 60% opacity in both themes.
          - **Plugins:** the tabs pointed `aria-controls` at panels that weren't rendered while the list loaded or
            failed (critical).
          - **Focus return:** the palette and every Modal left focus on the page body when they closed, because
            Radix only gives it back to a Dialog.Trigger. `useReturnFocus` now gives it back to the opener, unless
            something else took it meanwhile.
          - **Scrolling (Windows only):** in the runner's smaller window, the Setup plan's detail pane scrolls but held
            nothing focusable, so the keyboard couldn't scroll it. That pane and the Plugins one are now focusable
            regions named "Details".
          - **Focus rings:** the title bar's menu triggers hid their ring. The resize handles had neither a ring nor a
            name; they're now "Resize the sidebar", "Resize the terminal" and "Resize the right panel".
        - **After the fixes,** axe reports no violations of any impact on the audited screens, in either theme.
        - **Test notes:**
          - The audit finishes running animations first: WebKitGTK under Xvfb is slow enough that axe once measured
            the palette mid fade-in.
          - The Tab flow starts at the page's first control, because Chromium keeps tabbing from the last focused
            element after `blur()`.
          - `run.mjs` runs the X-06 file first, on its own: `node --test` sorts the files it's given.
        - **macOS:** a VoiceOver and keyboard spot check in [MANUAL_CHECKS.md](guides/MANUAL_CHECKS.md) (checks 6–8).
        - **Not covered yet:** a session with a transcript (it needs a model call), the session graph and the right
          panel's tabs.
      - **Evidence:**
        - CI run [41987314583](https://github.com/hafizhrf/AgentChainer/actions/runs/41987314583) (#129): 5/5 X-06
          flows and 8/8 here on Ubuntu and on Windows. Windows' report lists no violations on its 9 screens. The
          run before found the Windows-only scrolling problem and the two test problems above.
        - Locally, in the Ubuntu 22.04 image (`scripts/e2e/Dockerfile`): 13/13 pass at 1440×900 and at 1024×768.
          With one icon button's label removed on purpose, the gate failed with `button-name` on every screen.
- [ ] **X-13** i18n-ready strings: English first, Indonesian next.
      - **Part 1, the UI (2026-11-05):** all of the UI's text is in catalogs, still in English (owner decision: no
        second language, and no Language setting, until one is wanted).
        - **The catalogs:** 1,785 keys in 11 area files under `apps/desktop/src/i18n/locales/en/`, read by a small
          module ([ADR-0011](adr/0011-ui-text-catalogs.md)), with no new dependency. The wording is unchanged, byte
          for byte.
        - **What moved:**
          - every string a person reads in the React UI;
          - the macOS menu: Rust reads `menu.json`, which the Windows and Linux title bar and the palette also use,
            so the three copies of the labels are now one;
          - nine cost helpers and three plural helpers, replaced by `format.ts` and `_one`/`_other` keys.
        - **Display text no longer drives logic:** "New session" marked a fresh tab, and is now an `untitled` flag.
          `/mode` accepts the mode's id as well as its name.
        - **Guards:**
          - Biome's `noJsxLiterals` at error level: 741 findings, now 0;
          - `i18n/catalog.test.ts`: no literal `label`, `title`, `placeholder` or `aria-label`, no unused key, every key
            in its area's file;
          - a debug-only pseudo-locale (`AGENTCHAINER_PSEUDO_LOCALE=1`), and an E2E phase (`i18n.e2e.mjs`) that fails
            on unmarked text in the title bar, sidebar, setup check, Settings, Workspace settings' navigation and the
            palette.
        - **Bundle:** all JS grows 2.0% raw and 1.3% gzipped. The catalogs load with the main chunk.
        - **Extraction:** four agents in separate worktrees, one area each. Each checked its slice for lint, literal
          props, typecheck and tests before the merge.
        - **Evidence:** CI run [41999892534](https://github.com/hafizhrf/AgentChainer/actions/runs/41999892534)
          (#131), on Ubuntu and on Windows:
          - X-06: 5/5;
          - X-12: 8/8;
          - the pseudo-locale phase: 5/5.

          The run before found one unmarked string, "git version …" on the setup check. It's `git --version` output,
          so the test now treats it as data.
      - **Bahasa Indonesia for the UI (2026-11-05):** the owner chose Indonesian as the second language, in formal
        "Anda", with developers' English terms kept.
        - **The setting:** Settings → Appearance → Language, with English (the default) or Bahasa Indonesia. Saving a new
          language asks to restart the app, or applies at the next start.
          - `main.tsx` loads it from the Rust core before the first render.
          - The macOS menu is built in it.
          - Weekday names and the time separator follow it ("Jum 02.00").
        - **The catalogs:** `locales/id/`, 1,763 keys (English plurals' `_one` forms aren't needed). They load in their
          own chunk, 29 kB gzipped; the main chunk doesn't grow.
        - **How it was translated:** a glossary came first ([TRANSLATING.md](guides/TRANSLATING.md)). Then four agents
          each translated one area, and a consistency pass unified the terms they chose, which went into the glossary.
        - **Guards:**
          - `i18n/catalog.test.ts` fails when Indonesian misses or adds a key, has an empty value, or changes a
            `{{value}}` or a tag.
          - An E2E phase starts the app in Indonesian: `<html lang="id">`, labels from the catalog, the Language
            select, axe on Home, Settings, Workspace settings and the palette, and `id-*.png` screenshots.
        - **macOS:** [MANUAL_CHECKS](guides/MANUAL_CHECKS.md) checks 9–10 switch the language and read the menu bar.
        - **Evidence:** CI run [42014564019](https://github.com/hafizhrf/AgentChainer/actions/runs/42014564019)
          (#132), on Ubuntu and on Windows:
          - X-06: 5/5;
          - X-12: 8/8;
          - the pseudo-locale: 5/5;
          - Bahasa Indonesia: 4/4, with no serious or critical axe violation.

          The Windows run's `id-home.png` and `id-settings.png` show the Indonesian UI.
          - **The run before** found that the runner skipped a phase after a failed one, which is fixed.
          - It also flagged the language names in Settings in the pseudo-locale. They're named in themselves on
            purpose, so they're data.
      - **Part 2a, the messages shown live (2026-11-06):** in English and Bahasa Indonesia.
        - **One engine, in the protocol package:** each catalog registers with it, so one `setLanguage` switches all
          of a process's text.
        - **The sidecar:**
          - It gets the language at spawn (`AGENTCHAINER_LANGUAGE`).
          - About 400 messages in 8 area catalogs: errors, setup findings, plan titles and reasons, apply and
            rollback messages, verify checks, deploy hints and problems, plugin warnings.
          - zod's validation messages follow the language too.
        - **The protocol package's shared texts:** approval reasons, agent and folder problems, cadences.
        - **The Rust core:** its command errors (`native.json`) and the menu, through `i18n.rs`.
        - **No logic on words:**
          - the scheduler skips a run by a typed `AlreadyRunning`, not by the error's words;
          - a rollback's conflicts are a list, not a search for "changed since".
        - **Stays English:** text Claude reads, files written into a repository, commits and PRs, log lines, and raw
          tool output.
        - **Guards:**
          - every catalog's parity;
          - a sidecar test that fails on a literal error. 22 internal errors are allowlisted, each with why; two
            that become run outcomes wait for part 2b.
          - The Indonesian E2E phase finds a setup plan action whose title comes from the sidecar.
        - **Checked by hand:** the packaged sidecar answers "Metode tidak dikenal" and zod's "Input tidak valid" with
          `AGENTCHAINER_LANGUAGE=id`, and English without it.
      - **Part 2, still open:**
        - **2b, task results:** run outcomes, step and merge-gate labels, triage details, lessons. They go into PRs
          and evidence, so they need an English copy and a translated one. Also the deploy smoke details and
          plugin warnings that evidence copies, and `generate-workflow`'s retry reason.
        - **2c:** the catalog YAML's prose.
        - Also: weekday names in `schedules.ts` stay `en-US`, and enum values shown as words (risk, scope, state)
          arrive as received.
        - Then a second language, with its Language setting.
