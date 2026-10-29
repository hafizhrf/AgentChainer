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
  version: "<x.y.z>"
  assets:                    # per platform, each with sha256
    darwin-arm64: { url: "<asset url>", sha256: "<hash>" }
    linux-x64:   { url: "<asset url>", sha256: "<hash>" }
    win32-x64:   { url: "<asset url>", sha256: "<hash>" }
install:
  scope: local               # binary path isn't portable → private per-project registration
  steps:
    - download-binary: { to: "{appBin}/codebase-memory-mcp" }
    - run: [claude, mcp, add, --scope, local, codebase-memory, "{appBin}/codebase-memory-mcp"]   # (verify exact args)
notes: >-
  Do NOT run the upstream installer: it edits ~/.claude.json globally and adds hooks/agents/skills.
```

**Field reference:**

| Field | Required | Notes |
|---|---|---|
| `id`, `name`, `kind`, `tier`, `license`, `summary`, `why` | yes | `why` is shown to users in plain language |
| `source` | yes | `git` (repo + SHA + path + sha256), `marketplace` (plugin), `release-asset` (per-platform URL + sha256), `npm` (name + exact version + integrity) |
| `platforms`, `requires` | yes | Unmet requirements make the item unavailable, with an explanation |
| `detect` | no | Signals: files (`package.json`, `pubspec.yaml`), dependencies (`next`, `django`), git remote host, etc. |
| `risk`, `permissions` | yes | Shown in the review UI |
| `install`, `uninstall` | yes | Declarative steps only: `copy`, `remove`, `run` (argv array, no shell), `download-binary`, `merge-json`, `write-file` |
| `secrets` | no | Env var names the item needs (e.g. `GITHUB_TOKEN`). The installer references them and never writes values to files |
| `reviews` | no | `{by, date, ref, notes}` per maintainer review against §4. An item is offered only once its tier's count is met: first-party 0, official 1, verified-vendor 1, community 2. Until then the plan shows it as "not reviewed yet" |
| `notes` | no | Caveats for reviewers and users, shown in the plan |

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
| `baseline` | Every workspace | AgentChainer first-party skills (`ac-*`), `code-review`, `security-guidance`, `commit-commands` (official plugins), `gitleaks` pre-commit hook |
| `ts-node` | Node stack | `typescript-lsp` (needs `typescript-language-server`) |
| `python` | Python stack | `pyright-lsp` (needs `pyright-langserver`) |
| `go` | Go stack | `gopls-lsp` (needs `gopls`) |
| `rust` | Rust stack | `rust-analyzer-lsp` (needs `rust-analyzer`) |
| `flutter` | `pubspec.yaml` | None yet: the official marketplace has no Dart/Flutter LSP plugin (checked at `f8c5e7a`). `firebase` if Firebase config is detected **(later)** |
| `github` | Git remote on github.com, including SSH host aliases such as `github-personal.com` | `github` plugin (reads `GITHUB_PERSONAL_ACCESS_TOKEN` from your environment) |
| `knowledge` (opt-in) | On request | `context7`; `codebase-memory-mcp` later |
| `web-testing` (opt-in) | On request | `playwright` |
| `security` (opt-in) | Before release, or on request | `cloudflare-security-audit`, `semgrep` (CLI), `trivy` (CLI) **(later: needs the hashing installer)** |

Profiles live in `catalog/profiles/<id>.yaml` with `suggest: {always | stacks | remoteHost | optIn}`.

## 6. Seed items

| ID | Kind | Tier | License | Install method | Status |
|---|---|---|---|---|---|
| `ac-write-claude-md`, `ac-setup-hooks`, `ac-scaffold-tests`, `ac-generate-ci`, `ac-smoke-test` | skill | first-party | Apache-2.0 | Copied from `skills/` | To build (M2-19) |
| `code-review` (1.0.1) | plugin | official | Apache-2.0 (marketplace repo) | `claude plugin install code-review@claude-plugins-official --scope project` | In `catalog/`, awaiting review |
| `security-guidance` (2.0.17) | plugin | official | Apache-2.0 (marketplace repo) | same pattern | In `catalog/`, awaiting review |
| `commit-commands` (1.0.1) | plugin | official | Apache-2.0 (marketplace repo) | same pattern | In `catalog/`, awaiting review |
| `typescript-lsp`, `pyright-lsp`, `gopls-lsp`, `rust-analyzer-lsp` (1.0.0) | plugin | official | Apache-2.0 (marketplace repo) | same pattern; each needs its language server on PATH | In `catalog/`, awaiting review |
| `context7` | plugin | verified-vendor | **(verify)** | Partner plugin: the hosted MCP at `mcp.context7.com`, may ask you to sign in | In `catalog/`, awaiting review |
| `playwright` | plugin | verified-vendor | Apache-2.0 **(verify)** | Partner plugin. **It runs `npx @playwright/mcp@latest`, which is unpinned**, so prefer a pinned MCP item | In `catalog/`, awaiting review |
| `github` | plugin | verified-vendor | MIT **(verify)** | Partner plugin: the remote MCP `api.githubcopilot.com` with `GITHUB_PERSONAL_ACCESS_TOKEN` from your environment | In `catalog/`, awaiting review |
| `firebase` | plugin | verified-vendor | per plugin | Partner plugin | Seed **(verify)** |
| `cloudflare-security-audit` | skill | verified-vendor | MIT | Copy `skills/security-audit/` at a pinned SHA | Seed |
| `codebase-memory-mcp` | mcp | community | MIT | Pinned release binary + `claude mcp add --scope local` | Seed (needs 2 reviews) |
| `anthropic-example-skills` | plugin | official | Apache-2.0 (subset) | `example-skills@anthropic-agent-skills` | Optional; exclude source-available document skills |
| `gitleaks` | hook + tool | verified-vendor | MIT | Pinned release binary; pre-commit hook via the repo's hook manager | Seed |
| `actionlint` | tool | verified-vendor | MIT | Pinned release binary; used by the verifier | Seed |
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
    { "path": "CLAUDE.md", "action": "merge", "generator": "ac-write-claude-md", "verified": true },
    { "path": ".github/workflows/ci.yml", "action": "write", "generator": "ac-generate-ci", "verified": true, "checks": ["actionlint"] }
  ]
}
```

- `backups/<run-id>/` holds `run.json` (what the run did, including CLI changes to undo) and the previous content of
  every file the run changed. `.agentchainer/.gitignore` keeps it (and `profile.json`) out of git. It's used for
  byte-exact rollback, and a whole-run rollback removes it.
- `fixes` records deterministic fixes from the readiness audit (`.gitignore` env rules, untracking `.env`, …).
- `local`-scope items are recorded in the app DB, not the committed lockfile, because they're private to the user.

## 8. Updates and rollback

- **Upstream changes:** a scheduled workflow checks every item's upstream, then opens a PR that bumps ref and hash, with an
  upstream diff summary. A human reviews it using §4.
- **App releases** ship a catalog snapshot, and v0.1 never fetches catalog updates
  ([ADR-0007](adr/0007-catalog-distribution.md), M2-05).
- **Installed items:** the app shows "update available" with the changelog. Updates are applied like any other action:
  preview, apply, verify, record.
- **Rollback:** per item or per bootstrap run. It uses `uninstall` steps and backups, and is verified by comparing hashes
  of touched files.
  - Scope is **project files** plus the CLI entries we added (plugins, MCP servers).
  - Caches the CLI manages itself stay behind and are reported, not deleted. Example: `plugin uninstall` keeps
    `~/.claude/plugins/cache/…` (spike S6).
