# AgentChainer — Product Requirements

> Status: **draft for v0.1**. Owner: project owner. Related: [ARCHITECTURE](ARCHITECTURE.md) · [CHECKLIST](CHECKLIST.md) ·
> [RISKS](RISKS.md) · [ADRs](adr/)

## 1. Problem

Most people who code with AI work in a loop of **prompt → result → "looks ok" → deploy**. Their repos have:

- no persistent context for the agent (CLAUDE.md, conventions, commands);
- no reusable skills or specialized agents, and no guardrails (hooks, permission boundaries);
- no tests or CI that would catch a regression, and no record of what was actually verified.

Tools exist to fix each piece, but assembling them takes expertise most users don't have yet. Those tools include
skills, plugins, MCP servers, hooks, subagents, CI templates and security scanners.

**AgentChainer** is a desktop app on top of the user's own Claude Code CLI. It makes a workspace *agent-ready* in minutes
and keeps the work honest: what the agent does is visible, risky actions need approval, and "done" means verified.

## 2. Personas

| Persona | Today | What they need from AgentChainer |
|---|---|---|
| **Solo builder / "vibe-coder"** (primary) | Prompts an agent, deploys if it looks right | A guided setup that adds tests, CI and guardrails for them; plain-language explanations; safe defaults |
| **Professional developer** | Uses Claude Code, MCP, plan mode and subagents ad hoc | A repeatable, auditable workflow; visibility into subagents; less setup per repo |
| **Small team lead** | Every repo is configured differently | Consistent, versioned agent setups (lockfile) that teammates can review and reproduce |

## 3. Positioning and landscape

As of Oct 2026, per our research. Re-verify before public launch.

| Product | Form | Notable capabilities | Gaps relevant to us |
|---|---|---|---|
| **Claude Code Desktop** (Anthropic) | Official app (macOS, Windows, Linux beta) | Parallel sessions, worktrees, tasks pane with subagents, diff review with comments, PR/CI status with auto-fix, plugin browser | Closed source; no opinionated workspace bootstrap with pinning and rollback; no task contracts or evidence reports |
| **opcode** (ex-Claudia) | Tauri + React, AGPL | Sessions, custom agents, checkpoints, MCP manager, usage dashboard | No published releases; no bootstrap, CI or test generation |
| **Conductor** | macOS only, closed | Parallel agents in worktrees, diff/PR flow | macOS only; not open |
| **Nimbalyst** (successor to Crystal) | Electron, MIT | Multi-session, kanban, mobile companion | Different focus (task board) |
| **Claude Squad** | Go TUI + tmux, AGPL | Many CLI agents in worktrees | Terminal only |
| **vibe-kanban** | Rust + web, Apache-2.0 | Kanban across agents, diff, PR | Sunsetting |

**Differentiation.** AgentChainer is a **workflow layer**, not another chat shell:

1. **Opinionated, auditable bootstrap.** It detects the stack and installs a curated, pinned set of skills, plugins and
   MCP servers. It generates CLAUDE.md, hooks, tests, CI and smoke tests, proves they run, and can undo everything.
2. **Contracts and evidence (v0.2).** Each task has acceptance criteria. Deterministic gates decide "done", and every task
   ends with an evidence report built from real exit codes.
3. **Right-sized orchestration (v0.2).** The workflow scales from one agent to parallel specialists based on task
   complexity, and is shown as an inspectable graph.
4. **Open source and cross-platform**, including Linux as a first-class target, using whatever auth the user's CLI already has.

Everything bootstrap produces is **plain files** (CLAUDE.md, `.claude/`, CI). It keeps working in the terminal, the IDE
and Claude Code Desktop, so AgentChainer complements those tools rather than locking users in.

## 4. Product principles

1. **Evidence over claims.** Never show "passed" for a check that wasn't run. Show what wasn't run and why.
2. **Deterministic gates over "the AI says it's fine".** Tests, linters, scanners and CI decide.
3. **Least privilege by default.** Safe profile first; autonomy is opt-in and capped.
4. **Preview before apply.** No install, file write or command from bootstrap without a visible preview.
5. **Pinned and reversible.** Every change is recorded in a lockfile and can be rolled back.
6. **Right-size the workflow.** Small task → single agent + tests. Don't spawn agents for show.
7. **No credential custody.** Auth stays in the official CLI ([ADR-0002](adr/0002-auth-and-branding.md)).
8. **Teach while doing.** Explain why each recommendation matters, in plain language.

## 5. Feature areas

| ID | Feature | Priority | Target |
|---|---|---|---|
| F1 | Agent session core | **P0** | v0.1 |
| F2 | Workspace bootstrap | **P0** | v0.1 |
| F3 | Adaptive planner + task contracts + evidence reports | P1 | v0.2 |
| F4 | Agent observability graph | P1 | v0.2–v0.3 |
| F5 | Git workflow, PRs and quality gates | P1 | v0.3 |
| F6 | Deployment adapters | P2 | v0.4 |
| F7 | Editable workflow canvas | P2 | v0.4 |
| F8 | Evals and analytics | P2 | v0.5 |

### F1 — Agent session core (P0)

- **Onboarding and health check:** detects the `claude` CLI, its version and auth state. When something is missing, it
  shows a tutorial ([AUTH_SETUP](guides/AUTH_SETUP.md)).
- **Workspaces:** open folders, tabs, recent list.
- **Chat:**
  - streaming text and thinking; tool-call cards; subagent calls shown inline;
  - composer with @file mentions, skills and slash commands, images, queued follow-ups;
  - interrupt; model, effort and permission-mode switcher; plan-mode approve → execute.
- **Permissions:** approval modal (editable input; allow once / always / deny with reason); Safe/Standard/Autonomous
  profiles; hard denylist.
- **Sessions:** list, rename, tag, delete, resume and fork, including sessions started in the terminal; file checkpoints with rewind.
- **Files and changes:** file tree with git status, per-turn changed files, diff viewer with revert, open in external editor, integrated terminal.
- **Git basics:** branch, stage, AI-drafted commit message, push.
- **Cost:** per-turn and per-session estimates, budget cap, local history.

### F2 — Workspace bootstrap (P0)

- **Detect** tier-1 stacks: TS/JS, Python, Flutter/Dart, Go. Monorepo-aware.
- **Discover** install, build, lint, format, typecheck, test and dev commands.
- **Audit** the existing agent setup and produce a **readiness report** in which every finding maps to a fix.
- **Plan:** recommend catalog items (skills, plugins, MCP, hooks, tools) by profile, with reason, risk, permissions and license.
- **Install** with preview, pinning, lockfile and rollback ([ADR-0005](adr/0005-catalog-trust-model.md), [CATALOG](CATALOG.md)).
- **Generate** (agent-driven, reviewed as diffs):
  - CLAUDE.md, merged with what exists;
  - hooks: format/lint on edit, optional fast tests on stop, gitleaks pre-commit;
  - test scaffold, only if none exists;
  - GitHub Actions CI;
  - smoke test.
- **Verify** by running the generated commands, then produce a Bootstrap Report.

### F3 — Adaptive planner, task contracts and evidence (P1)

- **TaskContract:**
  - task, objective, constraints, acceptance criteria / Definition of Done, out-of-scope, risk notes;
  - drafted by the agent, edited and approved by the user.
- **Triage** into tiers, using deterministic signals (scope estimate, risk keywords, repo size, test presence) plus a cheap
  model, with a rationale the user can override:

| Tier | Typical task | Workflow template |
|---|---|---|
| **S** | Typo, small bug, config tweak | Single agent → gates |
| **M** | Feature within one module | Plan → implement → gates → review |
| **L** | Cross-module feature, security-relevant change | Parallel architect / security / test-planner → implement → independent reviewer (fresh context) → gates |
| **XL** | Epic, migration | Split into sub-tasks, each with its own contract and worktree; optionally the SDK Workflow tool |

- **Verification gates:** format, lint, typecheck, test and smoke from the WorkspaceProfile, with bounded fix loops.
- **Evidence report:**
  - changed files and their purpose;
  - gates run, with real exit codes; gates not run, with reasons;
  - security notes, remaining risks and manual steps.

### F4 — Agent observability (P1)

- Live agent tree and graph (React Flow) showing status, current tool and cost per agent.
- Node drawer with the subagent transcript.
- Timeline view; replay of finished sessions.
- Agent library manager (manual vs auto-spawned).

### F5 — Git workflow, PRs and quality gates (P1)

- **Worktrees:** one worktree/branch per task, parallel tasks, conflict warnings.
- **Pull requests:** PR body built from the contract and evidence report; CI status; approval-gated "fix CI" loop.
- **Gates:** independent AI review plus deterministic scanners as merge gates.
- **Human-only operations:** merge, force push and release tags always need a person.

### F6–F8 (P2)

- **F6 Deploy adapters:**
  - Vercel, Cloudflare, Fly.io, Docker registry, Firebase;
  - preview vs production; production always needs human approval;
  - post-deploy smoke test and rollback.
- **F7 Editable workflow canvas:** workflow templates as a graph ⇄ YAML.
- **F8 Evals and analytics:**
  - local metrics: gate pass rate, cost per successful task, duration, retries, human-fix rate;
  - a benchmark harness to A/B test templates, models and skills.

## 6. User stories and acceptance criteria (P0)

### F1

| ID | Story | Acceptance criteria |
|---|---|---|
| US-1.1 | As a new user, I open a folder and start a session, or learn exactly what's missing. | Health check runs on launch. Each failing item (CLI missing or too old, logged out, no git) shows OS-specific fix steps and a Re-check button. The app never asks for or stores credentials. |
| US-1.2 | I see what the agent is doing in real time and can stop it. | Text streams; each tool call appears as a card with status and duration; subagent calls are nested; Stop interrupts within 2 s and the session stays usable. |
| US-1.3 | I approve risky actions with full context. | The modal shows tool, agent, full input (editable) and working dir. Options: allow once, always for this project (rule visible and removable), deny with a message to the agent. Denylisted commands are blocked with a reason in every profile. |
| US-1.4 | I review and undo changes. | Changed files are listed per turn. Diff view per file. Revert per file and per hunk, with confirmation. |
| US-1.5 | I continue yesterday's work. | Sessions are listed per workspace, including terminal-started ones. Resume restores the conversation. Fork creates an independent branch of it. |
| US-1.6 | I undo a bad turn. | "Rewind files to here" on a user message restores the files the agent edited since then. Limits (Bash-made changes) are stated in the UI. |
| US-1.7 | I control spend. | Cost per turn and per session is shown and labeled as an estimate. A budget cap stops the session when reached, with a warning at 80%. |

### F2

| ID | Story | Acceptance criteria |
|---|---|---|
| US-2.1 | I learn what my repo lacks for agent work. | The readiness report lists findings (e.g. "no test command", "no CLAUDE.md", "`.env` not ignored"), each with a one-click fix action and an explanation. |
| US-2.2 | I install recommended tools safely. | Each recommended item shows what it is, why it's recommended, its trust tier, license, required permissions, and the exact files or commands. Nothing is applied until I confirm. Community items are never pre-selected. |
| US-2.3 | I get a useful CLAUDE.md. | The generated CLAUDE.md contains real, verified commands and a short architecture map. An existing CLAUDE.md/AGENTS.md is merged, never silently overwritten. |
| US-2.4 | I get working tests, CI and a smoke test. | The generated test command, CI workflow (actionlint-clean) and smoke script are executed by the verifier. The report shows pass/fail per item with log excerpts. |
| US-2.5 | I can undo the bootstrap. | Rollback per item or for the whole run returns the repo to its previous state, byte-identical and with a clean `git status`. |

## 7. Non-goals (v0.x)

- Building our own code editor. Monaco is used for diffs and quick edits; "Open in editor" covers the rest.
- Non-Claude models or providers other than those the Claude CLI supports.
- Implementing login, or storing credentials or API keys ([ADR-0002](adr/0002-auth-and-branding.md)).
- Cloud accounts, sync, a team server, or a hosted service.
- Mobile apps.
- Replacing CI providers or deployment platforms. We generate configs and call their CLIs.

## 8. Success metrics

AgentChainer has no telemetry by default. These are measured on benchmark fixtures, in usability tests, and through
opt-in user reports.

| Metric | Initial target | Measured from |
|---|---|---|
| Install → first successful session (new user following AUTH_SETUP) | < 10 min | Usability tests on all 3 OS |
| Bootstrap success on fixture repos without manual edits | ≥ 90% | M2 fixture suite |
| Generated CI green on first run | ≥ 90% per tier-1 stack | M2-E2 test repos |
| Crash-free sessions | ≥ 99% | Fixture scenarios + opt-in reports |
| Tasks ending with all required gates passed (v0.2+) | Baseline, then improve | M3 benchmark |
| Cost per successful task (v0.5) | Baseline, then reduce | M7 harness |

## 9. Constraints and assumptions

- **Policy:**
  - Third parties may not offer claude.ai login or rate limits, so users authenticate in their own terminal.
  - No "Claude Code" branding. See [ADR-0002](adr/0002-auth-and-branding.md) and [R-01](RISKS.md).
- **Account requirements:** the user needs a Claude account that includes Claude Code (Pro, Max, Team, Enterprise or
  Console), or Bedrock/Vertex/Foundry access. The free claude.ai plan does not include Claude Code.
- **Platforms:** macOS 13+, Windows 10 1809+, Ubuntu 22.04+. Claude Code itself supports Ubuntu 20.04+, but Tauri v2
  needs WebKitGTK 4.1 **(verify)**. Git for Windows is recommended on Windows.
- **SDK and CLI churn:** both release frequently. We pin the SDK, enforce a minimum CLI version, and run contract tests weekly.
