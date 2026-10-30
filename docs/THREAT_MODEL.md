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
 └────────────┘        └─────┬─────┘  RPC  └──────┬───────┘       └────────────┘
                             │ updates            │ catalog downloads (pinned, hashed)
                             ▼                    ▼
                     GitHub Releases       GitHub, npm
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
| T-02 | **Prompt injection** makes the agent run destructive or exfiltrating commands (R-09). | Default permission mode asks before edits and commands. The approval dialog shows the full command, Claude's own explanation, an edit's diff, and a risk level from fixed rules (UX-05). "Always allow" defaults to this user's workspace file; sharing a rule with the team is an explicit choice. The guard hook denies known-destructive commands. Spend caps. Read-only generator sessions with a workspace guard (M2-19), and the same for drafting task contracts (M3). | Medium. The user can approve a bad command, and "auto" modes trust the model. This is inherent in agent tools. |
| T-03 | **A malicious repository** abuses the app's own features. | **Rollback:** rejects a forged `.agentchainer/backups/*/run.json` whose paths leave the workspace or the run folder (audit finding, fixed in this release). **Workspace paths:** must stay inside the folder (`insideRoot`). **Git:** arguments are passed after `--`, and branch names are checked. **Open with the default app:** refuses programs, scripts and executable files. **Hooks:** setup never runs upstream install scripts. **Task files (M3):** read back through zod; a task id is checked before it becomes part of a path, and a task folder that's a symlink or resolves outside the workspace is refused. | Low. The app treats project files as data. The agent reading them is T-02. |
| T-04 | **Catalog supply chain:** a compromised skill, plugin, MCP server or tool (R-08). | Pinned to a commit SHA, release asset or npm version, with sha256 or integrity hashes ([ADR-0005](adr/0005-catalog-trust-model.md)). A weekly CI job re-verifies every pin. Upstream updates arrive as PRs with reviews cleared, after a 14-day minimum age. Every install is shown before it happens, and consent is asked. | Medium. A reviewed version can still be malicious. MCP servers run with the user's rights. |
| T-05 | **IPC misuse:** a bad frame from the UI, or from another process. | The sidecar talks only over its own stdio. It has no network port. Every JSON-RPC request is validated against the zod schema in `packages/protocol`. Methods that take a folder check that it exists (`requireFolder`). Tauri capabilities allow only what the UI calls (see below). | Low. |
| T-06 | **Update hijack:** a forged `latest.json` or artifact. | The updater installs only artifacts signed with the update key built into the app. `requireSignedVersion` binds each signature to its version, which blocks downgrades. HTTPS to GitHub. Checks run only when the user asks ([ADR-0009](adr/0009-release-signing-and-updates.md)). | Low, if the key stays secret. Losing it strands users; leaking it lets an attacker who can also serve the manifest push updates. |
| T-07 | **Tampered installers** (unsigned in v0.1). | `SHA256SUMS` on every release, and checksum steps in [INSTALL.md](guides/INSTALL.md). | Medium. Anyone who can change the release page can change both the file and its checksum. Code signing is R1-03. |
| T-08 | **Secrets leak** through logs, diagnostics or the UI (X-03). | Diagnostics are redacted: home folder, API keys, tokens, passwords and emails. The app never reads or stores credentials. Raw SDK recordings are never committed (`make-fixture.ts`). | Medium. Redaction is pattern-based. The UI shows tool output as the agent saw it, including secrets the agent read. |
| T-09 | **Credential handling** by the app (R-01). | None by design: the user signs in to their own CLI in their own terminal ([ADR-0002](adr/0002-auth-and-branding.md)). | None known. |
| T-10 | **Build-time downloads outside our pinning.** | The Rust and npm dependencies are locked. CI actions are pinned by SHA. Release builds don't use the Rust cache. | Tauri's bundlers download linuxdeploy (AppImage), WiX and NSIS at build time. Their integrity depends on Tauri's own checks. |
| T-11 | **Runaway cost** (R-10). | A spend cap per session, visible running cost, and caps on generator turns and budget. | Low to medium. |

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
- the `workspace.*`, `git.*`, `bootstrap.*` and `task.*` families;
- `session.start` and `session.rewind`.

Each takes a folder the user opened. Paths inside it go through `insideRoot`, and git paths are passed after `--`.

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
