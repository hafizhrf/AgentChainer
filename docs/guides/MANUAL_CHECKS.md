# Manual checks (macOS)

macOS's WKWebView has no WebDriver, so the end-to-end tests that run on Linux and Windows
(`scripts/e2e/app.e2e.mjs`, checklist X-06) are a click-through here. Run them on a build you're about to release,
and when a change touches these screens. None of them needs a Claude login or makes a model call.

## Setup

1. Build the debug app: `pnpm --filter @agentchainer/desktop tauri build --debug --no-bundle`.
2. Make a scratch workspace from the fixture:

   ```bash
   cp -R fixtures/sample-app /tmp/ac-check && cd /tmp/ac-check && git init -q && git add -A && git commit -qm fixture
   ```

3. Start `target/debug/agentchainer` and open `/tmp/ac-check` once, so it's in the sidebar's recent list.

## The checks

| # | Do | Expect |
|---|---|---|
| 1 | Start the app. | The setup check on Home lists the Claude Code CLI: found with its version, or "not found" with the install command. |
| 2 | Click `ac-check` under Recent workspaces in the sidebar, then **Workspace settings…** on Home. | Workspace settings opens on Overview for `ac-check`. |
| 3 | Open **Setup plan**. Leave only **Ignore env and secret files** checked, click **Apply selected (1)**, and confirm. | `/tmp/ac-check/.gitignore` now exists and lists `.env`. |
| 3b | Open **History**, click **Roll back run**, and confirm. | `.gitignore` is gone again; the run shows as rolled back or disappears. |
| 4 | Press ⇧⌘P, type "Workspace settings: Commands", press Enter. | The Commands section opens. |
| 5 | Open Settings (the gear at the bottom of the sidebar), set Theme to Dark, and click Save. | The app turns dark; `~/Library/Application Support/io.github.hafizhrf.agentchainer/settings.json` says `"theme": "dark"`. Set it back afterwards. |

Write down the date, the macOS version and the build in the release notes or the checklist entry you're checking.
