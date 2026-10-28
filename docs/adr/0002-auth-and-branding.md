# ADR-0002: Authentication and branding — the user signs in with the official CLI; the app only detects and guides

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** project owner
- **Related:** [AUTH_SETUP guide](../guides/AUTH_SETUP.md), [RISKS R-01](../RISKS.md), checklist M0-01, M0-19, M1-03…M1-05

## Context

- AgentChainer is a **public open-source** app that runs Claude on the user's machine.
- The Agent SDK docs state:
  > "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits
  > for their products, including agents built on the Claude Agent SDK."
  > — https://code.claude.com/docs/en/agent-sdk/overview
- The official Claude Code CLI already supports every auth path a user might have: Pro/Max/Team/Enterprise login,
  Claude Console (API billing), API key env vars, Bedrock, Vertex and Foundry. It stores credentials itself (macOS Keychain,
  `~/.claude/.credentials.json` on Linux and Windows) and exposes `claude auth status --json` / `--text`.
- The same docs restrict branding. A third-party product must not be called "Claude Code" or look like it.
  "<Name> Powered by Claude" is allowed.

## Decision

1. **The app never offers, embeds, automates or proxies a login.** It contains no OAuth code, never reads or stores tokens
   or API keys, and never opens Anthropic's login pages on the user's behalf.
2. **The user authenticates manually in their own terminal** using the official CLI, by one of:
   - `claude auth login` (subscription; `--console` for API billing; `--sso` for orgs);
   - setting their own env vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1`, …).
3. **The app uses the user's installed `claude` binary.** The sidecar passes it to the SDK via
   `pathToClaudeCodeExecutable`, so sessions inherit whatever auth the user configured. We do **not** bundle a Claude binary.
4. **The app only detects state** (`claude --version`, `claude auth status --json`). When something is missing, it shows the
   [AUTH_SETUP](../guides/AUTH_SETUP.md) tutorial with OS-specific, copy-pasteable commands and a **Re-check** button.
5. **Branding:**
   - Product name "AgentChainer", tagline "Powered by Claude".
   - No "Claude Code" in the app name, icon or window title.
   - README states that the project is not affiliated with Anthropic.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| In-app login (OAuth) | Smoothest onboarding | Explicitly disallowed for third parties without approval | Policy |
| API key only, stored by the app in the OS keychain | Clearly allowed | Excludes subscription users; makes us a credential custodian | Narrower audience, more liability |
| Bundle the SDK's Claude binary | Version control over the CLI | Bigger downloads, more signing work; the user's login lives with their own install anyway | No benefit under this auth model |

## Consequences

- **Positive:**
  - No credential handling, so a smaller security surface and simpler privacy story.
  - All auth types the CLI supports work automatically.
  - Smaller bundles; no Claude binary to sign.
- **Negative:**
  - Onboarding has a manual step, so the tutorial must be excellent and tested on all 3 OS.
  - We depend on the user's CLI version, so the health check must enforce a minimum version and the compatibility matrix must be kept current.
  - On macOS and Linux, a GUI app does not inherit the shell's `PATH`/env, so the app must resolve the user's login-shell
    environment (see [ARCHITECTURE §3](../ARCHITECTURE.md#3-locating-claude-and-the-users-environment)).
  - Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page (read 2026-10-28)
    supports this design:
    > "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude
    > subscription, including where a platform hosts Claude Code…"
  - The same page sets conditions we must keep meeting:
    - run the Claude Code binary **unmodified**;
    - never remove, disable or restrict its built-in sign-in methods;
    - never pay for, resell or intermediate users' Claude usage;
    - never collect, store or intermediate Claude.ai credentials or session tokens. Sign-in completes through
      Anthropic's own flow.
  - The page also says developers building products with the Agent SDK "should use API key authentication". AgentChainer
    offers no login of its own; each user signs in to their own unmodified CLI. The remaining ambiguity is tracked as
    [R-01](../RISKS.md): monitor the docs and ask Anthropic (M0-22).
- **Revisit when:** Anthropic's policy or docs change, Anthropic contacts the project, or `claude auth status` output changes.

## References

- Authentication: https://code.claude.com/docs/en/authentication
- Setup: https://code.claude.com/docs/en/setup
- Agent SDK overview (policy and branding): https://code.claude.com/docs/en/agent-sdk/overview
- Legal and compliance (licensing, offering Claude Code in products, credential use, name and logo):
  https://code.claude.com/docs/en/legal-and-compliance
