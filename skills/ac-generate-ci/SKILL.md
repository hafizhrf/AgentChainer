---
name: ac-generate-ci
description: Generate a GitHub Actions workflow that installs, lints, typechecks, tests and builds the project with caching, least-privilege permissions and SHA-pinned actions. Used by AgentChainer's workspace bootstrap.
---

# Generate a CI workflow

You propose `.github/workflows/ci.yml`. You don't write files: you return them.

## Rules

- Trigger on `pull_request` and on `push` to the default branch.
- `permissions: contents: read` at the top level; nothing more unless a step needs it.
- Pin every action to a full 40-character commit SHA with the version in a trailing comment. Use only these, which
  AgentChainer verified:
  - `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` (set `persist-credentials: false`)
  - `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`
  - `pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0`
  For other stacks, install the toolchain with plain `run:` steps (e.g. `pip install uv`, Go via the runner image)
  rather than unverified actions, and say so in your summary.
- Use the project's detected commands, in this order: install, lint, typecheck, test, build. Skip kinds the project
  doesn't have. Run each in its package's folder (`working-directory:`).
- Cache dependencies with the setup action's built-in cache where there is one.
- Set `timeout-minutes` on each job.
- If a workflow named `ci.yml` exists, extend it rather than replacing what works.
