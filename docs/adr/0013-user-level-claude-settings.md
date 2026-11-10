# ADR-0013: Permission rules and plugins for all projects, in the user's own Claude settings

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** hafizhrf (owner)
- **Related:** UX-19 (CHECKLIST), [ADR-0002](0002-auth-and-branding.md), [ADR-0010](0010-unreviewed-marketplace-plugins.md),
  THREAT_MODEL T-03 and T-20

## Context

Workspace settings are per repository. The owner (2026-11-10): "di workspace setting juga masih terpisah pisah per
repo, jadi rada ribet setting satu satu, gak ada opsi apply to all". They chose app-wide defaults that a workspace can
override, for task defaults and also for permission rules and plugins.

Claude Code already has the level this needs. Every project reads the user's settings (`~/.claude/settings.json`, or
`$CLAUDE_CONFIG_DIR/settings.json`), and merges them with the project's own rules. A plugin installed with
`--scope user` is enabled in every project. Until now the app wrote only a workspace's `.claude/` files. The one
exception was user-scope subagents in `~/.claude/agents/` (M4-06).

These are the user's own CLI settings. They apply outside the app too, in sessions run in a terminal. They can also
hold things that aren't the app's to touch: `env` values, hooks, a model, a status line.

## Decision

The app may write the user's own Claude settings, **only for permission rules, and only when the person asks**.

- **Permission rules:** Workspace settings → Permissions gets an "All projects" level. Its rules are listed, added
  and removed in the user's settings file. Only the `permissions` lists are read or changed; every other key stays
  as it was and never leaves the sidecar. The page warns that the change applies to every project, including
  terminal sessions.
- **Plugins:** "All projects" is a third install scope, run as the CLI's own `claude plugin install … --scope user`.
  The app doesn't edit the file for this; the CLI does. The ADR-0010 review and confirmation rules are unchanged.
- **Writes:**
  - atomic, through a temporary file;
  - a user settings file that's a link (dotfiles kept elsewhere) is written where it points, so the link stays;
  - a workspace's own rule files still aren't written through links (T-03).
- **Not written:** hooks, `env`, model, MCP servers or anything else in the user's settings. Credentials never
  (ADR-0002).
- **"Apply to all workspaces"** (a copy into each known workspace's own file) stays available next to "All projects",
  for someone who wants the rule per repository.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Copy into every workspace only | Never touches the user's own settings | A new workspace misses the rule; changing it means another round of copies | Kept as an option, but it isn't "for all" |
| App-level rules injected per session (`settings` option) | Only AgentChainer's sessions | The CLI and other tools don't see them; two places for the same rules | Two sources of truth |
| Write any user setting | Full parity with editing the file by hand | Hooks and `env` can run code or carry secrets | Out of scope; permissions only |

## Consequences

- **Positive:** one place for rules that apply everywhere, read by the CLI itself, so terminal sessions agree with
  the app.
- **Negative:**
  - A mistaken allow rule now applies to every project. The page says so, and removing it is one click.
  - The app now writes outside the workspace. That's a new write target in the threat model (T-20).
- **Revisit when:** the CLI changes where or how it keeps user settings, or someone asks for other user settings in
  the app.

## References

- Claude Code settings files and precedence: https://code.claude.com/docs/en/settings (verify)
- `claude plugin install --scope user`: `packages/sidecar/src/installer.ts`
