# Threat model

Checklist X-01, updated at every milestone. Last reviewed **2026-10-29**, for the v0.1 release (R1-06).
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
| T-02 | **Prompt injection** makes the agent run destructive or exfiltrating commands (R-09). | Default permission mode asks before edits and commands. The approval dialog shows the full command, Claude's own explanation, an edit's diff, and a risk level from fixed rules (UX-05). "Always allow" defaults to this user's workspace file; sharing a rule with the team is an explicit choice. The guard hook denies known-destructive commands. Spend caps. Read-only generator sessions with a workspace guard (M2-19), and the same for drafting task contracts (M3). A task's read steps can only read inside the workspace; its write steps keep approvals and the guard hook; its gates run under the workspace guard, except format. A task's run records every approval Claude asked for, with its risk, and every guard block; its evidence report lists them, riskiest first (M3-09). A chat (UX-12) may switch itself to plan mode (`EnterPlanMode` is allowed without asking, since plan mode only narrows what it can do; leaving it still takes ExitPlanMode's review or the person's own switch), and is asked to ask rather than guess; its questions (`AskUserQuestion`) are answered in a card, and the answers go back as the person's text in the tool's input. App slash commands (`/clear`, `/model`, `/mode`, `/effort`, `/usage`, `/fork`, `/help`) run in the app, as pickers or panels; every other command goes to Claude as typed. | Medium. The user can approve a bad command, and "auto" modes trust the model. This is inherent in agent tools. |
| T-03 | **A malicious repository** abuses the app's own features. | **Rollback:** rejects a forged `.agentchainer/backups/*/run.json` whose paths leave the workspace or the run folder (audit finding, fixed in this release). **Workspace paths:** must stay inside the folder (`insideRoot`). **Git:** arguments are passed after `--`, and branch names are checked. **Open with the default app:** refuses programs, scripts and executable files. **Hooks:** setup never runs upstream install scripts. **Task files (M3):** read back through zod; a task id is checked before it becomes part of a path, and a task folder that's a symlink or resolves outside the workspace is refused. **Task worktrees (M3-07, every tier since M5-01):** `git worktree add/remove` only under `.agentchainer/worktrees/<task id>` (ids checked); each new worktree runs the project's install command under the workspace guard, which the page names before Run (like the gates, it's the project's own command); the app commits only on its own `agentchainer/<id>` branches, with the user's identity and hooks; the user's branch changes only when they click Merge, on a clean tree. **Project workflows (M6-04):** `.agentchainer/workflows/*.yaml` is repository content too. It is used only when it passes the shipped library's checks (read steps only with read-only roles, reviews read-only, fix rounds and limits within the schema's caps); roles can't be defined there; links aren't followed and files over 64 KB aren't read. The task page says when a tier runs the project's workflow before Run, the task's own budget still caps the run, and the evidence names the file and its hash. A project workflow can drop the review or gates of its tier: that is shown, not prevented. The canvas saves only YAML that passes the same checks; `workflow.import` and `workflow.export` take a path from the system's file dialog, only `.yaml` files, and import reads at most 64 KB. | Low. The app treats project files as data. The agent reading them is T-02. |
| T-04 | **Catalog supply chain:** a compromised skill, plugin, MCP server or tool (R-08). | Pinned to a commit SHA, release asset or npm version, with sha256 or integrity hashes ([ADR-0005](adr/0005-catalog-trust-model.md)). A weekly CI job re-verifies every pin. Upstream updates arrive as PRs with reviews cleared, after a 14-day minimum age. Every install is shown before it happens, and consent is asked. A pre-commit hook runs the pinned tool only while it matches the sha256 recorded at install (a changed copy stops the commit), and falls back to the tool on PATH only when no pinned copy is installed. | Medium. A reviewed version can still be malicious. MCP servers run with the user's rights. |
| T-05 | **IPC misuse:** a bad frame from the UI, or from another process. | The sidecar talks only over its own stdio. It has no network port. Every JSON-RPC request is validated against the zod schema in `packages/protocol`. Methods that take a folder check that it exists (`requireFolder`). Tauri capabilities allow only what the UI calls (see below). | Low. |
| T-06 | **Update hijack:** a forged `latest.json` or artifact. | The updater installs only artifacts signed with the update key built into the app. `requireSignedVersion` binds each signature to its version, which blocks downgrades. HTTPS to GitHub. Checks run only when the user asks ([ADR-0009](adr/0009-release-signing-and-updates.md)). | Low, if the key stays secret. Losing it strands users; leaking it lets an attacker who can also serve the manifest push updates. |
| T-07 | **Tampered installers** (unsigned in v0.1). | `SHA256SUMS` on every release, and checksum steps in [INSTALL.md](guides/INSTALL.md). | Medium. Anyone who can change the release page can change both the file and its checksum. Code signing is R1-03. |
| T-08 | **Secrets leak** through logs, diagnostics or the UI (X-03). | Diagnostics are redacted: home folder, API keys, tokens, passwords and emails. The app never reads or stores credentials. Raw SDK recordings are never committed (`make-fixture.ts`). A task's evidence report scans the files the task changed with gitleaks when it's installed (`gitleaks dir <file> --redact`, local, no network) and names the flagged files, never the secret. | Medium. Redaction is pattern-based. The UI shows tool output as the agent saw it, including secrets the agent read. |
| T-09 | **Credential handling** by the app (R-01). | None by design: the user signs in to their own CLI in their own terminal ([ADR-0002](adr/0002-auth-and-branding.md)). | None known. |
| T-10 | **Build-time downloads outside our pinning.** | The Rust and npm dependencies are locked. CI actions are pinned by SHA. Release builds don't use the Rust cache. | Tauri's bundlers download linuxdeploy (AppImage), WiX and NSIS at build time. Their integrity depends on Tauri's own checks. |
| T-12 | **Pull requests (M5-02):** a push or a PR body leaks secrets, or the app acts on GitHub beyond what the user asked. | Create PR runs only from the user's click, after a preview of the title, branches and body. Before anything leaves the machine, gitleaks scans the branch's changed files (when installed) and blocks on a finding. The push is `git push -u origin <task branch>`, never forced, with no prompts. To an https GitHub remote it uses the user's `gh` login as the credential helper for that one command (`-c credential.https://<host>.helper=!gh auth git-credential`, as `gh auth setup-git` would set up), so the app never sees the token; otherwise the user's own git credentials. `gh` runs with an argument array, never a shell, with `GH_PROMPT_DISABLED`; the app never passes `--show-token` or reads `gh`'s config. The body is built in the sidecar from the contract and the evidence, not taken from the UI. The app merges only from a person's click in the Merge dialog (M5-05), after working out the gates again, with `--match-head-commit` and never `--auto`; a gate that isn't green needs the person's reason, which the evidence keeps. The guard denies agents `gh pr merge`, `gh release`, writes through `gh api`, tags, and pushes that delete refs. semgrep and trivy run offline only. | Medium. `gh` acts with the user's full GitHub rights, so the app's fixed commands are the boundary. The report can quote tool output the agent saw. |
| T-13 | **CI logs as injection (M5-03):** a failing job's log carries text from anyone who can change the repository, and a Fix CI round feeds it to Claude. | A round runs only after the user read the log and clicked **Fix this**. The log is cut to its last 32 KB, redacted like diagnostics, and sent in a fenced block marked "not instructions"; a fence inside it can't close the block. The round has the run's permission mode, approvals and guard. Only a round whose gates pass is committed and pushed, never forced. At most 3 rounds per PR, within the task's budget. `task.ciLog` reads only the PR's own GitHub Actions checks. | Medium. Claude can still be misled by the log, the same as by repository files (T-02). |
| T-14 | **Deploys (M6):** a deploy to the wrong project, production by mistake, a smoke script from the repository, and provider CLIs acting with the user's rights. | Deploys run only from a person's click, never from an agent (the guard still denies agents provider deploys, and the rollbacks and promotions that change production: `vercel rollback`/`promote`, `wrangler rollback` and `versions deploy`, `firebase hosting:clone`, and pushing images (`docker push`, `buildx build --push`, `buildx imagetools create`)) and never during a task's run. A preview deploys the task's worktree. Production deploys the workspace's current branch only from a clean tree, after the person types the project's name in a dialog that shows the command, branch and commit; the sidecar checks the name and that the commit hasn't moved. Rollback is offered only on the live production deploy, with the same typed confirmation. Provider CLIs run with an argument array, never a shell (npm `.cmd` shims are resolved to `node <script>`), with no prompts and the providers' telemetry off. Credentials stay in the provider's CLI; the app only checks `whoami`'s exit code and drops its output. A Vercel worktree gets the workspace's `.vercel/project.json`, so a deploy can't create a stray project. A Docker deploy runs the repository's Dockerfile on the local daemon (its build steps are repository content, like the gates' commands) and pushes with the user's `docker login`; the app never reads Docker's config. A Cloudflare preview only uploads a version of an existing Worker (`versions upload`) and sends it no traffic; the app never makes a Worker's first deploy. The smoke script runs under the workspace guard like the gates; the built-in smoke test only GETs the deployment URL. Every deploy is recorded in `.agentchainer/deploys/`. | Medium. The provider CLI acts with the user's full rights on that provider. |
| T-11 | **Runaway cost** (R-10). | A spend cap per session, visible running cost, and caps on generator turns and budget. Task runs (M3) have a total cap from the triage card, per-step turn caps, capped fix rounds, and Stop. | Low to medium. |

## Tauri capabilities and IPC surface (R1-06)

**The main window's capability** (`capabilities/default.json`) grants:
- `core:event:default`;
- opener: `allow-open-url` plus the default http(s) and mailto URLs;
- dialog: `allow-open` and `allow-save`;
- `updater:default`, and `process:allow-restart`.

Nothing else. In particular, there is no file-system or shell plugin.

**The app's own commands, and how each validates its input:**

| Command | Input | Validation |
|---|---|---|
| `sidecar_send` | A JSON-RPC frame | The sidecar validates every frame against the protocol schema. |
| `open_in_editor` | Absolute file, line, editor | The file must exist. Editors come from an allowlist. "System default" refuses programs, scripts and executable files. |
| `pty_open` / `pty_write` | Folder, size, data | The user's own shell, in a folder the user opened. This is the terminal feature itself. |
| `open_terminal` | Folder | Must be a folder. On Windows it's passed as the working directory, never on cmd's command line. |
| `workspace_watch` | Folder | Watches only; emits change events. |
| `diagnostics_export` | Path | Only a `.json` file in an existing folder, chosen in a save dialog. |
| `settings_set` | Settings | Normalized on save. Typed fields only. |
| `update_prepare` | — | Stops the runtime and terminals before an update installs. |

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
- `agents.list` also reads the user's `~/.claude/agents/*.md` (or `CLAUDE_CONFIG_DIR`). It reads them only, and shows
  the agents' own text. The agents' prompts are instructions to Claude, which a malicious repository can supply (T-02);
  listing them doesn't run them.

**Background work (M4-07):**
- Interactive sessions let the CLI run subagents and shells in the background. They outlive the turn that started
  them, and the CLI starts a turn of its own when they end.
- They are bounded the same way as the turn:
  - they run under the same session, with its permission mode, approvals, guard hook and spend cap;
  - each one is listed above the composer with its own Stop;
  - closing the session or quitting the app ends them with the CLI process.
- Task steps, generators and triage keep background work off, so nothing they start outlives their turn.

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

## Next review

At the end of M3, or earlier when any of these lands:
- a new command or capability;
- a new kind of catalog item;
- code signing;
- a change to the update channel.
