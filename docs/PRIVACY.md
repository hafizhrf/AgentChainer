# Privacy

AgentChainer is a desktop app that runs on your computer. **It has no telemetry, no analytics and no account of its
own, and its maintainers receive nothing from it.** This page lists what the app keeps on your machine, and every
time it uses the network.

Your conversations with Claude go through the Claude Code CLI that you installed and signed in to yourself. Those
conversations, and the files and command output the agent reads, are sent to Anthropic (or to Bedrock, Vertex or
Foundry, if you set the CLI up that way). That data is covered by your agreement with that provider, not by this page.
AgentChainer never signs you in, and never reads or stores your credentials ([ADR-0002](adr/0002-auth-and-branding.md)).

## What stays on your machine

**App folders.** These are the standard folders for the app id `io.github.hafizhrf.agentchainer`:

| | macOS | Windows | Linux |
|---|---|---|---|
| Settings | `~/Library/Application Support/<id>/` | `%APPDATA%\<id>\` | `~/.config/<id>/` |
| Data | `~/Library/Application Support/<id>/` | `%APPDATA%\<id>\` | `~/.local/share/<id>/` |
| Logs | `~/Library/Logs/<id>/` | `%LOCALAPPDATA%\<id>\logs\` | `~/.local/share/<id>/logs/` |

| What | Where | What's in it |
|---|---|---|
| Settings | `settings.json` in Settings | Default model, mode, effort and editor; spend cap; theme; the Claude CLI path, if you set one; your recent folders. |
| Cost history | `agentchainer.db` in Data | Per turn: session id, folder, time, cost and token counts. No prompts or replies. |
| Agent SDK | `sdk/` in Data | The pinned Claude Agent SDK, downloaded and verified on first run. |
| Tools | `tools/` in Data | Pinned tool binaries that setup installs, such as gitleaks. |
| App log | `agentchainer.log` in Logs | App and agent-runtime messages, including errors. It doesn't log conversations, but an error message can quote a file path or command output. |
| Crash logs | `sidecar-crash-*.log` in Logs | The last lines the agent runtime printed before it stopped. |
| Layout | The app's web storage | Panel sizes, and whether panels are open. |

**In your project folder**, AgentChainer only writes when you apply a workspace setup, save the workspace profile, or
work on a task (preview):
- the files the plan showed you;
- `.agentchainer/`, which holds:
  - backups and run records, so you can roll back;
  - hook scripts;
  - a record of items installed only for you, which is kept out of git;
  - the profile, kept out of git;
  - your tasks: each one's request, contract and triage (`tasks/`), kept out of git.

**Sessions** are the Claude CLI's own session files. AgentChainer lists and resumes them through the Agent SDK and
doesn't keep a copy ([ADR-0004](adr/0004-session-data.md)).

To remove everything, uninstall the app and delete the three folders above, plus `.agentchainer/` in any project you
set up.

## When the app uses the network

| When | Where | Why |
|---|---|---|
| First start, and after an update that changes the SDK version | `registry.npmjs.org` | Downloads the pinned Agent SDK and checks its integrity hash. |
| Every session | Through your Claude CLI | Claude itself. See the provider note above. |
| When you apply a setup that installs something | `github.com`, `codeload.github.com`, and `registry.npmjs.org` for MCP servers | Downloads exactly the pinned versions, checked against their hashes ([ADR-0005](adr/0005-catalog-trust-model.md)). The CLI fetches plugins from their marketplace repositories. |
| When you click **Create PR…** on a task (M5) | Your repository's `origin` (through your git credentials) and the GitHub API (through your own `gh` login) | `gh` checks your sign-in for the remote's host when the dialog opens. **Push and create PR** pushes the task's branch and opens the pull request you previewed. |
| While a task's page with a pull request is open (M5) | The GitHub API, through your `gh` | Reads the PR's checks, every 30 s and then less often, until they finish. **Fix CI…** reads the failing job's log (cut and redacted) and, when you click **Fix this**, pushes the fix to the task's branch. |
| When you click **Check the gates**, **Review the PR** or **Merge** on a task (M5) | The GitHub API, through your `gh` | Reads the PR's head, checks and merge settings; Merge asks GitHub to merge the PR you confirmed. The scanners (gitleaks, semgrep, trivy) run offline on your machine. |
| When a task's Deploy card opens, and when you click **Deploy preview** (M6) | The provider, through its own CLI (e.g. Vercel), and the deployment's URL | The card runs the CLI's `whoami` (only its exit code is kept). Deploy preview uploads the task's branch to the provider as a preview, then the smoke test runs `scripts/smoke.*` or GETs the deployment URL. The CLIs run with their telemetry off. |
| When you click **Check for updates** | `github.com` (this project's releases) | Fetches `latest.json`. An update downloads only when you click **Install**, and it must carry the project's signature. |

AgentChainer never checks for updates by itself, and sends nothing about you or your projects anywhere.

## Diagnostics

**Help → Export diagnostics** writes a file to a place you choose. Nothing is uploaded. The file contains:
- versions, the OS, your settings and the setup check;
- the recent app log and crash logs.

Before it's written, the file is redacted:
- your home folder becomes `~`;
- API keys, tokens, passwords and email addresses are masked.

Read it before you attach it to a public issue: redaction catches common formats, not every possible secret.

## Changes

This page changes in the same pull request as the behavior it describes. If AgentChainer ever adds telemetry, it will
be opt-in and listed here first (checklist X-04).
