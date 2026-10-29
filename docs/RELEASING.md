# Releasing AgentChainer

For maintainers. The decisions behind this are in [ADR-0009](adr/0009-release-signing-and-updates.md); the workflow is
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

## How a release happens

1. **release-please keeps a release PR open on `main`.** It's titled `chore(main): release X.Y.Z`. Each merged PR
   updates it with:
   - the next version, from Conventional Commit titles. Before 1.0, `feat` bumps the minor version and `fix` the patch
     version;
   - `CHANGELOG.md`;
   - the version in `apps/desktop/src-tauri/Cargo.toml`, `Cargo.lock` and `apps/desktop/package.json`.
     `tauri.conf.json` has no version, so Tauri uses the crate's.
2. **Merging the release PR creates a draft release** and its tag `vX.Y.Z`.
3. **CI builds the installers** on four runners: macOS arm64, macOS x64, Windows x64 and Linux x64. Each runner
   installs its own installer and launches it:
   - macOS: the `.dmg`;
   - Windows: the `.msi`;
   - Linux: the `.deb`.

   It also checks the installed sidecar's first-run SDK download.
4. **CI uploads everything to the draft:** the installers, their `.sig` files, `SHA256SUMS` and `latest.json`.
5. **You check the draft, and publish it.** Until then, nobody can download it, and the updater doesn't see it.

## One-time setup (owner)

### Update key

Do this before the first release that should be able to update itself. The private key never leaves your machine
except into the repository secret.

```sh
pnpm --filter @agentchainer/desktop tauri signer generate -w ~/.tauri/agentchainer-updater.key
```

Choose a strong password when it asks. Then, from the repository folder:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/agentchainer-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD        # paste the password at the prompt
gh variable set TAURI_UPDATER_PUBKEY < ~/.tauri/agentchainer-updater.key.pub
```

**Back up `~/.tauri/agentchainer-updater.key` and its password** in your password manager. If the key is lost,
installed copies can't update any more, and every user has to reinstall by hand.

Until the variable and both secrets exist, release builds have no updater: the app says "Updates aren't set up in this
build". If only one of them exists, the build fails on purpose.

### Optional: CI on the release PR

PRs opened with the default `GITHUB_TOKEN` don't start other workflows, so CI doesn't run on the release PR. Either:
- close and reopen it before merging; or
- add a `RELEASE_PLEASE_TOKEN` secret: a fine-grained token for this repository, with contents and pull requests
  set to read and write.

The repository setting "Allow GitHub Actions to create and approve pull requests" must be on. It already is, for the
catalog bot.

### Later: code signing

The build passes these secrets to the Tauri CLI when they exist:
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`, for signing;
- `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`, for notarization.

Windows signing needs `bundle.windows.signCommand` in `tauri.conf.json` once a certificate is chosen (R1-03).

## Before you publish a draft

- [ ] **v0.1.0 only:** M0-01 (name check) and M0-22 (Anthropic's written answer) are closed.
- [ ] The release workflow is green on all four runners and the finalize job.
- [ ] The draft has, per platform, the installers listed in [INSTALL.md](guides/INSTALL.md#1-download), plus
      `SHA256SUMS`. With the update key set up, it also has `.sig` files and `latest.json`.
- [ ] Spot-check a download with `shasum -a 256 -c SHA256SUMS --ignore-missing`.
- [ ] Clean-machine install on macOS, Windows 11 and Ubuntu LTS (R1-09). Follow INSTALL.md exactly, then do a first
      start, a session, and a workspace setup.
- [ ] The release notes read well. They are also shown in the app's update dialog.

Publish from the release page. The updater then finds `latest.json` at `releases/latest/download/latest.json`.

## Rebuilding a draft

Re-run the failed jobs, or run the workflow by hand: **Actions → Release → Run workflow**, with the tag (for example
`v0.1.0`). The installers are rebuilt from the tag and replace the draft's assets. Never rebuild a published release:
publish a new patch version instead.

## Dry runs

PRs that change the release setup run the same builds as a dry run, signed with a throwaway key. The installers,
`SHA256SUMS` and `latest.json` are attached to the workflow run for 7 days. No release secret reaches a PR.

## Key rotation

A new update key only works for apps that already have its public key. To rotate:
1. Ship a release signed with the **old** key whose app contains the **new** public key. This needs a one-off
   workflow change.
2. Once users are on that version, switch the secrets.

Plan this in an ADR before doing it.
