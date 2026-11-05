# Using AgentChainer

AgentChainer is a desktop app for working with Claude on your own code:
- Claude works in a folder you pick, and asks before it does anything your permission profile doesn't allow.
- You see every edit as a diff, and you can rewind or revert it.
- Bigger work can run as a **task**: Claude drafts a contract, you approve it, and the app checks the result with your
  project's own tests and linters.
- It runs on your computer, with your own Claude Code sign-in. It has no telemetry
  ([PRIVACY](../../PRIVACY.md)).

## Pages

| Page | What's in it |
|---|---|
| [Getting started](getting-started.md) | Install, sign in, the setup check, your first chat, permission profiles, approvals, rewinding files |
| [Chats](chats.md) | The composer, `/` commands, `@` files, questions and plans, Team chats, agent profiles, resume and fork |
| [Tasks](tasks.md) | Contracts, triage and tiers, runs and gates, evidence, merging and pull requests, deploys, lessons, schedules |
| [Workspaces](workspaces.md) | Folders and multi-folder workspaces, Workspace settings, the Fleet |
| [Settings and privacy](settings-and-privacy.md) | The Settings dialog, what stays on your computer, diagnostics, menus and shortcuts |

Screenshots are from v0.1 on Windows, in the light theme. On macOS the menu is the system menu bar, and shortcuts
use ⌘ where Windows and Linux use Ctrl.

## Elsewhere

- [Install guide](../INSTALL.md): downloading and checking the installers.
- [Auth setup](../AUTH_SETUP.md): installing the Claude Code CLI and signing in.
- [GitHub setup](../GITHUB_SETUP.md): the `gh` CLI, for pull requests from a task.
- Found a bug? **Help → Report an Issue**, and attach the file from **Help → Export Diagnostics…**
