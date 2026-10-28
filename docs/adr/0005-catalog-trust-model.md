# ADR-0005: Catalog trust model — pinned, hashed, previewed, reversible

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** project owner
- **Related:** [CATALOG.md](../CATALOG.md), [RISKS R-08](../RISKS.md), checklist M2-01…M2-18

## Context

Workspace bootstrap installs third-party **skills, plugins, MCP servers, hooks and tools**. All of these are code that
the agent (and sometimes the user's shell) will execute. Some upstream installers are invasive. For example, the
codebase-memory-mcp installer edits `~/.claude.json` globally and adds hooks and agents, and several tools document
`curl | bash` installs. A compromised or careless upstream update would reach every AgentChainer user.

## Decision

1. **Curated catalog in this repo** (`catalog/items/*.yaml`, `catalog/profiles/*.yaml`), validated by a JSON Schema in CI.
2. **Pinning:**
   - Every source is pinned to an immutable ref (commit SHA, or a release asset with its sha256).
   - Branches and floating tags are never used.
   - The installer verifies the hash before use.
3. **Trust tiers:**
   - `first-party`: AgentChainer's own skills.
   - `official`: published by Anthropic.
   - `verified-vendor`: published by the tool's own vendor, e.g. Cloudflare, Microsoft, GitHub, Upstash.
   - `community`: everything else; requires two maintainer reviews and is **never auto-applied**.
4. **Preview before apply:**
   - Every action shows what it writes or runs, what permissions the item needs, and its license.
   - Auto-apply is an opt-in setting and only covers `first-party` and `official` items.
5. **We run installs ourselves:**
   - Upstream install scripts are not executed.
   - Binaries go into an app-managed directory with checksum verification.
   - Plugins use the official `claude plugin install` CLI.
6. **Scope:**
   - Project scope is the default.
   - MCP servers whose command isn't portable are registered with `--scope local` (private, not committed).
   - Secrets are referenced as env vars and never written to repo files.
7. **Lockfile and rollback:**
   - `.agentchainer/lock.json` records every applied action (source, ref, hash, files touched).
   - Rollback restores files byte-for-byte.
8. **Updates are pull requests:**
   - A scheduled bot opens PRs that bump refs and hashes, with an upstream diff summary.
   - The app never silently updates an installed item.

## Consequences

- **Positive:** reproducible, auditable setups; supply-chain risk is bounded to reviewed SHAs; users can always undo.
- **Negative:**
  - Ongoing maintenance: reviews and update PRs.
  - Some items lag upstream.
  - Plugin version pinning through the marketplace CLI may be limited (verify in spike S6). Where it is, the lockfile
    records the installed version and the update is surfaced for review.
- **Revisit when:** Anthropic ships signed or pinned plugin installs we can rely on, or the catalog grows beyond what maintainers can review.

## References

- Plugins CLI: https://code.claude.com/docs/en/plugins/cli-reference
- Skills: https://code.claude.com/docs/en/skills
