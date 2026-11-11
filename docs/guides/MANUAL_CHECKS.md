# Manual checks (macOS)

macOS's WKWebView has no WebDriver, so the end-to-end tests that run on Linux and Windows
(`scripts/e2e/app.e2e.mjs`, checklist X-06) and the keyboard and screen-reader checks (`a11y.e2e.mjs`, X-12) are a
click-through here. Run them on a build you're about to release,
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
| 3c | Open **MCP servers**, click **Add server…**. Name `check-echo`, Command `node -e "process.stdin.resume()"`, keep "This workspace, just me", click **Next**, then **Add server**. | The dialog showed `claude mcp add --scope local check-echo -- node -e 'process.stdin.resume()'` before it ran. The server is listed; opening it checks it (it fails: it's not a real MCP server). History lists "Add MCP server check-echo". |
| 3d | Roll back that run in **History**. | `claude mcp list` in `/tmp/ac-check` no longer lists `check-echo`. |
| 3e | Open **CLAUDE.md**. Type `# Check app` in the editor and press ⌘S. | The preview shows the heading as you type. After ⌘S, `/tmp/ac-check/CLAUDE.md` holds it, and History lists "Edit CLAUDE.md". |
| 3f | Type another line, then click **Setup plan**. | A dialog asks before discarding the unsaved edit. Cancel keeps you in CLAUDE.md with the edit. |
| 3g | Roll back the "Edit CLAUDE.md" run in **History**. Then click **CLAUDE.md** in the sidebar. | The file is gone again. The page lists `ac-check` as Missing, and clicking it opens its CLAUDE.md section. |
| 4 | Press ⇧⌘P, type "Workspace settings: Commands", press Enter. | The Commands section opens. |
| 5 | Open Settings (the gear at the bottom of the sidebar), set Theme to Dark, and click Save. | The app turns dark; `~/Library/Application Support/io.github.hafizhrf.agentchainer/settings.json` says `"theme": "dark"`. Set it back afterwards. |

## Keyboard and VoiceOver

The colours and labels are the same CSS and markup the Linux and Windows audits check. What only macOS can show is how
VoiceOver reads them, and that the keyboard paths work in WKWebView.

| # | Do | Expect |
|---|---|---|
| 6 | Turn VoiceOver on (⌘F5). Click the window's title bar, then press Tab through the title bar and the sidebar. | Every stop shows a focus ring, and VoiceOver reads a name that says what it does, never just "button" or "group". The resize handle reads as "Resize the sidebar". |
| 7 | Tab to the sidebar's **New**, press ⇧⌘P, then Esc. | VoiceOver announces the command palette; after Esc, focus is back on **New**. |
| 8 | Tab to the gear at the bottom of the sidebar, press Space, then press Tab ten times. | Settings opens; focus never leaves the dialog. Esc closes it, and focus is back on the gear. |

Turn VoiceOver off again (⌘F5).

## Bahasa Indonesia

The end-to-end run checks the Indonesian UI on Linux and Windows. Only macOS has the native menu bar.

| # | Do | Expect |
|---|---|---|
| 9 | Open Settings, set Language to Bahasa Indonesia, click Save, then **Restart now**. | The app restarts in Indonesian. The menu bar reads **File, Edit, Tampilan, Jendela, Bantuan**, and the app menu ends with **Keluar dari AgentChainer**. |
| 10 | Open Pengaturan and set Bahasa back to English, then save and restart. | The app and the menu bar are in English again. |

Write down the date, the macOS version and the build in the release notes or the checklist entry you're checking.
