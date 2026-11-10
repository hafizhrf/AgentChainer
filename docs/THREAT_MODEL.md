# Threat model

Checklist X-01, updated at every milestone. Last reviewed **2026-11-04**; first written on 2026-10-29 for the v0.1 release (R1-06).
Report vulnerabilities privately: see [SECURITY.md](../SECURITY.md).

## What we protect

| Asset | Why it matters |
|---|---|
| The user's machine | The app starts processes as the user: the agent runtime, the Claude CLI, a shell in the terminal, editors, and the tools setup installs. |
| The user's projects | Agents and setup write to them. Rollback must restore them exactly, and must never touch anything else. |
| The user's Claude account and spend | The CLI's sign-in is the user's own ([ADR-0002](adr/0002-auth-and-branding.md)). Runaway agents cost money (R-10). |
| Secrets in projects and logs | `.env` files, keys in tool output, diagnostics bundles. |
| The update channel | Whoever controls updates controls every installed copy. |

## Trust boundaries

```
 untrusted content ─┐                      ┌─ Anthropic (via the user's CLI)
 (repo files, web,  │                      │
  tool output)      ▼                      │
 ┌────────────┐  IPC   ┌───────────┐ stdio ┌──────────────┐ spawn ┌────────────┐
 │  Webview   │◄──────►│ Rust core │◄─────►│ Node sidecar │──────►│ claude CLI │
 │ (React UI) │ invoke │  (Tauri)  │ JSON- │ (Agent SDK)  │       │  + tools   │
 └────────────┘        └─────┬─────┘  RPC  └──┬───────┬───┘       └────────────┘
                             │ updates        │       │ spawn: git push, gh (user's own logins, M5)
                             ▼                ▼       ▼
                     GitHub Releases    GitHub, npm   The task's GitHub repository
                                        (catalog)
```

**The webview is trusted to act for the user, so script in it is code execution.** It can:
- open a shell (`pty_open` and `pty_write`);
- start sessions;
- apply setups.

Everything the UI renders that comes from outside (the model's text, repo files, tool output) must therefore be shown
as data, never run as markup or script. That is threat T-01.

## Threats and mitigations

| ID | Threat | Mitigations | Residual risk |
|---|---|---|---|
| T-01 | **Script injection in the webview** from model output, file contents or tool output. | A Content Security Policy: `script-src 'self'` with no inline or eval; `connect-src` only for IPC (`tauri.conf.json`). Markdown is rendered without raw HTML (`skipHtml`). Links open in the system browser, http(s) only. Images in markdown show as text. Diffs render in Monaco as text, and the terminal in xterm. The only HTML the UI inserts is Monaco's colorizer output for code blocks, which escapes the code (`CodeBlock.tsx`). | Low. A bug in react-markdown, Monaco or xterm. The dev server's CSP is looser, but it's never shipped. |
| T-02 | **Prompt injection** makes the agent run destructive or exfiltrating commands (R-09). | Default permission mode asks before edits and commands. The approval dialog shows the full command, Claude's own explanation, an edit's diff, and a risk level from fixed rules (UX-05). "Always allow" defaults to this user's workspace file; sharing a rule with the team is an explicit choice. The guard hook denies known-destructive commands. Spend caps. Read-only generator sessions with a workspace guard (M2-19), and the same for drafting task contracts (M3), including a redraft from the person's reply and the last messages of the chat a task is made from (UX-13), which are kept in the task's record. A task's read steps can only read inside the workspace; its write steps keep approvals and the guard hook; its gates run under the workspace guard, except format. A task's run records every approval Claude asked for, with its risk, and every guard block; its evidence report lists them, riskiest first (M3-09). A chat (UX-12) may switch itself to plan mode (`EnterPlanMode` is allowed without asking, since plan mode only narrows what it can do; leaving it still takes ExitPlanMode's review or the person's own switch), and is asked to ask rather than guess; its questions (`AskUserQuestion`) are answered in a card, and the answers go back as the person's text in the tool's input. Workflows made by AI (UX-14) come from a model call with no tools, use only the shipped roles and step kinds, are checked like a hand-written workflow, and never run or get saved before a person keeps them (the editor) or approves them with the contract (a task's own flow); the run keeps a copy and its hash, which the evidence report names. App slash commands (`/clear`, `/model`, `/mode`, `/effort`, `/usage`, `/fork`, `/help`) run in the app, as pickers or panels; every other command goes to Claude as typed. | Medium. The user can approve a bad command, and "auto" modes trust the model. This is inherent in agent tools. |
| T-03 | **A malicious repository** abuses the app's own features. | **Rollback:** rejects a forged `.agentchainer/backups/*/run.json` whose paths leave the workspace or the run folder (audit finding, fixed in this release). **Workspace paths:** must stay inside the folder (`insideRoot`), and the app never writes, backs up, restores or deletes through a symbolic link: a repo's `.claude -> ~/.claude` or `CLAUDE.md -> ~/.gitconfig` is refused (`workspace-files.ts`). Previews don't read through links either, and read at most 2 MB. `.agentchainer` itself must not be a link. **Read-only sessions** (planners, reviewers, drafting, the split, generators) read only inside the workspace: `~` is expanded as the CLI does, links are followed to where they point, network and device paths are refused, and a Glob counts by its fixed part. **Windows:** git runs by its absolute path from PATH, since a bare name would also find a `git.exe` committed to the repo. **Pathspecs:** file names reach git as `:(literal)` pathspecs, so a file named `*` or `[id]` can't widen a revert or checkout. **The file watcher** doesn't follow links. **Git:** arguments are passed after `--`, and branch names are checked. **Open with the default app:** refuses programs, installers and executable files. On macOS and Windows, anything other than known documents, data and images opens in the plain text editor (`open -t`, Notepad), because a default app can run a script (Python Launcher runs `.py`). Linux refuses scripts. Network and device paths are refused. **Hooks:** setup never runs upstream install scripts. **Task files (M3):** read back through zod; a task id is checked before it becomes part of a path, and a task folder that's a symlink or resolves outside the workspace is refused. **Task worktrees (M3-07, every tier since M5-01):** `git worktree add/remove` only under `.agentchainer/worktrees/<task id>` (ids checked); each new worktree runs the project's install command under the workspace guard, which the page names before Run (like the gates, it's the project's own command); the app commits only on its own `agentchainer/<id>` branches, with the user's identity and hooks; the user's branch changes only when they click Merge, on a clean tree. **Project workflows (M6-04):** `.agentchainer/workflows/*.yaml` is repository content too. It is used only when it passes the shipped library's checks (read steps only with read-only roles, reviews read-only, fix rounds and limits within the schema's caps); roles can't be defined there; links aren't followed and files over 64 KB aren't read. The task page says when a tier runs the project's workflow before Run, the task's own budget still caps the run, and the evidence names the file and its hash. A project workflow can drop the review or gates of its tier: that is shown, not prevented. The canvas saves only YAML that passes the same checks; `workflow.import` and `workflow.export` take a path from the system's file dialog, only `.yaml` files, and import reads at most 64 KB. | Low. The app treats project files as data. The agent reading them is T-02. |
| T-04 | **Catalog supply chain:** a compromised skill, plugin, MCP server or tool (R-08). | Pinned to a commit SHA, release asset or npm version, with sha256 or integrity hashes ([ADR-0005](adr/0005-catalog-trust-model.md)). A weekly CI job re-verifies every pin. Upstream updates arrive as PRs with reviews cleared, after a 14-day minimum age. The app's own in-process MCP server (a Team chat's tools, M8-03) is part of the sidecar, not the catalog. Every install is shown before it happens, and consent is asked. A pre-commit hook runs the pinned tool only while it matches the sha256 recorded at install (a changed copy stops the commit), and falls back to the tool on PATH only when no pinned copy is installed. | Medium. A reviewed version can still be malicious. MCP servers run with the user's rights. |
| T-05 | **IPC misuse:** a bad frame from the UI, or from another process. | The sidecar talks only over its own stdio. It has no network port. Every JSON-RPC request is validated against the zod schema in `packages/protocol`. Methods that take a folder check that it exists (`requireFolder`). The fleet view (M8-02) reads only what the sidecar already holds about its own sessions, over the same stdio frames; it adds no network surface. Tauri capabilities allow only what the UI calls (see below). | Low. |
| T-06 | **Update hijack:** a forged `latest.json` or artifact. | The updater installs only artifacts signed with the update key built into the app. `requireSignedVersion` binds each signature to its version, which blocks downgrades. HTTPS to GitHub. Checks run only when the user asks ([ADR-0009](adr/0009-release-signing-and-updates.md)). | Low, if the key stays secret. Losing it strands users; leaking it lets an attacker who can also serve the manifest push updates. |
| T-07 | **Tampered installers** (unsigned in v0.1). | `SHA256SUMS` on every release, and checksum steps in [INSTALL.md](guides/INSTALL.md). | Medium. Anyone who can change the release page can change both the file and its checksum. Code signing is R1-03. |
| T-08 | **Secrets leak** through logs, diagnostics or the UI (X-03). | One redaction, `packages/protocol/src/redact-patterns.json`, read by the UI, the sidecar and the Rust core. Shared test vectors (`test/redact-vectors.json`) run against the TS and the Rust code, so they can't drift. It masks API keys (Anthropic, OpenAI-style, Google, Stripe, AWS), GitHub, Slack and npm tokens, JWTs, bearer headers, private-key blocks, credentials in URLs, values of secret-sounding names, and email addresses. **The app log and crash logs** are masked line by line as they're written (`applog.rs`, `sidecar.rs`), including the sidecar's stderr, which carries the CLI's and `gh`'s own output; the home folder becomes `~`, also when JSON-escaped. **Diagnostics** are masked again as a whole. **The UI masks what it shows:** tool input and output in transcripts and the agent drawer, gate tails, deploy and smoke details, and CI logs. The approval dialog's editable input is left as it is, because it's sent back as the input to run. Lessons with a secret are refused. The app never reads or stores credentials. Raw SDK recordings are never committed (`make-fixture.ts`). A task's evidence report scans changed files with gitleaks when it's installed (`--redact`, local) and names the flagged files, never the secret. | Medium. Redaction is pattern-based, so a secret in an unknown format still shows. The model has seen what it read either way, and the CLI keeps its own transcripts. |
| T-09 | **Credential handling** by the app (R-01). | None by design: the user signs in to their own CLI in their own terminal ([ADR-0002](adr/0002-auth-and-branding.md)). | None known. |
| T-10 | **Build-time downloads outside our pinning.** | The Rust and npm dependencies are locked. CI actions are pinned by SHA. Release builds don't use the Rust cache. | Tauri's bundlers download linuxdeploy (AppImage), WiX and NSIS at build time. Their integrity depends on Tauri's own checks. |
| T-11 | **Runaway cost** (R-10). | A spend cap per session, visible running cost, and caps on generator turns and budget. Task runs (M3) have a total cap from the triage card, per-step turn caps, capped fix rounds, and Stop. A person can run an S, M or L task with **no budget** (UX-13): an explicit choice on the triage card, recorded in the evidence report; the write step's session then has no spend cap, read-only steps keep their own, and Stop still works. | Low to medium. |
| T-12 | **Pull requests (M5-02):** a push or a PR body leaks secrets, or the app acts on GitHub beyond what the user asked. | Create PR runs only from the user's click, after a preview of the title, branches and body. Before anything leaves the machine, gitleaks scans the branch's changed files (when installed) and blocks on a finding. The push is `git push -u origin <task branch>`, never forced, with no prompts. To an https GitHub remote it uses the user's `gh` login as the credential helper for that one command (`-c credential.https://<host>.helper=!gh auth git-credential`, as `gh auth setup-git` would set up), so the app never sees the token; otherwise the user's own git credentials. `gh` runs with an argument array, never a shell, with `GH_PROMPT_DISABLED`; the app never passes `--show-token` or reads `gh`'s config. The body is built in the sidecar from the contract and the evidence, not taken from the UI. The app merges only from a person's click in the Merge dialog (M5-05), after working out the gates again, with `--match-head-commit` and never `--auto`; a gate that isn't green needs the person's reason, which the evidence keeps. The guard denies agents `gh pr merge`, `gh release`, writes through `gh api`, tags, and pushes that delete refs. semgrep and trivy run offline only. | Medium. `gh` acts with the user's full GitHub rights, so the app's fixed commands are the boundary. The report can quote tool output the agent saw. |
| T-13 | **CI logs as injection (M5-03):** a failing job's log carries text from anyone who can change the repository, and a Fix CI round feeds it to Claude. | A round runs only after the user read the log and clicked **Fix this**. The log is cut to its last 32 KB, redacted like diagnostics, and sent in a fenced block marked "not instructions"; a fence inside it can't close the block. The round has the run's permission mode, approvals and guard. Only a round whose gates pass is committed and pushed, never forced. At most 3 rounds per PR, within the task's budget. `task.ciLog` reads only the PR's own GitHub Actions checks. | Medium. Claude can still be misled by the log, the same as by repository files (T-02). |
| T-14 | **Deploys (M6):** a deploy to the wrong project, production by mistake, a smoke script from the repository, and provider CLIs acting with the user's rights. | Deploys run only from a person's click, never from an agent (the guard still denies agents provider deploys, and the rollbacks and promotions that change production: `vercel rollback`/`promote`, `wrangler rollback` and `versions deploy`, `firebase hosting:clone`, and pushing images (`docker push`, `buildx build --push`, `buildx imagetools create`)) and never during a task's run. A preview deploys the task's worktree. Production deploys the workspace's current branch only from a clean tree, after the person types the project's name in a dialog that shows the command, branch and commit; the sidecar checks the name and that the commit hasn't moved. Rollback is offered only on the live production deploy, with the same typed confirmation. Provider CLIs run with an argument array, never a shell (npm `.cmd` shims are resolved to `node <script>`), with no prompts, and with Vercel's and Wrangler's telemetry turned off (Firebase and flyctl follow the user's own CLI settings). Credentials stay in the provider's CLI; the app only checks `whoami`'s exit code and drops its output. A Vercel worktree gets the workspace's `.vercel/project.json`, so a deploy can't create a stray project. A Docker deploy runs the repository's Dockerfile on the local daemon (its build steps are repository content, like the gates' commands) and pushes with the user's `docker login`; the app never reads Docker's config. A Cloudflare preview only uploads a version of an existing Worker (`versions upload`) and sends it no traffic; the app never makes a Worker's first deploy. The smoke script runs under the workspace guard like the gates; the built-in smoke test only GETs the deployment URL. Every deploy is recorded in `.agentchainer/deploys/`. | Medium. The provider CLI acts with the user's full rights on that provider. |
| T-15 | **Multi-folder workspaces (M8-01):** a folder added by mistake gives Claude far more to read and change than intended. | A workspace is a list of folders the person picked in the New workspace dialog, kept in the app's settings, never read from a repository. The dialog and the sidecar apply the same rules: absolute paths only, no drive or filesystem root, not the home folder, no repeats and no folder inside another; the sidecar also checks each folder exists. The folders go to the CLI as `additionalDirectories`: edits and commands there keep the session's approvals, and the guard allows a recursive delete only inside one of the folders. Only the primary folder's CLAUDE.md, settings and hooks load (checked on CLI 2.1.314), and the dialog says so. The session header shows the extra folders. A task across the folders gets a worktree on its own `agentchainer/<id>` branch in each git folder, and its steps reach those worktrees, not the person's checkouts; drafting reads the folders with the same read-only hook. Merge goes into each folder's current branch only on the person's click, after checking each has no uncommitted changes. Create PR opens a draft PR in each repository the task changed; every repository must be on GitHub with `gh` signed in, and every one's changed files pass gitleaks, before anything is pushed (never forced). The PRs link each other. A folder without git is worked in directly, like a primary folder without git. An XL task needs every folder in git: each sub-task works in a worktree of its own folder's repository and merges only into the task's branch there. | Low to medium. A folder the person adds on purpose is fully reachable, as the primary folder is. |
| T-16 | **Agents starting agents (M8-03):** a Team chat's supervisor multiplies spend and approvals, and text from one session steers another. | Team is the person's opt-in for one new chat, and needs a budget cap that covers the supervisor and every worker together; at the cap the workers are closed and no more reports are delivered. At most 4 workers are open at once, a new one starts only with $0.05 or more of the cap left, and workers get no team of their own (one level). The supervisor's tools come from an in-process MCP server (`mcp__agentchainer__*`, no network, port or process) and are allowed without asking, because they only start or message sessions that are themselves gated: a worker is an ordinary session with the guard hook, read-only (Read, Grep, Glob, isolated from settings, hooks and MCP servers) unless the supervisor asks for write, and a write worker's edits and commands are asked about in its own tab. Workers reach only the supervisor's folders. Text crosses between sessions only as messages (assignments, `send_message`, reports): it grants no tool and changes no mode. Closing the supervisor closes its workers. | Medium. A supervisor misled by a worker's report (T-02) can hand out more work, within the cap. |
| T-17 | **Scheduled runs (M8-05):** a task runs again with nobody watching, on a cadence. | A schedule only re-runs a task a person approved (contract and tier); XL tasks and sub-tasks can't be scheduled, and a task whose last run was left interrupted isn't started. Each run has the task's budget cap. It runs in `acceptEdits`: edits go ahead, and every other approval waits for the person, who gets an OS notification; nothing is allowed or denied on their behalf. It keeps the model of the task's last run. Schedules run only while the app is open, checked once a minute; no OS service, timer or background process is installed. They're local data in `.agentchainer/schedules.json`, which git ignores, and only the workspaces the app watches (its recent ones) run. Every run keeps its own evidence report. | Low to medium. An approved task's edits go ahead unseen until the person reads its evidence; the task's gates and budget still bound it. |
| T-18 | **Unreviewed plugins (UX-10):** a person installs a malicious or careless marketplace plugin from the Plugins page; its hooks or MCP servers run commands with their rights. | [ADR-0010](adr/0010-unreviewed-marketplace-plugins.md). Only the catalog's approved items are marked reviewed, and only when they're listed by Anthropic's marketplace (a marketplace someone adds can't borrow a review by reusing its name); every other row says "Not reviewed". An install takes a click on that plugin and a dialog that says it isn't reviewed and shows its source, as the marketplace lists it (repository, folder, commit). The default scope is local, so nothing reaches teammates unless the person picks project scope. Never auto-applied, pre-selected or part of a setup plan. Installs go through the CLI from the plugin's own marketplace, never with `-y`. A command the marketplace declares is shown, and passed with `--accept-command` only after a second confirmation. Each install is a History run whose Roll back uninstalls it; the lockfile records the source and version. After install, the CLI's inventory flags hooks and MCP servers as running code. Plugin options aren't collected, so no secret passes through the app. Ids are checked against `name@marketplace` before they reach the CLI, which gets them as arguments, not through a shell. | High for the person who installs one: an unreviewed plugin can do anything the user can. The app makes the choice visible and reversible, not safe. |
| T-19 | **Other agents' CLIs as step backends (M9, [ADR-0012](adr/0012-multi-agent-backends.md)):** Codex or agy runs a task step; a command they run would bypass the guard that sits in Claude's hook, their credentials sit in the user's home, and their cost comes as tokens. | **Codex (M9-04) and agy (M9-05) are built.** The user's own binaries, found like the Claude CLI and run without a shell, over stdio. Only their version and sign-in status commands are read, with an allowlist of fields; their credential folders (`.codex/`, the Antigravity CLI's) join the guard's secret list for every agent. **Codex** runs through `app-server`: each command and file change is checked by the guard before it's answered, then goes to the permission profile and approvals; read steps use its read-only sandbox. **agy** writes files but runs no commands: `accept-edits`, `--sandbox` and `toolPermission: request-review` through per-run `--settings`, never the user's own settings (S8 found per-run command rules don't hold); every path it wrote is checked against the guard afterwards and a breach fails the step; read steps also deny every write. Costs are token estimates counted against the step and task caps. Off unless a workflow step names the agent. | Medium: agy's writes are checked after the fact (R-20), and the vendors' terms are unsettled (R-19). |

## Tauri capabilities and IPC surface (R1-06)

**The main window's capability** (`capabilities/default.json`) grants:
- `core:event:default`;
- opener: `allow-open-url` plus the default http(s) and mailto URLs;
- dialog: `allow-open` and `allow-save`;
- `updater:default`, and `process:allow-restart`;
- for the window's own title bar on Windows and Linux (UX-15): `core:window` `allow-start-dragging`,
  `allow-internal-toggle-maximize`, `allow-minimize`, `allow-toggle-maximize`, `allow-is-maximized` and `allow-close`;
- `clipboard-manager:allow-read-text`, for the title bar's Edit → Paste only: the clipboard's text is read when the
  person picks Paste, and inserted where they were typing. Nothing writes to the clipboard through it, and nothing
  reads it otherwise.
- `notification:allow-is-permission-granted`, `allow-request-permission` and `allow-notify` (M8-05): OS notifications
  that a scheduled run needs an approval or ended. Permission is asked when the first schedule is saved. A
  notification carries the task's title, the tool's name or the run's outcome and cost, and nothing from files.

Nothing else. In particular, there is no file-system or shell plugin.

**The app's own commands, and how each validates its input:**

| Command | Input | Validation |
|---|---|---|
| `sidecar_send` | A JSON-RPC frame | The sidecar validates every frame against the protocol schema. |
| `open_in_editor` | Absolute file, line, editor | A local file that exists (no network or device paths). Editors come from an allowlist and get an argument array. "System default" is as T-03 says. |
| `pty_open` / `pty_write` | Folder, size, data | The user's own shell, in a folder the user opened. This is the terminal feature itself. |
| `open_terminal` | Folder | Must be a folder. On Windows it's passed as the working directory, never on cmd's command line. |
| `workspace_watch` | Folder | Watches only, without following links; emits change events. |
| `diagnostics_export` | Path | Only a `.json` file in an existing folder, chosen in a save dialog. |
| `settings_set` | Settings | Normalized on save; typed fields only. A new Claude CLI path must be an absolute path to an existing file. `language` keeps only a language the UI has (`id`). |
| `settings_get`, `app_info`, `updater_ready` | — | Read only. |
| `sidecar_restart` | — | Restarts the app's own runtime. |
| `workspace_unwatch` | Folder | Stops a watcher. |
| `pty_resize` / `pty_close` | Terminal id | Only terminals this window opened. |
| `cost_record` / `cost_sessions` / `cost_summary` | Typed numbers and ids | Local spend history, parameterized SQL. |
| `selftest_config` | — | Debug builds only: release builds ignore `AGENTCHAINER_SELFTEST`. |
| `pseudo_locale` | — | Debug builds only: release builds ignore `AGENTCHAINER_PSEUDO_LOCALE` (X-13). It only changes how the UI's own text is drawn. |
| `quit_app` | — | Quits the app. |
| `update_prepare` | — | Stops the runtime and terminals before an update installs. |
| `menu_select` | A menu item id | Runs the same item as the native menu (UX-15): an id the UI handles is sent back as a `menu` event, a Help id opens its fixed page, anything else is ignored. |

**The runtime itself:** release builds always run their own bundled sidecar, with no arguments (`AGENTCHAINER_SIDECAR_BIN` works in debug builds only). Debug builds also read their settings from `AGENTCHAINER_CONFIG_DIR` when it's set, and pass `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` on to their windows, so the end-to-end tests can open WebView2's debugging port on Windows (X-06). Release builds ignore it, so no environment variable can open a debugging port into an installed app. The core also passes `AGENTCHAINER_CLAUDE_PATH` (the CLI path setting) and `AGENTCHAINER_LANGUAGE` (the UI's language, `id` or unset, X-13), which only chooses the sidecar's message catalog. The sidecar reads `AGENTCHAINER_CODEX_PATH` and `AGENTCHAINER_AGY_PATH` (M9-04, M9-05): the Codex and Antigravity CLIs to run task steps that name `agent: codex` or `agent: agy` with, instead of the ones found on PATH; Settings gets a path for it with M9-06. It inherits the login shell's environment, because the user's CLI needs it for its own sign-in, provider settings (API key, Bedrock, Vertex) and proxy. Only JSON lines from its stdout reach the UI.

**Other surfaces, reviewed 2026-11-04:**
- **Agent drawer and replay (M4-03, M4-08):** subagent transcripts come from the SDK's session APIs (ADR-0004) and are shown with secrets masked. Nothing is written.
- **Session management:** `session.fork`, `delete`, `rename` and `tag` change the CLI's own session records through the SDK's functions only, from a person's click.
- **Metrics and evals (M7):** `metrics.summary` reads the workspace's task records locally. The eval harness and its CI check run in this repository's CI on fixture copies and make no calls from users' machines.
- **On-demand actionlint:** downloaded like any catalog tool, pinned and checked by sha256, into the app's tools folder.

**Sidecar methods that touch the file system or run commands:**
- the `workspace.*`, `git.*`, `bootstrap.*`, `task.*` and `agents.*` families;
- `github.status`, and `task.createPr`, which pushes and runs `gh` (T-12);
- `deploy.targets`, `deploy.preview` and `deploy.list` (M6): the provider's CLI on a task's worktree, and the smoke test (T-14);
- `task.mergeGates`, `task.reviewPr` and `task.mergePr` (M5-04, M5-05): scanners on the task's worktree, the reviewer on the PR's diff, and `gh pr merge` from a person's click (T-12);
- `task.prStatus`, `task.ciLog` and `task.fixCi` (M5-03), which read the PR's checks and logs through `gh`, and push
  a fix round that passed the gates (T-13).
- `session.start` and `session.rewind`.

Each takes a folder the user opened. Paths inside it go through `insideRoot`, and git paths are passed after `--`.

`session.stopAgent` (M4-05) neither touches files nor runs anything. It stops one task of a session this sidecar
started (`requireSession`), through the SDK's `stopTask`. It does nothing while no turn runs, unless the task is one of
the session's live background tasks (M4-07).

**The agent library (M4-06):**
- `agents.save` and `agents.delete` write only `.claude/agents/<name>.md`. The name is checked against
  `[a-z0-9-]` before it becomes a path, and the write goes through `insideRoot`.
- Each change is a recorded run, so it can be rolled back like a setup step.
- `agents.list` also reads the user's `~/.claude/agents/*.md` (or `CLAUDE_CONFIG_DIR`). It shows the agents' own
  text. The agents' prompts are instructions to Claude, which a malicious repository can supply (T-02); listing them
  doesn't run them.

**Agent profiles (M8-04):**
- **User-scope writes:** `agents.save` and `agents.delete` with `scope: "user"` write only
  `~/.claude/agents/<name>.md` (or `CLAUDE_CONFIG_DIR`).
  - The name is checked before it becomes a path.
  - The write goes through a temporary file, then a rename.
  - It's the person's click, after a confirm. It isn't a workspace run, so History can't roll it back, and the UI
    says so.
- **Checks before saving:** every save, in both scopes, runs `agentProblems` first:
  - only known built-in tools, and MCP entries of the form `mcp__server[__tool|__*]`;
  - a known model alias or a `claude-…` id;
  - non-empty fields within size.
- **Running a profile narrows a session; it never widens it:**
  - only its built-in tools are available (the SDK's `tools`);
  - a profile that names no MCP server gets none (`mcp__*` disallowed);
  - approvals, the guard hook and the permission mode still apply;
  - a read-only Team worker keeps only the profile's read tools and the read-only hook.
- **Limits:**
  - A profile that names some MCP entries keeps every MCP server the session has: the app can't list which servers
    the CLI loads before it starts, so the allowlist covers built-in tools exactly and MCP servers only as all or
    none.
  - A Team chat with a profile keeps its MCP tools, the app's own among them.
- **Workflow roles stay shipped:** task workflows still name only the 6 shipped `ac-*` roles; a profile can't stand in
  for one (T-03).
- **`agents.templates`** returns the shipped roles and 4 bundled starters, as data the form fills in from; nothing is
  written until the person saves.

**Lessons (M8-06):**
- **What runs:** `task.lessons` makes one model call with no tools and no settings, only on the person's click. It
  sends the finished run's recorded signals, the current CLAUDE.md and the dismissed lessons.
- **What crosses into CLAUDE.md:**
  - Run records can carry repository content and model text (T-02), so they reach CLAUDE.md only as lines the person
    reads and picks one by one, in a diff of the file.
  - `task.lessonsApply` writes only `CLAUDE.md` or `.claude/CLAUDE.md` in the workspace root, as a History run that
    can be rolled back.
  - It refuses a line with a home-folder path or a key or token shape, and a file over 300 lines.
- **Local data:** dismissed lessons are kept in `.agentchainer/lessons.json`, which git ignores.

**Background work (M4-07):**
- Interactive sessions let the CLI run subagents and shells in the background. They outlive the turn that started
  them, and the CLI starts a turn of its own when they end.
- They are bounded the same way as the turn:
  - they run under the same session, with its permission mode, approvals, guard hook and spend cap;
  - each one is listed above the composer with its own Stop;
  - closing the session or quitting the app ends them with the CLI process.
- Task steps, generators and triage keep background work off, so nothing they start outlives their turn.

**The Plugins page (UX-10, T-18):**
- The sidecar runs the user's `claude` as a child process, with arguments and no shell:
  - `plugin list [--available] --json` and `plugin marketplace list --json`, when the page opens or on Refresh;
  - `plugin details <id>` for an installed plugin;
  - `plugin install|update <id> --scope project|local --json [--accept-command <sha256>]`, and
    `plugin uninstall|enable|disable <id> --scope project|local --json`, each only on a click.
- **Input checks:**
  - `id` must match `name@marketplace` (`[\w.-]+@[\w.-]+`);
  - the scope is `project` or `local`. User-scope plugins are shown read-only;
  - `acceptCommand` is a 64-character hex sha256 that the CLI itself reported for that plugin.
- **What it writes:**
  - an install is a History run: a backup of the settings file the CLI edits, and a lockfile entry;
  - an uninstall puts that settings file back when nothing else changed it since.
- **What it doesn't do:** `plugin configure` is never run, so option values (possibly keys) never reach the app.

## Security review of 2026-10-29

**What was checked:**
- the capabilities, the commands above and the CSP, by hand;
- an automated audit of the repository, using the pinned `cloudflare-security-audit` skill with Sonnet;
- a hand search for HTML sinks, git argument handling, and Windows command-line handling.

The audit run stopped after 39 turns ($1.39) before it covered everything.

| Finding | Severity | Status |
|---|---|---|
| Rollback trusted paths in a workspace-supplied `run.json`, and could create or delete files outside the workspace. | Medium (audit) | **Fixed.** Run records are validated before use, and forged runs aren't listed. A regression test is in `apply.test.ts`. |
| CSP was `null`; with an XSS in the markdown view, that would allow code execution. | — (audit) | **Rejected as stated**, because the markdown view renders no raw HTML. Hardened anyway: a strict CSP now ships. |
| Open with the default app could run a program or script from an untrusted repo. | Medium (manual) | **Fixed.** See T-03. |
| `open_terminal` on Windows passed the folder through `cmd /C start`, so a name like `R&D` would be parsed as a command. | Low (manual) | **Fixed.** The folder is now the working directory. |

**Not reviewed by the audit, still to do:**
- `bootstrap/generate.ts`, `workspace-guard.ts`, `verify.ts` and `plan.ts`;
- `TranscriptView` and the setup pages;
- parts of the Rust core.

These are the first candidates for the next review.

## Security review of 2026-11-04

**What was checked:**
- what the 2026-10-29 audit didn't reach: `bootstrap/generate.ts`, `workspace-guard.ts`, `verify.ts`, `plan.ts`, `TranscriptView` and the setup pages (Plugins included), and the Rust core;
- the redaction of secrets (X-03), the capabilities and commands (X-02), and telemetry (X-04), across the code.

It was a read-only review by an agent; each finding was then checked against the code before it was fixed.

| Finding | Severity | Status |
|---|---|---|
| Secrets in tool output, gate tails and deploy details were shown as-is, and the app log and crash logs stored them; the TS and Rust redactions were two copies of 9 patterns. | Medium | **Fixed** (T-08). |
| Bootstrap reads and writes followed symbolic links out of the workspace (a fix, a role or a generated file could land in `~/.claude` or `~/.gitconfig`; a link to `/dev/zero` could hang a preview). | Medium | **Fixed** (T-03). |
| "Open in editor" with the system default could run a script through its file association (`.py` through Python Launcher or `py.exe`). | Medium | **Fixed** (T-03). |
| A read-only session's "inside the workspace" check was lexical: another drive or a UNC path on Windows, a symbolic link, and `~` passed it. | Medium | **Fixed** (T-03). |
| On Windows, `git` by name could run a `git.exe` committed to the repository (libuv looks in the child's folder first). | High if confirmed | **Fixed** without a Windows run to confirm it: git runs by its absolute path. |
| A file name like `*` or `[id]` was a git pattern in Revert and the guard's checkout. | Low | **Fixed** (`:(literal)` pathspecs). |
| On Linux the watcher followed links (`x -> /` would watch the whole disk). | Low | **Fixed.** |
| A marketplace someone added could reuse `claude-plugins-official` to borrow a review badge, if the CLI allows the name. | Info | **Fixed:** reviews need Anthropic's marketplace. |
| Release builds honoured `AGENTCHAINER_SIDECAR_BIN` and `AGENTCHAINER_SELFTEST`; the Claude CLI path setting took any text; the CSP had no `object-src`, `base-uri` or `form-action`. | Low | **Fixed** (X-02). |

**Not covered, for the next review:** the other setup pages beyond their sinks, `steps.ts` merge-json, `stop-hook.ts`, and a Windows run of the Windows findings.

## Next review

At the end of R1, or earlier when any of these lands:
- a new command or capability;
- a new kind of catalog item;
- code signing;
- a change to the update channel.
