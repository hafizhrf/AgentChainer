# ADR-0010: Unreviewed marketplace plugins are listed and installable on request

- **Status:** Accepted (amends [ADR-0005](0005-catalog-trust-model.md))
- **Date:** 2026-11-04
- **Deciders:** hafizhrf (owner, accepted with the UX-10 plan), with Claude as implementer
- **Related:** UX-10, [ADR-0005](0005-catalog-trust-model.md), [ADR-0002](0002-auth-and-branding.md),
  [ADR-0007](0007-catalog-distribution.md), [RISKS R-08](../RISKS.md), [THREAT_MODEL T-18](../THREAT_MODEL.md)

## Context

The owner asked for a Plugins page like Android Studio's (UX-10, 2026-10-30). It needs:
- Marketplace and Installed tabs, with search;
- a detail page with vendor, version, license, permissions, risk, review status and a source link;
- per-workspace installs, and update notices.

It lists the reviewed catalog **and the whole official marketplace**, with unreviewed plugins clearly marked.

ADR-0005 offers only curated catalog items, and only after their reviews. The catalog has 8 approved plugins. The
user's CLI lists far more.

What the CLI offers, checked on Claude Code 2.1.293 (2026-11-04):
- **The listing:** `claude plugin list --available --json` lists 3,920 plugins in about 3 s.
  - 315 come from `claude-plugins-official` (`anthropics/claude-plugins-official`). 3,605 come from
    `anthropic-plugin-directory`, a directory built into the CLI.
  - Each has an id, name, description, version (most of them), install count (some) and source.
  - Every external source names a commit SHA. Plugins kept inside the marketplace repository give only a folder.
- **Installed plugins:** `claude plugin list --json` gives id, version, scope, enabled, and the project for project
  and local installs.
- **Details:** `claude plugin details <id>` lists a plugin's skills, agents, hooks, MCP and LSP servers, and projected
  tokens. It has text output only, and works only for installed plugins.
- **Changes:**
  - `install`, `update`, `uninstall`, `enable` and `disable` take `--scope` and `--json`.
  - A command a marketplace declares (a command-source install, or the helper that fetches an archive) needs a person's
    confirmation, passed as `--accept-command <sha256>`.
  - The CLI can't pin a plugin to a version (spike S6).

## Decision

**The Plugins page lists every plugin the user's CLI reports, marks which ones AgentChainer reviewed, and installs any
of them on an explicit, per-plugin request.**

1. **Listing:**
   - The data is the CLI's JSON output only. The app doesn't read the CLI's cache or settings files to build it.
   - Listed: Anthropic's marketplaces (`claude-plugins-official` from the `anthropics` org, and the built-in
     `anthropic-plugin-directory`), plus any marketplace the user added themselves, labelled "added by you".
2. **Review status, always visible:**
   - "Reviewed" means a catalog item with its tier's required reviews (ADR-0005). It shows the tier, the reviews, the
     reviewed version, the license, the permissions and the risk.
   - Everything else is "Not reviewed", including catalog items still waiting for reviews. "Not reviewed" uses the
     warning style, not the community tier's red, because nearly every row has it.
3. **Installing an unreviewed plugin:**
   - It takes a click on that plugin, and a dialog that says it isn't reviewed and names its source as the marketplace
     lists it: the repository, folder and commit.
   - It's never auto-applied, never pre-selected, and never part of a setup plan or profile.
   - The default scope is **local**: just this user, in `.claude/settings.local.json`, not committed. Project scope,
     shared with the team, is a choice in the same dialog. Reviewed plugins default to project scope, as in ADR-0005.
4. **Installs stay the CLI's, and stay reversible:**
   - Installs run `claude plugin install <id> --scope <scope>` from the plugin's own marketplace, never with `-y`.
   - A declared command is shown to the person, and passed with `--accept-command` only after they confirm it.
   - Each install is a run in History, whose Roll back uninstalls it.
   - The lockfile records each install:
     - reviewed plugins like setup steps;
     - unreviewed ones with `tier: "unreviewed"`, the listed source, and the version the CLI installed (it can't
       pin, S6).
   - Uninstall, update and turn off/on run the matching CLI commands. They update the lockfile entry.
5. **No secrets through the app (ADR-0002):**
   - Plugin options aren't collected, and `claude plugin configure` isn't run: it could print option values.
   - The page tells the user to set options with `claude plugin configure <id>` in a terminal.
6. **Updates are notices:**
   - An installed plugin with a newer listed version shows "Update to X".
   - Update runs `claude plugin update` only on that click. Nothing updates by itself (ADR-0005 §8).
   - For a reviewed plugin, a version other than the reviewed one says so.
7. **Network:** the CLI refreshes its marketplace listings when the Plugins page opens and when the user clicks
   Refresh, and at no other time. The listing is kept for the app session.

ADR-0005 still governs the catalog, setup plans and auto-apply. This ADR adds a second, user-driven path next to it.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Catalog only (ADR-0005 as is) | Every install reviewed | 8 plugins; the owner asked for the marketplace | Doesn't meet UX-10 |
| List all, install only reviewed | No unreviewed installs | Users would install from a terminal anyway, with no record and no rollback | Less safe in practice |
| Read the CLI's cache files for richer data (categories, authors) | More metadata | Internal format; ADR-0004's spirit (use the public interface) | The JSON output is enough |
| Inspect a plugin before install by fetching its source | Inventory and license up front | Downloads untrusted code into the app; a second fetch path next to the CLI's | Later, if users ask; the source link covers it |
| Collect plugin options in the app | One place to configure | Options can be API keys; ADR-0002 forbids handling them | Terminal command instead |

## Consequences

- **Positive:**
  - The whole marketplace is one search away, with the review status always visible.
  - Installs from the app are recorded and can be rolled back, unlike installs from a terminal.
- **Negative:**
  - AgentChainer now helps install code it never reviewed. Mitigations: the explicit dialog, local scope by default,
    the visible source pin, and History. The residual risk is in THREAT_MODEL T-18.
  - The details parser reads text output and may break when the CLI changes it. The raw text is always shown, so a
    format change shows text instead of wrong counts.
  - Opening the page runs the CLI's own network refresh of its marketplaces (PRIVACY.md).
- **Revisit when:**
  - the CLI ships pinned or signed plugin installs, or JSON for `details`;
  - Anthropic publishes review metadata per plugin;
  - users ask for pre-install inspection.

## References

- Plugins CLI: https://code.claude.com/docs/en/plugins/cli-reference **(verify)** for `--available` and
  `--accept-command`, which were read from the installed CLI's help.
- Spike S6, plugin installs: [S4-S5-S6.md](../spikes/S4-S5-S6.md).
- UX-10 in [CHECKLIST.md](../CHECKLIST.md).
