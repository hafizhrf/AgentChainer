# ADR-0007: Ship the catalog as a bundled snapshot in v0.1

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** hafizhrf (owner), with Claude as implementer
- **Related:** M2-05, M2-01, [ADR-0005](0005-catalog-trust-model.md), [CATALOG §8](../CATALOG.md#8-updates-and-rollback)

## Context

The essentials catalog (`catalog/`) decides what bootstrap recommends and installs. M2-05 asks whether v0.1 ships it
only inside the app, or can also fetch newer catalogs from GitHub Releases between app releases.

Fetching updates needs signed catalogs and a key that is managed, rotated, and checked on every launch. Without that,
a compromised release or a network attacker could change what the app installs. The app can't sign anything today
(release signing is still open, R1). Meanwhile, catalog changes are pull requests reviewed against CATALOG §4.

## Decision

v0.1 ships **only the catalog compiled into the sidecar**:
- `catalog/*.yaml` is validated against the zod schemas in `packages/sidecar/src/catalog/schema.ts`.
- `scripts/build-catalog.ts` compiles it into `packages/sidecar/src/catalog/catalog.json`, which is bundled into the
  sidecar executable.
- The app never fetches catalog data at runtime.
- A catalog change reaches users with the next app release.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Fetch signed catalog updates from Releases | Fixes and new items reach users without an app update | Needs signing keys, key rotation, rollback protection and a trust UI; more attack surface | Too much security machinery for v0.1, and signing infrastructure doesn't exist yet |
| Fetch unsigned catalog from the repo | Simple | Anyone who can change the response can change what gets installed | Contradicts ADR-0005 |

## Consequences

- **Positive:**
  - What an app version can install is fixed at build time and reviewable in its source.
  - No network calls for the catalog; plans work offline.
- **Negative:**
  - A broken or risky item can only be withdrawn with an app release. Mitigation: items are reviewed before they are
    offered, and every install is previewed and confirmed.
- **Revisit when:** releases are signed (R1) and the catalog changes more often than the app ships.

## References

- [docs/CATALOG.md](../CATALOG.md), [ADR-0005](0005-catalog-trust-model.md)
