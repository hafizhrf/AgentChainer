# AgentChainer

**From "prompt → result → deploy" to a professional agent workflow.** Powered by Claude.

AgentChainer is an open-source desktop app for **macOS, Windows and Linux** that runs on top of the
[Claude Code](https://code.claude.com/docs) CLI you already have installed. It turns any repository into an *agent-ready*
workspace and keeps the agent's work transparent and verifiable:

- **See everything the agent does:** streaming output, tool calls, subagents, cost. Approve risky actions before they happen.
- **Bootstrap a workspace in minutes:**
  - detect the stack;
  - install a curated, pinned set of skills, plugins and MCP servers;
  - generate CLAUDE.md, hooks, tests, CI and a smoke test;
  - prove they run;
  - undo it all if you want.
- **Right-size the work (v0.2+):**
  - task contracts with acceptance criteria;
  - automatic choice between a single agent and parallel specialists;
  - deterministic quality gates;
  - an evidence report for every task.

> **Status: v0.1 in preparation.** Agent sessions (M1) and workspace bootstrap (M2) work; installers and the release
> pipeline are being finished. There's no published release yet. See the [checklist](docs/CHECKLIST.md) for progress.

## Quickstart

1. **Install AgentChainer** from the [latest release](https://github.com/hafizhrf/AgentChainer/releases/latest) and
   check it against `SHA256SUMS`. v0.1 isn't code-signed: [docs/guides/INSTALL.md](docs/guides/INSTALL.md) shows how to
   open it on macOS and Windows.
2. **Install the Claude Code CLI and sign in yourself**, in your own terminal: `claude auth login`. See
   [docs/guides/AUTH_SETUP.md](docs/guides/AUTH_SETUP.md). The app checks this on start and walks you through it.
3. **Open a project folder.** Start a session, or open **Workspace settings** to see what AgentChainer would add. Nothing
   changes until you approve the plan, and every applied setup can be rolled back.

To build from source instead, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Principles

1. **Evidence over claims.** "Done" means the checks actually ran and passed.
2. **Preview before apply.** Nothing is installed or changed without showing you first.
3. **Pinned and reversible.** Every change is in a lockfile and can be rolled back.
4. **Least privilege by default.** Autonomy is opt-in and budget-capped.
5. **Your credentials and data stay yours.** AgentChainer never logs you in, never stores tokens or API keys, and has
   no telemetry ([privacy](docs/PRIVACY.md)).

## How sign-in works

You install the official Claude Code CLI and **sign in yourself, in your own terminal** (`claude auth login`). AgentChainer
only checks that `claude` is installed and signed in. If it isn't, the app shows a step-by-step guide:
**[docs/guides/AUTH_SETUP.md](docs/guides/AUTH_SETUP.md)**.

You need a Claude Pro, Max, Team, Enterprise or Console account, or Bedrock/Vertex/Foundry access.

## Documentation

| Doc | What's in it |
|---|---|
| [PRD](docs/PRD.md) | Problem, personas, positioning, features, user stories, non-goals, metrics |
| [Architecture](docs/ARCHITECTURE.md) | Process model, IPC, event model, permissions, bootstrap engine, security, packaging |
| [Checklist](docs/CHECKLIST.md) | The master work plan: milestones M0–M7, tasks with IDs, exit criteria |
| [Catalog](docs/CATALOG.md) | How skills, plugins and MCP servers are curated, pinned and installed |
| [Risks](docs/RISKS.md) | Risk register with mitigations |
| [ADRs](docs/adr/) | Architecture decision records |
| [Install guide](docs/guides/INSTALL.md) | Downloading, checking and opening the installers on each OS |
| [Auth setup guide](docs/guides/AUTH_SETUP.md) | User-facing tutorial for installing and signing in to Claude Code |
| [Privacy](docs/PRIVACY.md) | What stays on your machine, and every time the app uses the network |
| [Threat model](docs/THREAT_MODEL.md) | Trust boundaries, threats, mitigations and the latest security review |
| [Releasing](docs/RELEASING.md) | How releases are built, checked and published (maintainers) |

## Stack

Tauri v2 (Rust core) · React + TypeScript UI with Radix primitives · Node sidecar running the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) · Monaco · xterm.js. React Flow comes with the
agent graph in v0.2. See [ADR-0001](docs/adr/0001-desktop-stack.md) and [ADR-0008](docs/adr/0008-ui-components-and-styling.md).

## Roadmap

| Release | Scope |
|---|---|
| v0.1 | Agent session core (chat, approvals, sessions, diffs, checkpoints, cost) + workspace bootstrap |
| v0.2 | Adaptive planner, task contracts, evidence reports, live agent graph |
| v0.3 | Worktree-per-task, PRs, CI fix loop, merge gates |
| v0.4 | Deploy adapters, editable workflow canvas |
| v0.5 | Evals and analytics |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow and the checks every PR must pass, and
[SECURITY.md](SECURITY.md) to report a vulnerability privately. This project follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE). See [ADR-0006](docs/adr/0006-license.md) and [NOTICE](NOTICE).

---

AgentChainer is an independent open-source project and is **not affiliated with or endorsed by Anthropic**.
"Claude" and "Claude Code" are trademarks of Anthropic.
