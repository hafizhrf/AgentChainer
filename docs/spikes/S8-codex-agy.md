# Spike S8: Codex and the Antigravity CLI as step backends (M9-02)

**Status:** done (2026-11-10): the Codex half, then the agy half once the owner installed `agy`.
**Related:** [ADR-0012](../adr/0012-multi-agent-backends.md), M9 in the CHECKLIST, THREAT_MODEL T-19, RISKS R-19
and R-20.

## Question

Can a task step run on the user's own Codex CLI, through `codex app-server`, so that:
- every command and file change passes the app's guard and approvals **before** it runs;
- a step can resume its thread for fix rounds;
- read steps can't write;
- the app gets enough usage data to count the step against its budget?

## Method

`packages/sidecar/scripts/spike-codex.ts`:
- spawns `codex app-server` (JSON-RPC over stdio, newline-delimited, no `jsonrpc` field), found with `resolveCli` from
  `deploy/cli.ts` (on Windows, `node` plus the npm shim's script);
- uses a scratch git repo with one commit;
- runs three phases:
  - **A:** a write thread in the `workspace-write` sandbox with the `untrusted` approval policy. The prompt asks Codex
    to create `hello.txt`, run `git status --short`, then run `git push --force origin main`. The spike answers each
    approval: it accepts the edit and `git status`, and declines the force push, as the guard would.
  - **B:** a new process resumes the thread by id (`thread/resume`) and appends to the file.
  - **C:** a `read-only` thread with the `never` policy is asked to create a file.

The protocol's types came from `codex app-server generate-ts` (no model calls).

**Setup:**
- Codex CLI 0.157.0, Windows 11, signed in with ChatGPT (`codex login status`).
- Model `gpt-5.6-luna`, reasoning effort `low`.
- Usage: about 104k tokens for the thread of A and B (67k of it cached input, 690 output) and 33k for C (16k cached).
  It's plan usage; no dollar cost is reported.

```bash
node packages/sidecar/scripts/spike-codex.ts --cwd <empty scratch dir> --model gpt-5.6-luna --effort low [--record raw.jsonl]
```

## Results

| Check | Result |
|---|---|
| `initialize` → `initialized`, `thread/start` | ok |
| A: the edit | `item/fileChange/requestApproval` → accepted; `hello.txt` = `hi` |
| A: `git status --short` | `item/commandExecution/requestApproval` → accepted; ran, exit 0 |
| A: `git push --force origin main` | asked → **declined**; Codex reported "the force-push was denied" and the turn completed |
| B: resume in a new process | `thread/resume` ok; the next turn appended; `hello.txt` = `hi there` |
| C: read-only sandbox | no approval asked (policy `never`); the write was blocked ("writing is blocked by read-only sandbox"); no `ro.txt` |

**What the protocol gives a backend:**
- **The item comes first.**
  - `item/started` arrives before its approval request. A file change's approval carries only ids, but the started
    item lists `changes[]` with each path, its kind (`add`, …) and its diff. So the guard can check the paths before
    answering.
  - A command's approval carries the command and `commandActions[].command`, the command without the shell around it.
- **Windows wraps commands.** The command is `"…\powershell.exe" -Command 'git status --short'`. The guard must
  check the unwrapped `commandActions` commands, not only the wrapped string.
- **Decisions** are `accept`, `acceptForSession`, `decline` or `cancel` (commands also allow an execpolicy
  amendment). A declined command shows up in Codex's stderr as "rejected by user", and the model is told.
- **Usage:** `thread/tokenUsage/updated` reports `total` and `last` token counts (input, cached input, output,
  reasoning) and the context window. There are no dollars, so cost needs a price table, as ADR-0012 says.
- **Turns:** `turn/completed` gives the status (`completed` or `failed`), its error, the duration and the final
  `agentMessage`.
- **Streaming text:** `item/agentMessage/delta`.

**Surprises:**
- **The user's own Codex config applies.**
  - The owner's `~/.codex/config.toml` names a model (`gpt-6.1-sol`) that their ChatGPT login can't use, and the
    first run failed with `model_not_found`. `model/list` (no model calls) lists what the login can use:
    `gpt-6-luna` (the default), `gpt-5.6-terra`, `gpt-5.6-luna`.
  - The app-server also loads the user's hooks and MCP servers (45 `mcpServer/startupStatus/updated` events).
  - So a backend should always set its model, and say which of the user's settings apply. M9-04 decides; the
    candidate is `-c` overrides per run.
- **Server-to-client request ids start at 0,** in their own sequence. A client must not mix them with its own.
- **The protocol is marked experimental,** and Codex deprecates parts of it (here: full-history hydration). Pin the
  methods the backend uses in `cli-contract.ts` and check them weekly.

## Decision

Codex fits ADR-0012 as planned. M9-04 builds the backend on `codex app-server`:
- **Before answering an approval:** the guard checks the started item's paths and the unwrapped commands. A denial
  answers `decline`, and the reason goes into the evidence.
- **The permission profile maps** onto the approval policy and sandbox:
  - read steps: `read-only` + `never`;
  - write steps: `workspace-write` + `untrusted` (ask for everything), so nothing runs unseen;
  - Standard's "edits run" can accept file changes inside the worktree without the dialog, once the guard passed
    them.
- **The model:** always set from the step or the role, with a fallback to Codex's own default from `model/list`.
- **Fix rounds** resume the thread by id.
- **Cost:** `last` tokens × a pinned price table, labeled as an estimate.
- **Methods to pin in `cli-contract.ts`:**
  - requests: `initialize`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, `model/list`;
  - notifications: `item/started`, `item/completed`, `item/agentMessage/delta`, `thread/tokenUsage/updated`,
    `turn/completed`;
  - server requests: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`.

## The agy half

### Question

Can a task step run on the user's own Antigravity CLI (`agy`) headless, writing files but with nothing running unseen,
and without touching the user's own settings? ADR-0012 planned a per-run allowlist: edits inside the worktree, plus
the project's gate commands.

### Method

`packages/sidecar/scripts/spike-agy.ts` runs `agy -p … --output-format stream-json` in a scratch git repo:
- **Setup:** agy 1.5.4, Windows 11, signed in with the owner's Google account, model `gemini-3.8-flash-low` (from
  `agy models`, which also shows the sign-in works). About 23k tokens a phase.
- **Per-run settings:** `--settings <json>`, "for this session only, never saved".
- **The user's own settings file** is never read: the spike only compares its modification time before and after.
- **Phases:**
  - **A:** `--mode accept-edits --sandbox`, `toolPermission: request-review`; an edit and a command.
  - **B:** resume with `--conversation <id>`.
  - **C:** a per-run `deny: write_file(*)`.
  - **D:** `toolPermission: proceed-in-sandbox` with a per-run `deny: command(git log)`, asking for `git log`.

Before the final run, smaller runs tried per-run `allow` rules for a command (`command(git)`, `command(git status)`),
with and without `--sandbox`.

### Results

| Check | Result |
|---|---|
| A: the edit under `accept-edits` | ran; `hello.txt` = `hi` |
| A: `git status --short` under `request-review` | **refused**, as a tool error ("user denied permission… Do not attempt to circumvent"); `result.denied_actions` lists it; exit code 0; stderr explains the soft-deny; the turn ended there |
| Per-run `allow: command(git)` / `command(git status)` | **ignored**: under `request-review` the command was still refused, with or without `--sandbox` |
| B: `--conversation <id>` | the same conversation (step numbers continue); `hello.txt` = `hi there` |
| C: per-run `deny: write_file(*)` | **honored**: the write failed with "Matches user-configured deny rule"; no `ro.txt` |
| D: per-run `deny: command(git log)` under `proceed-in-sandbox` | **ignored**: `git log` ran |
| The user's settings file | unchanged (modification time) |

**The stream:**
- One JSON object per line, keyed by its event: `{"event":"step_update","step_update":{…}}`. The docs show the
  fields without the wrapper.
- `init`: the model, the cwd, the tool list and the permission mode.
- `step_update`: `step_type` is `user_input`, `agent_response` (with `text_delta`), `tool` (with `tool_info`:
  name, parameters, error) or `system_message`; `state` is `ACTIVE`, `DONE` or `ERROR`.
- `result`: status, response, duration, turns, `usage` (input, output, thinking, cache-read tokens) and
  `denied_actions`.
- **No dollar cost,** as with Codex.

**The tools:**
- File tools are `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `sed_file` and `notebook_edit`,
  and `view_file`, `list_dir`, `grep_search` and `find_by_name` for reading.
- The runs created files only, which `tool_info` reported as `write_file` with a `Path`. That the editing tools report
  the same way is **(verify)** in M9-05.
- `init` also lists browser, web search, image, schedule, messaging and subagent tools. Anything that needs a
  permission is refused headless under `request-review`.

### Decision for M9-05

The per-run allowlist ADR-0012 planned **doesn't hold in agy 1.5.4**. Per-run command rules are ignored either way:
- `request-review` refuses every command, allowed or not;
- `proceed-in-sandbox` runs every command in its sandbox, denied or not.

Per-run *file* rules do hold. So an agy step:
- **Write steps:**
  - `--mode accept-edits --sandbox` with `toolPermission: request-review`;
  - agy edits files and **runs no commands**: none can run unseen;
  - the project's gates are run by AgentChainer after the step, as for every agent;
  - the prompt says so, since a refused command ends agy's turn.
- **Read steps** (plans, reviews): the same, plus `deny: write_file(*)`.
- **Afterwards:** every path agy wrote, from `tool_info`, is checked against the guard and the worktree. A breach
  fails the step and goes into the evidence.
- **Resume:** fix rounds resume with `--conversation <id>`.
- **Settings:** always through `--settings`, never the user's own file.
- **Sign-in:** `agy models` is the readiness probe. It needs a working login and reads no credentials.
- **Cost:** tokens × a price table.

Owner decision (2026-11-10), honored: agy may write. It writes files, and the app runs the commands.

## Still open

- **For M9-05:**
  - whether a write outside the workspace is refused headless (the docs say unlisted paths ask, which headless
    refuses); the after-the-fact path check covers it either way;
  - and whether a later agy honors per-run command rules. `cli-contract` should re-check that.
- Whether `acceptForSession` should ever be offered to Codex.
- Codex's own `--approve-for-me` reviewer stays off.
