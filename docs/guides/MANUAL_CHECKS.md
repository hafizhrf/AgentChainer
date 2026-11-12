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
| 3h | In `/tmp/ac-check`, run `echo A=1 > .env && echo .env >> .gitignore`. Open **Worktrees**, click **Use suggested**, type `node -e 0` as Setup and `npx http-server -p 4310` as Run, then **Save**. | The list shows `.env` would be copied. Both scripts say "Allowed on this computer". History lists "Edit worktree setup". |
| 3i | Start a tier-S task (any small request) and let it finish. | Its "Task branch" step says it copied `.env` and ran `node -e 0`; the task's commit has no `.env`. |
| 3j | On the task's page, click **Run app**. When the terminal prints `http://127.0.0.1:4310`, click **Preview**, then **Stop**. | The terminal runs the script in the task's worktree; the Preview shows the folder listing; Stop ends it. |
| 3k | Look at the sidebar under New, and at a workflow in the editor. | Fleet, Usage and CLAUDE.md sit close together. The editor's "Valid" line has room on the left and says "a tier-M run". |
| 3l | In a chat in `/tmp/ac-check`, change `src/cart.js` and `README.md` (or ask Claude to). In the right panel's Changes, open `src/cart.js`, click a changed line, **Comment…**, type a note, ⌘↵. Do the same in `README.md`. | Each commented line is marked. The Changes tab says 2 comments are waiting. |
| 3m | Type something in the composer, then click **Add 2 comments to message**. | The composer holds a "Feedback on the changes" block with both files' lines, quotes and notes, after what you typed. Enter sends it, and the comments are cleared from the diff. |
| 3n | Click **New** in the sidebar, then **New folder…**. Keep the parent, type `ac-new`, keep "Initialize a git repository", click **Create folder**. | The folder card shows `ac-new`; the folder exists with a `.git` folder. Creating `ac-new` again says the name is taken. |
| 3o | Open Settings → **Agents**. | Claude Code shows Installed · version and Signed in · method; Codex and Antigravity show their own status, or Not installed with an install command. Check again refreshes them. |
| 3p | Open the tier-S task from 3i. In its **Changes** card, click `src/cart.js`, click a changed line, **Comment…**, type "Name this value lineTotal", ⌘↵, then **Back**. Leave the task's page and come back. | The card lists the task's files with their status and +/− lines. The file shows "1 comment"; the footer says 1 comment is waiting, also after coming back. |
| 3q | Click **Fix as commented (1)…**, type a note, then **Fix as commented**. Watch the run, then open `src/cart.js` again. | The dialog lists the comment, the implementer's agent, the budget left and "The changes stay in the task's worktree". A "Fix as commented" step runs, then the gates; the run ends Done, the diff shows the rename, and the evidence lists "Round 1: 1 comment on `src/cart.js`: done". |
| 3r | While a task runs, scroll the thread up to an earlier step and read it for a minute. | The thread stays where you scrolled; the running step stays open between steps, with no flicker. |
| 3s | Run a tier-M task with Review on Antigravity (the triage card's Agents pickers), and keep its page open. When it ends, open the Independent review step. | The step shows the verdict, each acceptance criterion with Met / Not met and why, and the findings, not JSON. No `finish` card spins. |
| 3t | Make a new task in `/tmp/ac-check` with a vague request ("Add discounts to the cart."). When the question card shows in the task's thread, pick an option (or type your own under Other) and Submit. | Drafting goes on with your answer; the contract card lists it under "Settled with you", and Open questions holds only what's still open. A reply in the composer redrafts without asking the same question again. |
| 3u | Approve a tier-S task in `/tmp/ac-check` with a budget, then click **Run on several…**. Keep two rows (e.g. Claude and Claude · haiku, or another agent you're signed in to), then **Run 2 variants**. | The dialog says the total budget and that setup runs for each. The task shows a Best of N card with both variants running; Fleet shows two runs named with their agent. |
| 3v | When both end, click **Open** on one, look at its Changes and Run app, go **Back to the task**, then **Keep this one** on the other. | The table shows each one's state, gates, changes, cost and time. After Keep, the task shows the kept variant's run, Result and Changes; `git worktree list` has one worktree for it; the evidence has "Best of N". |
| 3w | On a task with an open PR on a throwaway repository, leave an inline review comment on GitHub, then open the task's page. | Review comments lists it (path:line, your login, the comment) ticked; **Refresh** reads again. **Fix 1 comments…** says the words go as data and nothing is posted; after the round, the PR has a new commit "Address review comments" and the thread says "Sent in round 1". Nothing new appears on GitHub besides the commit. |
| 3x | Start a tier-M task and keep its **Flow** tab open while it runs. | The lines between the steps stay while the steps change state. |
| 3y | With Tasks preview on, in a workspace whose origin is a GitHub repository with open issues, open **File → New Task from Issue…** (or the palette's "New task from a GitHub issue…", or Home's **From a GitHub issue…**). Search, pick one, keep or change the request, then **Create task**. | The list shows open issues with labels and author; search narrows it. The new task opens and drafts; its page shows "From issue #N" linking to it. Create PR's preview ends with "Closes #N". |
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
