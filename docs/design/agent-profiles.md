# Design: agent profiles (M8-04)

- **Status:** Accepted by the owner, 2026-11-03
- **Covers:** M8-04, an agent profiles manager: templates, edit, clone and delete, validated before saving, with a
  tool allowlist per profile
- **Source:** [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator)'s profile editor (CAO,
  Apache-2.0), used as ideas only; no code is copied
- **Builds on:** M4-06's agent library (Workspace settings → Agents), M3-05's shipped roles, M8-03's Team chats

## 1. The problem

The Agents section of Workspace settings already lists, creates, edits and deletes a project's `.claude/agents/*.md`.
Several things are still missing:
- **Templates and clone:** a new agent starts from a blank form, and an agent can't be cloned.
- **Validation:** only the name is checked, so a typo in a tool name is saved silently.
- **The user's own agents** are read-only.
- **Tools:** they are free text, and nothing the app runs uses them.
- **Running a profile:** an agent works only as a CLI subagent. The app can't run a chat or a Team worker as one.

## 2. Decisions (owner, 2026-11-03)

1. **Format:** the CLI's own `.claude/agents/<name>.md` (YAML front matter, then the prompt), so a profile is still a
   CLI subagent. Both scopes can be edited:
   - project: `<workspace>/.claude/agents`;
   - user: `~/.claude/agents`, or `CLAUDE_CONFIG_DIR`.
2. **Where a profile runs:** besides as a CLI subagent, a profile runs as a Team worker (`assign`/`handoff` take
   `profile`) and as a new chat (`session.start {profile}`). Task workflow roles stay the 6 shipped `ac-*` roles,
   which are checked at build time.
3. **Tools are enforced.** They're picked from a checklist of known tools, plus MCP entries. When the app runs a
   profile, only its tools are available, still under approvals and the guard.
4. **Templates:** the 6 shipped roles, plus 4 starters (`researcher`, `test-writer`, `docs-writer`, `explainer`).

## 3. Rules (`packages/protocol`, shared by the form and the sidecar)

- `KNOWN_TOOLS` groups the CLI's built-in tools for the picker:
  - read: Read, Grep, Glob;
  - edit: Edit, MultiEdit, Write, NotebookEdit;
  - shell: Bash, BashOutput, KillShell;
  - web: WebFetch, WebSearch;
  - other: TodoWrite, Agent, Task, Skill, AskUserQuestion.
- An MCP entry is `mcp__server`, `mcp__server__*` or `mcp__server__tool`.
- `agentProblems(agent, taken)` lists what's wrong, field by field:
  - **Name:** the name pattern, and no other agent in the same scope with that name.
  - **Description and prompt:** non-empty, and within size.
  - **Model:** `inherit`, `haiku`, `sonnet`, `opus`, `fable` or a `claude-…` id.
  - **Tools:** each known or a valid MCP entry, none listed twice.

  The form shows the problems live, and the sidecar refuses a save that has any.

## 4. Saving

- **A project agent** is saved as before: a recorded run that History can roll back.
- **A user agent:**
  - it's written in place, through a temporary file and then a rename;
  - it isn't the workspace's, so there's no run, and the form says so before saving.

  Both rename by `previousName` and keep front matter fields the form doesn't show.
- **`agents.templates`** returns the roles and the starters. A template only fills the form: a shipped role's copy
  gets a `-copy` suffix, so it doesn't shadow the original.

## 5. Running a profile (`packages/sidecar/src/profiles.ts`)

- **Finding the profile:** `loadProfile` takes the project's agent of that name first, then the user's. It refuses an
  unreadable file or one with problems.
- **The session options:** `profileOptions` maps the profile to them:
  - `appendSystemPrompt`: the profile's prompt (a chat also adds the ask-first line; a worker also adds how to
    report);
  - `model`, unless `inherit`. The person's own pick for a chat wins;
  - `tools`: the profile's built-in tools. A chat also keeps AskUserQuestion, EnterPlanMode, ExitPlanMode and
    TodoWrite, which only ask the person or narrow what Claude may do;
  - `disallowedTools: ["mcp__*"]` when the profile names no MCP entry;
  - a profile with no tool list has every tool, as for a CLI subagent.
- **A read Team worker:** it keeps the read-only hook. Its tools are the profile's read tools, or Read, Grep and Glob.
- **Known limits:**
  - **MCP is all or nothing.** The app can't know which servers the CLI loads before the session starts. So a profile
    that names some MCP entries keeps every MCP server the session has: its allowlist is exact for built-in tools,
    and all or none for MCP.
  - **Team chats keep their MCP tools.** A Team chat with a profile keeps them, since the app's own tools are MCP.
- **Checked live** (`spike-host.ts --scenario profile`, haiku):
  - an unknown tool is refused on save;
  - a chat run as a read-only profile answered in its voice on haiku, and its attempt to Write got "No such tool
    available";
  - a Team worker ran as the profile.

## 6. UI (PR 2)

```
 Workspace settings → Agents
 ┌──────────────────────────────────────────────────────────────────┐
 │ [New agent ▾]  blank · from a role (ac-architect, …) · starter   │
 │ explainer   project · Read Grep Glob · haiku       Edit Clone ⋯  │
 │ researcher  user    · Read … WebSearch             Edit Clone ⋯  │
 └──────────────────────────────────────────────────────────────────┘
 Edit agent
   Name [explainer]  Save to (•) This project ( ) All my projects
   Tools ( ) All tools  (•) Only these:
     Read ☑ Grep ☑ Glob ☑ │ Edit ☐ Write ☐ … │ Bash ☐ … │ WebFetch ☐ …
     MCP entries [mcp__github__*]
   ⚠ Tools: Teleport isn't a known tool.            [Save] (disabled)

 Start screen → Options: Agent profile [None ▾]
```

- **The Agents section:**
  - New offers blank, a role, or a starter;
  - each row has Clone;
  - the form has a scope choice and a tool picker, and lists problems live;
  - user agents can be edited, with a note that History doesn't cover them.
- **The start screen:** its Options get an **Agent profile** select. The tab shows the profile as a chip.
- **Team workers:** a worker with a profile shows it in the sidebar and on its Team tool row.
