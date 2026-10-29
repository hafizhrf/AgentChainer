---
name: ac-setup-hooks
description: Add Claude Code hooks that format and lint every file Claude edits, using the project's own tools. Used by AgentChainer's workspace bootstrap.
---

# Set up format and lint hooks

You propose `.claude/settings.json` (merged with what exists) and, if needed, one small hook script under
`.claude/hooks/`. You don't write files: you return them.

## How Claude Code hooks work

- `PostToolUse` hooks run after a tool call. Use the matcher `Edit|MultiEdit|Write`.
- The hook command receives the tool call as JSON on stdin; the edited file is `tool_input.file_path`.
- A hook entry looks like:
  `{"hooks": {"PostToolUse": [{"matcher": "Edit|MultiEdit|Write", "hooks": [{"type": "command", "command": "…"}]}]}}`
- `$CLAUDE_PROJECT_DIR` is the project root inside the command.
- Exit code 0 is success. Exit code 2 sends stderr back to Claude as feedback; use it for lint errors Claude should fix.

## Write

- Use the formatter and linter the project already has (from the workspace profile). Don't add new tools.
- Format only the edited file, not the whole project, and only file types the tool handles.
- Prefer a hook script in the project's own language runtime when one is clearly available (a `.mjs` file for Node
  projects, a `.py` file for Python, a `.sh` file for Go or Flutter on macOS/Linux). Keep it under 60 lines,
  dependency-free, and silent on success.
- The script must exit 0 when the file isn't one it handles, and never fail the session because a tool is missing.
- Merge into an existing `.claude/settings.json`: keep every existing key, permission and hook.
- No secrets and no network calls.
