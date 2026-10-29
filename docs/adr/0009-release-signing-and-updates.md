# ADR-0009: Unsigned v0.1 installers, signed updates, drafts published by hand

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** hafizhrf (owner), with Claude as implementer
- **Related:** R1-01…R1-04, R1-08, R1-09, [RISKS R-07](../RISKS.md), [ADR-0002](0002-auth-and-branding.md)

## Context

v0.1 needs installers for macOS (arm64 and x64), Windows and Linux, a changelog, and a way to deliver fixes.

**Code signing:**
- On macOS it needs an Apple Developer ID (USD 99 a year) plus notarization of every embedded binary, including the
  Node single-executable sidecar.
- On Windows, a code-signing certificate or Azure Artifact Signing, for SmartScreen reputation.
- The project has no budget for either yet (R-07).

**Updates:** Tauri's updater (`tauri-plugin-updater`) checks a JSON manifest. It installs only an artifact signed with
the minisign key whose public half is built into the app. Two consequences:
- An app built with one key can only update to builds signed with that key.
- Losing the private key strands every installed copy on its version.

**Release gate:** the owner has two open M0 items that must be settled before anything is public:
- **M0-01:** the name check;
- **M0-22:** Anthropic's written answer on authentication.

## Decision

**Installers are unsigned for v0.1.**
- [INSTALL.md](../guides/INSTALL.md) explains how to open them on macOS and Windows, and how to check them against
  `SHA256SUMS`.
- The release workflow already passes Apple signing and notarization secrets to the Tauri CLI when they exist, so
  adding signing later needs no workflow change on macOS. Windows signing needs `bundle.windows.signCommand` once a
  certificate is chosen.

**Updates are signed, and checked only when the user asks.**
- The owner generates the update key pair. The private key and its password live only in the owner's password manager
  and the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- The public key is the repository variable `TAURI_UPDATER_PUBKEY`. The release build writes it into the app, and
  turns on updater artifacts when the private key is present. Builds without the key, including dev builds, say
  "Updates aren't set up in this build".
- `requireSignedVersion` is on, so a manifest can't pair a new version number with an older signed artifact.
- The app checks only from **Help → Check for Updates** or Settings, and installs only after the user confirms.

**Releases are drafts, published by a person.**
- release-please keeps a release PR open on `main`. Merging it creates a draft release and its tag.
- CI builds the installers on four runners, installs and launches each one, and uploads them with `SHA256SUMS` and
  `latest.json` to the draft.
- The owner publishes the draft. The updater endpoint is `releases/latest/download/latest.json`, so only a published
  release reaches users.
- Pull requests that touch the release setup get the same build as a dry run, signed with a throwaway key, and never
  see release secrets.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Sign and notarize from v0.1 | No Gatekeeper or SmartScreen friction | Cost; notarizing the sidecar is unproven | No budget yet; revisit for v0.2 |
| No updater in v0.1 | Smaller attack surface; nothing to lose | Users on old versions with known bugs; manual downloads only | Fixes after v0.1 are likely, and adding the key later can't reach v0.1 installs |
| Automatic background update checks | Users learn of fixes sooner | A network call the user didn't ask for (privacy page) | Opt-in checks fit "no telemetry"; an opt-in automatic check can come later |
| changesets instead of release-please | Explicit change notes per PR | A changeset file in every PR; npm-centric | Conventional Commit titles are already required |
| Publish straight from CI | Faster | A bad build reaches users before anyone looks | The first releases need a human check of the assets |

## Consequences

- **Positive:**
  - Every release is reproducible from a tag, with checksums.
  - Installers are smoke-tested on their own runner.
  - Updates can't be swapped on the way, because the signature is checked against the built-in key.
- **Negative:**
  - Users must get past Gatekeeper and SmartScreen by hand. "Damaged app" reports on macOS are likely, and
    INSTALL.md covers them.
  - The update key is now critical. The owner must back it up: if it's lost, every installed copy needs a manual
    reinstall.
  - Tauri's AppImage and Windows bundlers download their own tools at build time (linuxdeploy, WiX, NSIS). That's
    outside this project's pinning (THREAT_MODEL T-10).
- **Revisit when:** there's budget for signing (R-07); users report install friction; the update key must be rotated.

## References

- Tauri updater plugin: https://v2.tauri.app/plugin/updater/ **(verify)** and the `tauri-plugin-updater` 2.14.0
  source (`requireSignedVersion`, `{os}-{arch}-{installer}` platform keys).
- release-please `draft` and `force-tag-creation`: https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md **(verify)**
- `.github/workflows/release.yml`, `scripts/release-assets.mjs`, [RELEASING.md](../RELEASING.md).
