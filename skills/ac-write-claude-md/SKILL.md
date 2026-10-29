---
name: ac-write-claude-md
description: Write or update a project's CLAUDE.md so Claude starts every session with the real commands, a short architecture map, conventions and a Definition of Done. Used by AgentChainer's workspace bootstrap.
---

# Write CLAUDE.md

You propose the full content of the project's `CLAUDE.md`. You don't write files: you return them.

## Gather facts first

- Read the workspace profile you're given: stacks, packages, and the detected commands with their sources.
- Read the existing `CLAUDE.md` (or `.claude/CLAUDE.md`) and `AGENTS.md`, if any. Read the README, the manifests and
  the top-level layout. Use Grep and Glob instead of guessing.
- You may run the detected test, lint, typecheck and build commands to confirm they work. Note which ones you ran and
  their exit codes. Don't claim a command works if you didn't run it or it failed.

## Write

Keep it short: Claude reads it at the start of every session. Aim for 40–150 lines, never more than 300.

1. One or two sentences on what the project is.
2. **Commands**: a table of install, build, lint, format, typecheck, test and dev, with the exact command and the
   folder to run it in. Only commands that exist. Mark any you couldn't verify.
3. **Layout**: the main folders and what lives in each, one line each.
4. **Conventions**: what a contributor must know that the code doesn't make obvious (naming, patterns, where tests
   go, generated files not to edit).
5. **Definition of Done**: the checks a change must pass (the real test, lint and typecheck commands).

## Merging

- If a CLAUDE.md exists, keep everything in it that is still true and specific. Fix what's wrong, add what's missing,
  drop what's generic advice. Never silently drop project-specific rules.
- If `AGENTS.md` exists, start with `@AGENTS.md` so Claude Code imports it, and don't repeat what it says.
- No secrets, tokens, personal paths or machine-specific details.
