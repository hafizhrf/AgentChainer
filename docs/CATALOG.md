# AgentChainer — Essentials Catalog

> The curated list of skills, plugins, MCP servers, hooks and tools that workspace bootstrap can recommend and install.
> The trust rules are fixed in [ADR-0005](adr/0005-catalog-trust-model.md). Items marked **(verify)** must be confirmed
> before they are added to `catalog/items/`.

## 1. Purpose

Users shouldn't have to know that a security-audit skill, a code-graph MCP or an LSP plugin exists. The catalog encodes
that knowledge: **what** to install, **when** it's relevant (detection signals), **how** to install and uninstall it
safely, and **why** it's worth it. The catalog lives in `catalog/` as data, so it can be reviewed like code.

## 2. Trust tiers

| Tier | Who publishes | Review required | Auto-apply allowed |
|---|---|---|---|
| `first-party` | This repo (`skills/ac-*`, templates) | Normal PR review | Yes (opt-in) |
| `official` | Anthropic (e.g. `claude-plugins-official` internal plugins, `anthropics/skills`) | 1 maintainer | Yes (opt-in) |
| `verified-vendor` | The vendor of the tool (Cloudflare, Microsoft, GitHub, Upstash, …) | 1 maintainer | No |
| `community` | Anyone else | 2 maintainers | No; never pre-selected |

Auto-apply is a setting, off by default (M2-18). When it's on, before a new session the app applies, without a
preview:
- recommended, pre-selected first-party and official items that have their reviews;
- the fixes that only add lines: env rules in `.gitignore`, and importing AGENTS.md.

It never applies generators (they cost model calls), fixes that change git state (untracking `.env`, `git init`), or
`verified-vendor` and `community` items. The session's first notices list what was applied; Workspace setup → History
rolls it back.

## 3. Item schema

Each item is one YAML file in `catalog/items/`, named `<id>.yaml`, and validated in CI.
- The schemas are zod, in `packages/sidecar/src/catalog/schema.ts`.
- `catalog/schema.json` is their JSON Schema export, for editors.
- `node packages/sidecar/scripts/build-catalog.ts` validates `catalog/` and compiles it into the snapshot the app ships
  ([ADR-0007](adr/0007-catalog-distribution.md)). A test fails while the compiled files are stale.

Annotated examples:

```yaml
# catalog/items/cloudflare-security-audit.yaml
id: cloudflare-security-audit
name: Security Audit (Cloudflare)
kind: skill                  # skill | plugin | mcp | hook | agent | tool
tier: verified-vendor
license: MIT
homepage: https://github.com/cloudflare/security-audit-skill
summary: Six-phase security audit producing machine-readable findings.json.
why: >-
  Finds real vulnerabilities with validation steps instead of generic advice.
  Heavy: run on demand before releases, not on every change.
source:
  type: git
  repo: https://github.com/cloudflare/security-audit-skill
  ref: "<40-char commit SHA>"          # never a branch or tag
  path: skills/security-audit
  sha256: "<hash of the normalized tree at path>"
platforms: [darwin, linux, win32]
requires:
  - { tool: node, version: ">=18" }
detect: {}                   # empty = recommended only via the profiles that include it
risk: medium                 # low | medium | high — shown in the preview
permissions:                 # plain-language list shown in the preview
  - Spawns multiple subagents
  - Runs the project's build/test commands while validating findings
install:
  scope: project             # project | user | local
  steps:
    - copy: { from: ".", to: ".claude/skills/security-audit" }
uninstall:
  steps:
    - remove: ".claude/skills/security-audit"
```

```yaml
# catalog/items/code-review.yaml
id: code-review
name: Code Review (official plugin)
kind: plugin
tier: official
license: "see plugin"        # per-plugin license recorded at review time
source:
  type: marketplace
  marketplace: claude-plugins-official
  repo: anthropics/claude-plugins-official
  plugin: code-review
  version: "<version reviewed, e.g. 1.0.1>"   # the CLI can't pin (spike S6): install takes the current entry,
                                              # and the lockfile records `plugin list --json` → version
install:
  scope: project
  steps:
    - run: [claude, plugin, marketplace, add, anthropics/claude-plugins-official]
    - run: [claude, plugin, install, "code-review@claude-plugins-official", --scope, project, -y, --json]
uninstall:
  steps:
    - run: [claude, plugin, uninstall, "code-review@claude-plugins-official", --scope, project]
```

```yaml
# catalog/items/codebase-memory-mcp.yaml (excerpt)
id: codebase-memory-mcp
kind: mcp
tier: community
license: MIT
source:
  type: release-asset
  repo: https://github.com/DeusData/codebase-memory-mcp
  version: "0.11.0"
  assets:                    # per platform, each with sha256 (CI re-downloads them and checks GitHub's digest too)
    darwin-arm64: { url: "<asset url>", sha256: "<hash>" }
    linux-x64:   { url: "<asset url>", sha256: "<hash>" }
    win32-x64:   { url: "<asset url>", sha256: "<hash>" }
install:
  scope: local               # binary path isn't portable → private per-project registration
  steps:
    - download-binary: { binary: codebase-memory-mcp }        # the app picks the folder, never the item
    - mcp-add: { name: codebase-memory, command: ["{binary}"] } # claude mcp add --scope local codebase-memory -- <binary>
notes: >-
  Do NOT run the upstream installer: it edits ~/.claude.json globally and adds hooks/agents/skills.
```

Release binaries are downloaded into AgentChainer's tools folder (`<app data>/tools/<item>/<version>/`), checked
against the pinned sha256 before anything is unpacked, and unpacked with the system `tar`. The folder is a cache
shared by workspaces, so rollbacks leave binaries there.

**Field reference:**

| Field | Required | Notes |
|---|---|---|
| `id`, `name`, `kind`, `tier`, `license`, `summary`, `why` | yes | `why` is shown to users in plain language |
| `source` | yes | `git` (repo + SHA + path + sha256), `marketplace` (plugin), `release-asset` (per-platform URL + sha256), `npm` (name + exact version + integrity) |
| `platforms`, `requires` | yes | Unmet requirements make the item unavailable, with an explanation |
| `detect` | no | Signals: files (`package.json`, `pubspec.yaml`), dependencies (`next`, `django`), git remote host, etc. |
| `risk`, `permissions` | yes | Shown in the review UI |
| `install` | yes | Declarative steps only: `copy`, `remove`, `run` (argv array, no shell), `download-binary` (`{binary}`), `mcp-add` (`{name, command}`, registered with the item's scope), `pre-commit-hook` (`{id, run}`, see below), `merge-json`, `write-file`. In an argv, `{binary}` is the downloaded binary |
| `uninstall` | no | What removing the item takes, for reviewers. Rollback restores files from backups and undoes the CLI registrations it made, so items that only write files or download a tool leave it out |
| `secrets` | no | Env var names the item needs (e.g. `GITHUB_TOKEN`). The installer references them and never writes values to files |
| `reviews` | no | `{by, date, ref, notes}` per maintainer review against §4. An item is offered only once its tier's count is met: first-party 0, official 1, verified-vendor 1, community 2. Until then the plan shows it as "not reviewed yet" |
| `notes` | no | Caveats for reviewers and users, shown in the plan |

`pre-commit-hook` goes through the repo's hook manager when it has one (`lefthook.yml`, `.pre-commit-config.yaml`,
`.husky/`): the config gets a command that runs a committed wrapper, `.agentchainer/hooks/<id>.sh`. The wrapper uses the
tool from PATH or AgentChainer's copy, and lets the commit through with a hint when neither exists, so teammates
without it aren't blocked. Without a hook manager, a local `.git/hooks/pre-commit` (this machine only) runs the app's
binary; an existing hook is never overwritten.

CI-checked rules beyond the schema: a release-asset item has exactly one `download-binary`; `{binary}` needs a
release asset; an MCP server that runs a downloaded binary uses `local` scope; npm steps run the pinned version; any
`${VAR}` in steps is one of the item's `secrets`.

Marketplace plugins can't be pinned by the CLI (spike S6). Their `source` records the version that was reviewed
(`reviewedVersion`) and the marketplace commit it was read at (`reviewedRef`).

## 4. Review checklist (adding or updating an item)

- [ ] License is compatible with recommending it, and redistribution terms are respected (we copy files into user repos).
- [ ] Source is pinned to an immutable ref, and the hash is computed by CI, not by hand.
- [ ] Every file at the pinned ref was read: SKILL.md, scripts, hooks, MCP command. No undisclosed network calls or telemetry.
- [ ] `permissions` and `risk` accurately describe what the item can do.
- [ ] Install and uninstall were tested on macOS, Windows and Ubuntu, and uninstall leaves no residue.
- [ ] `why` is written for a non-expert.
- [ ] For updates: the upstream diff between the old and new ref is summarized in the PR.

## 5. Profiles

Profiles group items. The detector picks profiles; the user can add or remove items.

| Profile | When suggested | Items |
|---|---|---|
| `baseline` | Every workspace | AgentChainer first-party skills (`ac-*`), `code-review`, `commit-commands` (official plugins), `gitleaks` pre-commit hook. `security-guidance` left it after the [2026-10-30 review](catalog-reviews/2026-10-30.md) |
| `ts-node` | Node stack | `typescript-lsp` (needs `typescript-language-server`) |
| `python` | Python stack | `pyright-lsp` (needs `pyright-langserver`) |
| `go` | Go stack | `gopls-lsp` (needs `gopls`) |
| `rust` | Rust stack | `rust-analyzer-lsp` (needs `rust-analyzer`) |
| `flutter` | `pubspec.yaml` | None yet: the official marketplace has no Dart/Flutter LSP plugin (checked at `f8c5e7a`). `firebase` if Firebase config is detected **(later)** |
| `github` | Git remote on github.com, including SSH host aliases such as `github-personal.com` | `github` plugin (reads `GITHUB_PERSONAL_ACCESS_TOKEN` from your environment) |
| `knowledge` (opt-in) | On request | `context7`, `codebase-memory-mcp` |
| `web-testing` (opt-in) | On request | `playwright-mcp` (pinned; the `playwright` plugin runs `@latest`) |
| `security` (opt-in) | Before release, or on request | `cloudflare-security-audit`, `semgrep` (CLI), `trivy` (CLI) **(later: needs the hashing installer)** |

Profiles live in `catalog/profiles/<id>.yaml` with `suggest: {always | stacks | remoteHost | optIn}`.

## 6. Seed items

| ID | Kind | Tier | License | Install method | Status |
|---|---|---|---|---|---|
| `ac-write-claude-md`, `ac-setup-hooks`, `ac-scaffold-tests`, `ac-generate-ci`, `ac-smoke-test` | skill | first-party | Apache-2.0 | Copied from `skills/` | To build (M2-19) |
| `code-review` (1.0.1) | plugin | official | Apache-2.0 | `claude plugin install code-review@claude-plugins-official --scope project` | Reviewed ([2026-10-30 review](catalog-reviews/2026-10-30.md)) |
| `security-guidance` (2.0.17) | plugin | official | Apache-2.0 | same pattern | **Not approved**: its hooks pip-install an unpinned SDK at runtime |
| `commit-commands` (1.0.1) | plugin | official | Apache-2.0 | same pattern | Reviewed |
| `typescript-lsp`, `pyright-lsp`, `gopls-lsp`, `rust-analyzer-lsp` (1.0.0) | plugin | official | Apache-2.0 | same pattern; each needs its language server on PATH | Reviewed |
| `context7` | plugin | verified-vendor | Apache-2.0 (plugin files); hosted service under Context7's terms | Partner plugin: the hosted MCP at `mcp.context7.com`, may ask you to sign in | Reviewed |
| `playwright` | plugin | verified-vendor | Apache-2.0 | Partner plugin. **It runs `npx @playwright/mcp@latest`, which is unpinned**, so the profile uses `playwright-mcp` | **Not approved**; in no profile |
| `playwright-mcp` (0.0.83) | mcp | verified-vendor | Apache-2.0 | `npx -y @playwright/mcp@0.0.83 --isolated` merged into the project's `.mcp.json` | Reviewed |
| `github` | plugin | verified-vendor | Apache-2.0 (plugin files); GitHub's hosted server (source MIT) | Partner plugin: the remote MCP `api.githubcopilot.com` with `GITHUB_PERSONAL_ACCESS_TOKEN` from your environment | Reviewed |
| `firebase` | plugin | verified-vendor | per plugin | Partner plugin | Seed **(verify)** |
| `cloudflare-security-audit` | skill | verified-vendor | MIT | Copy `skills/security-audit/` at a pinned SHA | **Not approved yet**: the MIT notice isn't copied (M2-29) |
| `codebase-memory-mcp` (0.11.0) | mcp | community | MIT | Pinned release binary + `claude mcp add --scope local` | **Not approved at 0.11.0**: re-pin to 0.12.1 (M2-32), then 2 reviews |
| `anthropic-example-skills` | plugin | official | Apache-2.0 (subset) | `example-skills@anthropic-agent-skills` | Optional; exclude source-available document skills |
| `gitleaks` (8.30.1) | hook | verified-vendor | MIT | Pinned release binary; pre-commit hook via the repo's hook manager, or a local hook | Reviewed |
| `actionlint` (1.7.12) | tool | verified-vendor | MIT | Pinned release binary. The verifier downloads it on demand to check generated workflows (AgentChainer's own tool, like the Agent SDK); not offered as an install | Reviewed |
| `semgrep` | tool | verified-vendor | LGPL-2.1 (CLI) **(verify)** | Pinned CLI; CI gate / on-demand scan | Optional **(verify no-login usage)** |
| `trivy` | tool | verified-vendor | Apache-2.0 | Pinned CLI; CI gate for deps/containers | Optional |

Sources: [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) ·
[DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) ·
[Discover plugins](https://code.claude.com/docs/en/discover-plugins) · [anthropics/skills](https://github.com/anthropics/skills) ·
[upstash/context7](https://github.com/upstash/context7) · [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) ·
[github/github-mcp-server](https://github.com/github/github-mcp-server)

## 7. Lockfile

`.agentchainer/lock.json` is committed by default, so teammates can see and reproduce the setup.

```json
{
  "lockfileVersion": 1,
  "generatedBy": "agentchainer@0.1.0",
  "catalogVersion": "2026.10.1",
  "workspaceProfileHash": "sha256:…",
  "items": [
    {
      "id": "cloudflare-security-audit",
      "kind": "skill",
      "tier": "verified-vendor",
      "source": { "type": "git", "repo": "https://github.com/cloudflare/security-audit-skill", "ref": "<sha>", "sha256": "<hash>" },
      "scope": "project",
      "installedAt": "2026-10-28T10:00:00Z",
      "files": [".claude/skills/security-audit/SKILL.md", "…"],
      "backup": ".agentchainer/backups/<run-id>/"
    }
  ],
  "fixes": [
    { "id": "fix-gitignore", "appliedAt": "2026-10-28T10:00:00Z", "files": [".gitignore"] }
  ],
  "generated": [
    { "id": "generate-claude-md", "generator": "ac-write-claude-md", "appliedAt": "2026-10-28T10:00:00Z", "files": ["CLAUDE.md"], "verified": true },
    { "id": "smoke-test", "generator": "ac-smoke-test", "appliedAt": "2026-10-28T10:00:00Z", "files": ["scripts/smoke.sh", ".github/workflows/smoke.yml"], "verified": true }
  ]
}
```

- `backups/<run-id>/` holds `run.json` (what the run did, including CLI changes to undo) and the previous content of
  every file the run changed. `.agentchainer/.gitignore` keeps it (and `profile.json`) out of git. It's used for
  byte-exact rollback, and a whole-run rollback removes it.
- `fixes` records deterministic fixes from the readiness audit (`.gitignore` env rules, untracking `.env`, …).
- `local`-scope items are private to the user, so they're recorded in `.agentchainer/local.json`, which
  `.agentchainer/.gitignore` keeps out of git, not in the committed lockfile. A run of local items only doesn't touch
  `lock.json`.

## 8. Updates and rollback

- **Upstream changes:** `.github/workflows/catalog-updates.yml` runs weekly (and on demand). It runs
  `packages/sidecar/scripts/check-catalog-updates.ts` against each item's upstream:
  - **marketplace plugins:** changes under the plugin's folder since `reviewedRef`;
  - **git sources:** changes under `path` since `ref`;
  - **release assets and npm:** the newest stable version at least 14 days old.

  For each item that moved:
  1. it bumps the pin, computing hashes from the downloads and cross-checking GitHub's digests;
  2. it clears the item's `reviews`, because a new upstream version is reviewed again;
  3. it rewrites only the changed values, so the rest of the file stays as written.

  The workflow then rebuilds the catalog snapshot and the plan snapshots, and opens or updates one PR,
  `chore(catalog): upstream updates [M2-04]`, with an upstream diff link per item. A maintainer reviews each item
  with §4 and adds the reviews before merging.

  Opening the PR needs the repository setting "Allow GitHub Actions to create and approve pull requests", or a
  `CATALOG_BOT_TOKEN` secret. With the default token, CI doesn't start on the PR by itself.
- **App releases** ship a catalog snapshot, and v0.1 never fetches catalog updates
  ([ADR-0007](adr/0007-catalog-distribution.md), M2-05).
- **Installed items:** the app shows "update available" with the changelog. Updates are applied like any other action:
  preview, apply, verify, record.
- **Rollback:** per item or per bootstrap run. It uses `uninstall` steps and backups, and is verified by comparing hashes
  of touched files.
  - Scope is **project files** plus the CLI entries we added (plugins, MCP servers).
  - Caches the CLI manages itself stay behind and are reported, not deleted. Example: `plugin uninstall` keeps
    `~/.claude/plugins/cache/…` (spike S6).
  - Downloaded binaries stay in AgentChainer's tools folder: other workspaces may use them.
