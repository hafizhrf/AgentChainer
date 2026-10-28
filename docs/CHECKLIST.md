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
| [M0](#m0--foundations--spikes) | — | Foundations & spikes | ◐ In progress |
| [M1](#m1--agent-session-core-v01-a) | v0.1 | Agent session core | ☐ Not started |
| [M2](#m2--workspace-bootstrap-v01-b) | v0.1 | Workspace bootstrap | ☐ Not started |
| [UX](#ux--product-design--ui-polish-before-r1) | v0.1 | Product design & UI polish (after M1/M2 work functionally) | ☐ Later |
| [R1](#r1--v01-release) | v0.1 | Packaging & release | ☐ Not started |
| [M3](#m3--adaptive-planner--task-contracts-v02) | v0.2 | Adaptive planner, contracts, evidence | ☐ Not started |
| [M4](#m4--agent-observability-v02v03) | v0.2–0.3 | Agent observability graph | ☐ Not started |
| [M5](#m5--git-workflow-pr--quality-gates-v03) | v0.3 | Git workflow, PRs, gates | ☐ Not started |
| [M6](#m6--deployment--workflow-canvas-v04) | v0.4 | Deploy adapters, workflow canvas | ☐ Not started |
| [M7](#m7--evals--analytics-v05) | v0.5 | Evals & analytics | ☐ Not started |
| [X](#cross-cutting-tracks-ongoing) | all | Security, quality, compatibility, docs, a11y | ☐ Ongoing |

---

## M0 — Foundations & spikes

**Goal:** de-risk the stack and set up the repo, so every later milestone starts with CI, conventions and verified assumptions.

### Decisions

- [ ] **M0-01** Check the product name: GitHub org/repo, domain, npm scope and crates.io are free, and the name is policy-compliant
      (no "Claude Code" in name or icon; tagline "Powered by Claude"). → [ADR-0002](adr/0002-auth-and-branding.md)
- [ ] **M0-02** Accept the license ([ADR-0006](adr/0006-license.md)), add `LICENSE` and `NOTICE`.
- [ ] **M0-03** Check whether the Agent SDK's license or terms allow bundling its JS inside a distributed sidecar binary. Record
      the answer in [ADR-0003](adr/0003-agent-runtime-and-ipc.md); fallback is installing the SDK on first run ([R-11](RISKS.md)).

### Repository & tooling

- [x] **M0-04** Create the GitHub repo, push these docs, and protect `main` (PR required, no force push or deletion,
      linear history). The "green CI required" part moves to M0-10, because there is no CI to require yet.
      — evidence: [repo](https://github.com/hafizhrf/AgentChainer), [ruleset `protect-main`](https://github.com/hafizhrf/AgentChainer/rules/26015160), initial commit `53421cf`
- [ ] **M0-05** Add issue/PR templates; labels `area/*`, `milestone/*`, `type/*`, `good first issue`; a GitHub Project board mirroring this checklist.
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
- [ ] **M0-08** Lint and format: decide Biome vs ESLint+Prettier; rustfmt; clippy with warnings denied; lefthook pre-commit;
      conventional commits (commitlint).
- [ ] **M0-09** Test runners: Vitest (TS), `cargo test` (Rust), coverage reports.
      Progress: the sidecar already runs zero-dependency `node:test` unit tests (`pnpm --filter @agentchainer/sidecar test`)
      in CI. Decide whether to keep `node:test` or move to Vitest; the UI needs a DOM-capable runner either way.
- [ ] **M0-10** CI (GitHub Actions): lint + typecheck + test on ubuntu/macos/windows; Tauri build with unsigned artifacts per OS
      on PRs; least-privilege `permissions:`; actions pinned by SHA. Then add the CI jobs as required status checks in
      the `protect-main` ruleset, with "require branches to be up to date".
      Progress: `.github/workflows/ci.yml` is merged (PR #3) and green on all 4 jobs
      ([run 40645248278](https://github.com/hafizhrf/AgentChainer/actions/runs/40645248278)). Remaining: required status
      checks in the ruleset. Lint and tests join CI with M0-08 / M0-09.
- [ ] **M0-11** Renovate or Dependabot. Pin the Agent SDK and group it for manual review.
- [ ] **M0-12** Dogfood: update [`CLAUDE.md`](../CLAUDE.md) with real commands; `.claude/settings.json` hooks (format on edit);
      project skills for recurring work (e.g. `add-ipc-method`, `add-catalog-item`).
- [ ] **M0-13** Render-check all Mermaid diagrams in `docs/` on GitHub.
- [ ] **M0-14** Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (private vulnerability reporting enabled).

### Spikes

- [ ] **M0-15** **S1 Sidecar packaging.**
  - Compile a minimal sidecar using `@anthropic-ai/claude-agent-sdk` (optional deps omitted) into a single executable.
    Compare `@yao-pkg/pkg` and Node SEA.
  - Run it as a Tauri `externalBin` on 3 OS, driving the user's installed `claude` via `pathToClaudeCodeExecutable`.
  - Record binary size and cold start.
  - Check PATH resolution: a macOS app started from Finder, and `%USERPROFILE%\.local\bin` on Windows.
  - Progress: the SDK runs against the user's CLI with the bundled binaries excluded (pnpm `ignoredOptionalDependencies`),
    and the sidecar finds the CLI on PATH or in known locations. Single-exe packaging is not started yet.
    See [S2/S3 spike](spikes/S2-S3-chat-slice.md).
- [ ] **M0-16** **S2 Event stream.** Run a streaming-input `query()`, forward SDK messages through Rust to React, and measure
      end-to-end delta latency and CPU with partial messages on.
  - Progress: streaming works end to end (sidecar → Rust → React chat UI). Time to first delta is 2.1–3.4 s and dominated
    by the model. UI-side latency and CPU are not measured yet. See [S2/S3 spike](spikes/S2-S3-chat-slice.md).
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
- [ ] **M0-18** **S4 Subagent attribution.**
  - Capture `parent_tool_use_id`, `agent_id`, the `SubagentStart/Stop` hooks and `forwardSubagentText`.
  - Build an agent tree for a prompt that spawns 2 parallel subagents.
  - Save the stream as the first recorded fixture.
- [ ] **M0-19** **S5 Install & auth detection.**
  - Run `claude --version` and `claude auth status --json` across these states: not installed, too old, logged out,
    subscription, Console, `ANTHROPIC_API_KEY`, Bedrock/Vertex env.
  - Confirm no secret values appear in the output.
  - Set `MIN_CLAUDE_VERSION`.
- [ ] **M0-20** **S6 Plugin & MCP install.**
  - From the sidecar on 3 OS, run non-interactively: `claude plugin marketplace add`, `claude plugin install … --scope project -y --json`,
    `claude plugin uninstall`, `claude mcp add --scope local`.
  - Find out whether plugin versions can be pinned.
- [ ] **M0-21** Update [ADR-0003](adr/0003-agent-runtime-and-ipc.md) with the spike results: Accept, or switch to the fallback
      (Electron, or CLI `stream-json`).

### Exit criteria

- [ ] **M0-E1** S1–S6 pass on macOS, Windows and Ubuntu, or have a documented workaround.
- [ ] **M0-E2** ADR-0001 through ADR-0005 are Accepted.
- [ ] **M0-E3** CI is green on all 3 OS for the app shell.

---

## M1 — Agent session core (v0.1-A)

**Goal:** a reliable, transparent agent session on a local workspace. → PRD [F1](PRD.md#f1--agent-session-core-p0)

### App shell & onboarding

- [ ] **M1-01** Sidecar supervisor (Rust): spawn, health ping, restart with backoff, crash log; `system.hello` handshake.
- [ ] **M1-02** `packages/protocol`: zod schemas → JSON Schema → generated TS + Rust types; validation on both ends; version errors.
- [ ] **M1-03** Environment resolver: login-shell env (macOS/Linux), `claude` discovery (settings → PATH → known locations),
      version check. → [ARCHITECTURE §3](ARCHITECTURE.md#3-locating-claude-and-the-users-environment)
- [ ] **M1-04** Health-check screen covering git, `claude` (installed, version ≥ minimum), auth state, and Git for Windows on Windows.
      Each failing item links to its fix.
- [ ] **M1-05** Onboarding tutorial that renders [AUTH_SETUP](guides/AUTH_SETUP.md) for the user's OS. Copy buttons,
      "Open terminal", "Re-check". The app never handles credentials.
- [ ] **M1-06** Workspace picker: open folder, recent list, multiple workspaces as tabs. If the folder isn't a git repo, offer `git init`.
- [ ] **M1-07** Settings stored in the app DB (no secrets): Claude CLI path, default model, effort, permission profile, budget cap, theme.

### Chat & streaming

- [ ] **M1-08** Session runtime: one streaming-input `query()` per session with the options in
      [ARCHITECTURE §5.1](ARCHITECTURE.md#51-session-runtime).
- [ ] **M1-09** Event normalizer: SDK messages → `AgentEvent` ([§5.2](ARCHITECTURE.md#52-normalized-events)), with a recorded
      fixture for every event type.
- [ ] **M1-10** Message list: streaming markdown, collapsible thinking, virtualized for long sessions.
- [ ] **M1-11** Tool-call cards (Read, Edit, Write, Bash, Grep, Glob, WebFetch, MCP):
  - status, duration, collapsible input and output;
  - Edit and Write show an inline diff.
- [ ] **M1-12** Subagent calls shown inline as nested cards. The full graph comes in M4.
- [ ] **M1-13** Composer:
  - multiline input; @file mention with fuzzy search; image paste;
  - `/` palette for skills and commands (from session init);
  - queued follow-ups while a turn is running.
- [ ] **M1-14** Interrupt (Esc or Stop button) and "stop after this turn".
- [ ] **M1-15** Switcher for model, effort and permission mode; mid-session mode switch via `setPermissionMode()`.
- [ ] **M1-16** Plan-mode UX: render the proposed plan with "Approve & execute", "Revise" and "Reject".

### Permissions

- [ ] **M1-17** Approval modal driven by `canUseTool`:
  - shows the tool, the agent (main or subagent) and the input, which is editable;
  - options: allow once, always for this project, deny with a message to the agent.
- [ ] **M1-18** Permission profiles Safe / Standard / Autonomous ([ARCHITECTURE §6](ARCHITECTURE.md#6-permissions)).
      Check auto-mode availability per account type. `auto` works on the owner's account (spike S3).
      Explain each mode in the UI, because owner testing showed "auto-accept edits" being read as "auto mode" (Bash
      still asks in `acceptEdits`).
- [ ] **M1-19** `PreToolUse` guard: a hard denylist that applies in every profile and shows the reason for each block.
- [ ] **M1-20** "Always allow" rules go to `.claude/settings.local.json` and can be viewed and removed in a Permissions panel.

### Sessions & checkpoints

- [ ] **M1-21** Session list per workspace via the SDK, showing title, last activity and cost; rename, tag, delete.
- [ ] **M1-22** Resume and fork. Sessions started in the terminal CLI appear in the list and can be resumed.
- [ ] **M1-23** File checkpoints: "Rewind files to here" on a user message, with the documented limits shown.
- [ ] **M1-24** Retention notice: show `cleanupPeriodDays` (default 30) and explain how to change it.

### Files, diff, terminal

- [ ] **M1-25** File tree with git status badges, updated live by a file watcher.
- [ ] **M1-26** Changes panel: files changed per turn and per session.
- [ ] **M1-27** Monaco diff viewer; revert a file or a hunk (via git), with confirmation.
- [ ] **M1-28** "Open in editor" at `file:line` (VS Code, Cursor, JetBrains, system default).
- [ ] **M1-29** Integrated terminal (xterm.js + portable-pty), scoped to the workspace.

### Git basics

- [ ] **M1-30** Git panel using system git:
  - branch indicator, switch and create;
  - stage and unstage; commit with an AI-drafted message the user edits; push;
  - never force-push.

### Cost & limits

- [ ] **M1-31** Cost, tokens and duration per turn and per session, taken from `result` (`total_cost_usd`, `modelUsage`)
      and labeled "estimate".
- [ ] **M1-32** Budget cap (`maxBudgetUsd`) per session, with a warning at 80%.
- [ ] **M1-33** Local cost history per workspace.

### Quality

- [ ] **M1-34** UI tests driven by recorded fixtures through a fake transport. No live API calls in CI.
- [ ] **M1-35** Diagnostics: structured logs (Rust `tracing`, sidecar stderr) and an "Export diagnostics" bundle with secrets redacted.

### Exit criteria

All of these run on macOS, Windows and Ubuntu against a sample repo in `fixtures/`:

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

- [ ] **M2-01** JSON Schema for catalog items and profiles ([CATALOG §3](CATALOG.md#3-item-schema)); CI validates `catalog/`.
- [ ] **M2-02** Seed the items from [CATALOG §6](CATALOG.md#6-seed-items) with pinned refs, CI-computed hashes and licenses.
      Review each one with the [§4 checklist](CATALOG.md#4-review-checklist-adding-or-updating-an-item).
- [ ] **M2-03** Show trust tiers in the UI. Community items are never pre-selected or auto-applied.
- [ ] **M2-04** Upstream-update bot: a scheduled workflow that opens PRs bumping refs and hashes, with a diff summary.
- [ ] **M2-05** Decide whether v0.1 ships a bundled catalog snapshot only, or can also fetch signed catalog updates from Releases.

### Detection & audit

- [ ] **M2-06** Stack detector for the tier-1 stacks, monorepo-aware:
  - TS/JS: npm, pnpm, yarn, bun; framework hints such as Next, Vite, Express, Nest.
  - Python: uv, poetry, pip; framework hints such as Django, FastAPI, Flask.
  - Flutter/Dart.
  - Go.
- [ ] **M2-07** Command discovery per package: install, build, lint, format, typecheck, test, dev. Sources are manifests,
      scripts, Makefile and justfile; each command gets a confidence level.
- [ ] **M2-08** Setup audit:
  - agent files: CLAUDE.md/AGENTS.md (presence, size, staleness signals); `.claude/` settings, skills, agents and hooks; `.mcp.json`;
  - project health: CI, test framework, lint/format config;
  - `.gitignore` covers env and secret files; git remote.
- [ ] **M2-09** Readiness report: checklist-style findings, each mapped to a fix action. No score that has no actions behind it.
- [ ] **M2-10** Persist the `WorkspaceProfile` as `.agentchainer/profile.json`; decide and document whether it's committed by default.

### Plan & apply

- [ ] **M2-11** BootstrapPlan builder: profile + catalog + audit → actions, each with reason, risk, scope and a preview
      (file diff or command list).
- [ ] **M2-12** Review UI:
  - toggle actions on and off;
  - inspect each preview, the permissions an item needs, and its license;
  - "Apply selected".
- [ ] **M2-13** Skill installer: fetch the pinned source → verify sha256 → copy to `.claude/skills/<name>` (project) or `~/.claude/skills` (user).
- [ ] **M2-14** Plugin installer: `claude plugin marketplace add` + `claude plugin install … --scope project -y --json`;
      record the installed version.
- [ ] **M2-15** MCP installer:
  - command-based servers are registered with `claude mcp add --scope local`;
  - portable servers (`npx`, remote HTTP) may go to the project `.mcp.json`;
  - binaries are downloaded with checksums into an app-managed dir (never `curl | bash`);
  - secrets are referenced as env vars and never written to repo files.
- [ ] **M2-16** Lockfile `.agentchainer/lock.json` ([CATALOG §7](CATALOG.md#7-lockfile)); re-running bootstrap is idempotent.
- [ ] **M2-17** Rollback per item and per run, restoring previous file contents byte-for-byte from backups.
- [ ] **M2-18** Auto-apply as an opt-in setting, limited to first-party and official items.

### Generators (agent-driven, verified deterministically)

- [ ] **M2-19** First-party skills in `skills/`: `ac-write-claude-md`, `ac-setup-hooks`, `ac-scaffold-tests`,
      `ac-generate-ci`, `ac-smoke-test`.
- [ ] **M2-20** Generator sessions run under a restricted profile (edits inside the workspace, Bash limited to detected commands).
      They produce a proposal diff and never write without review.
- [ ] **M2-21** CLAUDE.md generator:
  - concise: real commands, an architecture map, conventions, Definition of Done;
  - merges into an existing CLAUDE.md;
  - if AGENTS.md exists, avoids contradicting it (link or import).
- [ ] **M2-22** Hooks generator:
  - format and lint on edit, written to `.claude/settings.json` (`PostToolUse`);
  - optional Stop hook that runs fast tests;
  - gitleaks pre-commit through whichever hook manager the repo already uses (lefthook, pre-commit, husky).
- [ ] **M2-23** Test scaffold, only when none exists:
  - Vitest or Jest, pytest, flutter_test, or `go test`;
  - plus one example test and a `test` command;
  - verified by running it.
- [ ] **M2-24** CI generator: a GitHub Actions workflow (install, lint, typecheck, test, build) with dependency caching,
      least-privilege `permissions:` and SHA-pinned actions; validated with actionlint.
- [ ] **M2-25** Smoke test: `scripts/smoke.(sh|ps1)` per stack (app boots, health endpoint responds, CLI `--help`, or Flutter
      build), plus a CI job.
- [ ] **M2-26** Verifier: runs each generated command with a timeout and captures exit code and log tail.
  - Generators get at most N repair attempts.
  - The Bootstrap Report lists what passed, what failed, and what was skipped, with reasons.

### Fixtures & tests

- [ ] **M2-27** Fixture repos in `fixtures/`:
  - one per tier-1 stack;
  - an empty repo;
  - a messy legacy repo (mixed tooling, no tests);
  - a monorepo.
- [ ] **M2-28** Automated bootstrap tests per fixture: detector and plan snapshots; installer and rollback run on temp copies.

### Exit criteria

- [ ] **M2-E1** Bootstrap succeeds on every fixture on macOS, Windows and Ubuntu.
- [ ] **M2-E2** For each tier-1 stack, the generated CI runs green on a real GitHub test repo.
- [ ] **M2-E3** A full rollback leaves `git status` clean and every file byte-identical.
- [ ] **M2-E4** No action is applied without a preview, unless the user opted into auto-apply.

---

## UX — Product design & UI polish (before R1)

**Goal:** turn the functional M1/M2 screens into a polished, trustworthy product before the first public release.
**Scheduled later by the owner:** start once M1 and M2 work functionally; the spike UI stays deliberately plain until then.

- [ ] **UX-01** Pattern research: review Claude Code Desktop, Cursor, Zed and Conductor for layout, chat, tool, diff and
      approval patterns; write down principles and anti-patterns in `docs/design/ux-principles.md`.
- [ ] **UX-02** Design system: tokens (color, type, spacing, radius, motion) for light and dark. Pick a component approach
      (e.g. Radix/shadcn + Tailwind) and record it in an ADR.
- [ ] **UX-03** Information architecture and wireframes:
  - left sidebar with workspaces and sessions;
  - the main transcript;
  - a right panel for changes/diff and agents;
  - a status bar showing model, mode and cost.
- [ ] **UX-04** Transcript polish: markdown and code highlighting, grouped and collapsible tool runs, a streaming cursor,
      copy buttons, timestamps, long-session performance.
- [ ] **UX-05** Approval and mode UX:
  - richer approval dialog: diff preview for edits, plain-language command explanation, risk level, "always allow" with scope;
  - explain each permission mode in the UI, and show why the guard blocked a call.
- [ ] **UX-06** Onboarding and empty states: native folder picker instead of a typed path, first-run checklist,
      helpful errors.
- [ ] **UX-07** Keyboard shortcuts and a command palette.
- [ ] **UX-08** App icon and visual identity, after naming and branding are settled (M0-01).
- [ ] **UX-09** Usability test with 3–5 target users on macOS, Windows and Ubuntu; fix the top issues.

### Exit criteria

- [ ] **UX-E1** All M1/M2 screens use the design system, in light and dark themes.
- [ ] **UX-E2** Usability test participants complete the M1 exit scenarios without help.

---

## R1 — v0.1 release

- [ ] **R1-01** Bundles: macOS dmg, Windows msi/nsis, Linux AppImage + deb + rpm.
- [ ] **R1-02** Ship the sidecar per target triple via `bundle.externalBin`. No Claude binary is bundled. M0-03 is resolved.
- [ ] **R1-03** Signing:
  - macOS: Developer ID + notarization, with every embedded binary signed.
  - Windows: Azure Artifact Signing, or unsigned with SmartScreen guidance.
  - Linux: checksums (+ GPG).
  - Record the budget decision.
- [ ] **R1-04** Auto-updater (`tauri-plugin-updater`) with signed manifests on GitHub Releases.
- [ ] **R1-05** Privacy statement: no telemetry by default; what data stays local.
- [ ] **R1-06** Security review:
  - update the threat model (X-01);
  - review Tauri capabilities and the IPC surface;
  - run the `cloudflare-security-audit` skill on this repo, then fix or document the findings.
- [ ] **R1-07** README quickstart, screenshots, and a short demo GIF or video. AUTH_SETUP is linked from both the app and the README.
- [ ] **R1-08** Changelog and release automation (release-please or changesets).
- [ ] **R1-09** Install the release artifacts on clean VMs (macOS, Windows 11, Ubuntu LTS) and smoke-test them.

### Exit criteria

- [ ] **R1-E1** M1 and M2 exit criteria pass when re-run on the release artifacts, not dev builds.
- [ ] **R1-E2** Release v0.1.0 is published with checksums and notes.

---

## M3 — Adaptive planner & task contracts (v0.2)

→ PRD [F3](PRD.md#f3--adaptive-planner-task-contracts-and-evidence-p1)

- [ ] **M3-01** Design doc `docs/design/planner.md`, approved before any code.
- [ ] **M3-02** TaskContract schema: task, objective, constraints, acceptance criteria / Definition of Done, out-of-scope,
      risk notes. The agent drafts it as structured output; the user edits and approves it.
- [ ] **M3-03** Triage into tiers S/M/L/XL, with a rationale the user can override. Inputs:
  - deterministic signals: estimated scope (via the code graph when available), risk keywords (auth, payments, migrations,
    infra, secrets), repo size, whether tests exist;
  - a cheap-model classification.
- [ ] **M3-04** Workflow templates as versioned YAML in `catalog/workflows/`, one per tier as described in the PRD.
- [ ] **M3-05** Agent library, installable into `.claude/agents/`: architect, test-planner, security-reviewer, docs-writer,
      and independent-reviewer (fresh context: it gets the diff and contract, not the implementer's transcript).
- [ ] **M3-06** Orchestrator that executes a template:
  - sequential and parallel steps;
  - hand-offs as files (`plan.md`, `contract.json`);
  - budget and turn caps per step.
- [ ] **M3-07** XL path: split into sub-tasks, each with its own contract and worktree. Evaluate the SDK `Workflow` tool
      where the user's plan supports it.
- [ ] **M3-08** Verification gates from WorkspaceProfile commands (format, lint, typecheck, test, smoke), with a bounded fix loop
      (iteration and budget caps).
- [ ] **M3-09** Evidence report per task, stored and exportable as markdown:
  - changed files and their purpose;
  - gates run, with real exit codes; gates not run, with reasons;
  - security notes, remaining risks and manual steps.
- [ ] **M3-10** The UI shows a task as "Done" only when the required gates passed, or the user explicitly accepted the risk.

### Exit criteria

- [ ] **M3-E1** On a benchmark of ≥ 20 fixture tasks, triage agrees with a human reviewer's tier in ≥ 80% of cases
      (measure the baseline first, then tune).
- [ ] **M3-E2** Every completed task has an evidence report whose gate results match the actual command outputs.

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
- [ ] **M4-08** Replay a finished session as a graph.

### Exit criteria

- [ ] **M4-E1** A session with ≥ 3 parallel subagents renders correctly live and on replay.
- [ ] **M4-E2** Pan and zoom hold 60 fps with 200 nodes on the slowest supported WebView.

---

## M5 — Git workflow, PR & quality gates (v0.3)

→ PRD [F5](PRD.md#f5--git-workflow-prs-and-quality-gates-p1)

- [ ] **M5-01** Each task runs in an isolated worktree and branch. Parallel tasks are supported, with a warning when two touch
      the same files. Worktrees are cleaned up afterward.
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

## Cross-cutting tracks (ongoing)

### Security & privacy

- [ ] **X-01** Threat model doc (`docs/THREAT_MODEL.md`), updated every milestone.
- [ ] **X-02** Least-privilege Tauri capabilities, a sidecar argument allowlist, and IPC validation on both ends.
      Replace the scaffold's `"csp": null` (Tauri template default) with a strict Content Security Policy.
- [ ] **X-03** Secrets never appear in logs or the UI: a redaction filter covers logs, displayed tool output and diagnostics.
- [ ] **X-04** No telemetry by default. Any future telemetry is opt-in and documented.

### Quality & performance

- [ ] **X-05** Weekly CI job runs the latest Agent SDK and CLI against the recorded-fixture contract tests, and opens an issue on drift.
- [ ] **X-06** E2E with `tauri-driver` on Linux and Windows. macOS uses a manual checklist (verify WebDriver support).
- [ ] **X-07** Performance budgets for startup time, idle memory and stream latency, tracked every release.

### Compatibility

- [ ] **X-08** Compatibility matrix in the docs (OS versions, CLI versions, SDK version). The health check enforces the minimum CLI version.

### Docs & community

- [ ] **X-09** Every decision that is expensive to reverse gets an ADR, and this checklist stays current.
- [ ] **X-10** User docs, a contributor guide, and good-first-issues tagged for each milestone.
- [ ] **X-11** Review [RISKS](RISKS.md) at every milestone boundary.

### Accessibility & i18n

- [ ] **X-12** Keyboard-first navigation, focus management, screen-reader labels, and sufficient contrast in both themes.
- [ ] **X-13** i18n-ready strings: English first, Indonesian next.
