# Design: multi-folder workspaces and the agent fleet (M8)

- **Status:** Draft, waiting for the owner
- **Date:** 2026-11-03
- **Covers:** M8-01 (multi-folder workspaces) and M8-02 (fleet view) in detail. M8-03…M8-06 are sketched (§6); each
  gets its own design later.
- **Source:** PRD [F9](../PRD.md#f9--multi-folder-workspaces-p2), and the owner's requests of 2026-10-30
- **Builds on:** UX-03's sidebar, M4's agent tree and graph, M3's tasks and worktrees, M5's pull requests

## 1. The problem

- A change that spans an app repo and its API repo needs two separate sessions today. Neither agent can see the other
  repo, so the person carries the context between them.
- Several sessions and task runs can be going at once, in different workspaces. Nothing shows all of them together:
  which is working, which is waiting for an approval, what each has cost. The sidebar only shows the open tabs
  (`apps/desktop/src/Sidebar.tsx:128`), and a task step has no tab at all.

## 2. The user's flow

- **Fleet (M8-02):** a **Fleet** entry in the sidebar and the command palette opens a list of everything live, across
  workspaces: interactive sessions and task steps.
  - Each row shows its status, workspace, cost, and how long it has been in that status.
  - One click opens it. A row waiting for an approval opens the approval.
- **Multi-folder (M8-01):** Home → **New workspace…**.
  - The person names it, picks a primary folder, and adds more folders. The dialog lists every folder the agent will
    be able to read and write.
  - The workspace shows in the recent list with its folder count. Opening it starts sessions in all its folders.

## 3. What exists today

- **A workspace is one folder:**
  - the UI holds one `cwd` string (`apps/desktop/src/App.tsx:85`);
  - the recent list is flat paths (`apps/desktop/src/settings.ts:31`), saved in the app's `settings.json` through
    `settings_get`/`settings_set` (`apps/desktop/src-tauri/src/settings.rs`).
- **Tabs already span folders:** each `Tab` has its own `cwd` (`apps/desktop/src/tabs.ts:9`). The sidebar derives
  each tab's status in the UI (`Sidebar.tsx:128`):
  - waiting for approval: approvals pending;
  - working: a turn is running, or background work is;
  - ended;
  - idle: anything else.
- **The sidecar keeps live things in two maps, exposed by no method:**
  - interactive sessions (`packages/sidecar/src/main.ts:104`);
  - task runs (`packages/sidecar/src/tasks/service.ts:307`).

  Tasks report through `task.updated`. A task step's approvals queue in the UI and show over whatever page is open
  (`App.tsx:220`).
- **Sessions:** `SessionOptions` (`packages/sidecar/src/session.ts:34`) has one `cwd`. The SDK's
  `Options.additionalDirectories` is "additional directories Claude can access beyond the current working directory.
  Paths should be absolute" (the pinned SDK's `sdk.d.ts`). The app doesn't pass it yet.
- **The guard has one root:**
  - a recursive `rm` outside `cwd` is refused (`packages/sidecar/src/guard.ts:92`, `isInside` at :122);
  - a read-only step can't read outside its root (`guard.ts:163`);
  - the hook takes `cwd` from the hook input (`session.ts:75`).
- **Protocol:** one shared `WorkspaceRef {cwd}` (`packages/protocol/src/index.ts:916`) is used by about 74 methods:
  readiness, setup, git, tasks, deploys, workflows, metrics and files. Session and agent methods take `cwd` inline.
- **Tasks:**
  - records live in `<cwd>/.agentchainer/tasks` (`packages/sidecar/src/tasks/store.ts`);
  - worktrees live in `<root>/.agentchainer/worktrees` (`tasks/worktree.ts:17`), and `codeRootIn` (:23) maps a
    workspace's subfolder inside one;
  - XL sub-tasks each get a worktree of the parent's repository (`tasks/xl-world.ts:49`).
- **Rust:** spend history is keyed by `cwd` (`apps/desktop/src-tauri/src/history.rs`). The file watcher keeps one
  watcher per path (`watcher.rs:27`), so it can watch several folders already.

## 4. The fleet view (M8-02, owner decision 3: built first)

- **Rows:**
  - every interactive session the sidecar holds, whether or not its tab is the active one;
  - every running task step;
  - for an XL task, a row for the task with its sub-tasks' steps under it.
- **A new method, `fleet.list`, `{} → FleetItem[]`.** It snapshots the two maps. Each item has:
  - id;
  - kind: session or task step;
  - workspace (`cwd`);
  - title: the session's title, or the task and step labels;
  - status, cost, `startedAt`, and `since` (when the status last changed);
  - pending approvals;
  - for a task step, the task id and step id.
- **Live updates:** a new `fleet.changed` notification carries one item whenever a status, cost or approval count
  changes. The sidecar already sees each of those (turn start and end, background changes, permission requests and
  answers, task steps). The view never polls. Sessions get a status the sidecar tracks itself, in place of the private
  busy flag (`session.ts:313`), so the fleet and the sidebar agree.
- **Statuses:**
  - working;
  - waiting for approval;
  - idle;
  - ended;
  - failed, for a task step.

  "Waiting for approval" counts the step's queued approvals too.
- **Actions per row:**
  - **Open:** switch to the tab, open a stored session in a new tab, or open the task page at the step.
  - **Stop:** the existing interrupt for a session, or `task.cancel` for a step.
  - **Approve:** opens that approval's dialog.
- **Subagents (from M4's tree):** expanding a session row lists its subagents and their status. The data is what the UI
  already keeps for an open tab (`transcript.ts`, `graph/`). A row whose session has no tab shows no subagents; it
  shows a link to open it.
- **Scope:** live items, plus items that ended in this app run. Restarting the app clears the list. Stored sessions
  stay in Sessions, and finished tasks stay in Tasks and Metrics.
- **No network:** it's all in-process, over the existing stdio frames (THREAT_MODEL T-05). CAO's web dashboard isn't
  adopted.

## 5. Multi-folder workspaces (M8-01)

### 5.1 The definition (owner decision 2)

- **Shape:** `Workspace {id, name, primary, folders[]}`, with absolute paths, stored in the app's `settings.json`
  next to `recentWorkspaces`.
  - `folders` lists the extra folders; `primary` is where sessions start and where task records live.
  - Nothing is written to any repository, because absolute paths differ from one computer to the next.
  - Export and import of a definition can come later.
- **One-folder workspaces stay as they are:** a plain path in the recent list. Existing settings need no migration
  beyond reading the new optional `workspaces` list.
- **Folders the dialog refuses:**
  - the home folder, a filesystem root, or a folder inside another folder of the same workspace;
  - a missing folder.

  A folder may be outside git; git features are simply off for it.

### 5.2 Sessions

- `session.start` gains `folders: string[]`, the extra folders.
  - The sidecar passes `cwd: primary` and `additionalDirectories: folders`.
  - `SessionOptions` gains `additionalDirectories`.
  - A resumed or forked session gets the workspace's current folders.
- **What the CLI loads from an added directory**, checked live on CLI 2.1.314 (haiku, a session in `app` with `api`
  added, each with its own CLAUDE.md naming a codeword): only the primary folder's CLAUDE.md loaded. An edit in the
  added folder went through the normal approval and was applied. The app says that only the primary folder's
  CLAUDE.md, project settings, hooks and skills apply.
  - The Claude Code docs describe an environment opt-in for loading `CLAUDE.md` from added directories
    **(verify)**. The app doesn't set it: it never sets a CLI environment option silently, and one that's needed is
    documented and shown.
- **Permission requests already carry a `blockedPath`** (`index.ts`, `PermissionRequest`). A request for a path outside
  every folder of the workspace shows which path it was, as today.

### 5.3 The guard

- `checkBash`, `readOnlyHook` and `isInside` take a list of roots: the session's `cwd` plus its added folders.
  - A recursive `rm` is allowed inside any of them, and nowhere else.
  - A read-only step reads only inside them.
- The secret-path checks don't change.
- The roots come from the session's options, not from the hook input. The hook input's `cwd` is the primary folder only.

### 5.4 Folder-scoped features

- **Readiness, the setup plan, git, deploys, workspace files and Workspace settings stay per folder.** Their methods
  keep `WorkspaceRef {cwd}`, where `cwd` is the folder they act on. The code behind them doesn't change.
- **The UI adds a folder switcher** (the workspace's folders, primary first) in two places:
  - the right panel's Changes, Files and Git tabs;
  - the header of Workspace settings.
- **Readiness on Home** shows one line per folder.
- **Spend history** stays keyed by the primary folder, so a workspace's spend is one total.

### 5.5 Tasks

- Records live in the primary folder's `.agentchainer/tasks`.
- **Affected areas name the folder:**
  - an area outside the primary folder is written with the folder's name as a prefix, e.g. `api:src/routes.ts`;
  - an area with no prefix is in the primary folder.

  The contract drafter is told the folders and the prefix rule.
- **Each git folder the contract touches gets its own worktree,** under that folder's own `.agentchainer/worktrees`.
  - Steps run with `cwd` at the primary folder's worktree, and with `additionalDirectories` set to the other
    worktrees.
  - The guard's roots are the worktrees, not the original folders, so a run can't edit the checkouts the person is
    using.
- **Gates run per folder,** with each folder's own commands from its readiness profile. The evidence report groups
  changed files and gate runs by folder.
- **XL:** a sub-task can target one folder, and gets a worktree of that folder's repository. The merge back is per
  repository.
- **PRs (M5):** one draft PR per touched repository, each linking the others in its body.
- **Deploys (M6)** stay per folder.

### 5.6 What M8-01 doesn't do

- One session per folder, with a message bus between them. That's M8-03's supervisor model, with its own design.
- Syncing branches across repositories. Each repository keeps its own branches; the PRs link each other.

## 6. M8-03…M8-06, sketched (each gets its own design)

The ideas come from [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator) (CAO, Apache-2.0).
They're used as ideas only; no code is copied.

- **M8-03 Supervisor and worker sessions:** a supervisor session hands work to worker sessions through an in-app MCP
  server, with tools to assign, hand off, message and read an inbox. Workers run under the app's approvals and
  budgets, and show in the fleet view.
  - Open: how a worker's result returns, and how this relates to XL's fixed split (M3-07).
- **M8-04 Agent profiles manager:** create from a template, edit, clone and delete profiles, each validated before
  saving and with its own tool allowlist. It builds on M3-05's roles and UX-10's Plugins page.
  - Open: the profiles' file format, and the scope (user or project).
- **M8-05 Scheduled flows:** run a task template on a schedule (e.g. a nightly dependency bump), with a budget cap and
  an evidence report per run.
  - Open: schedules run only while the app is open; v0.x installs no OS service.
- **M8-06 Lessons from outcomes:** suggest additions to `CLAUDE.md` from finished tasks' evidence. It's opt-in, and
  each suggestion is approved by the person.
  - Open: which evidence counts, and how a suggestion is deduplicated.

## 7. UI

- **The fleet view:**
  - a page with dense rows: a status icon and label (status is never shown by color alone, X-12), title, workspace,
    cost and time in status, and actions on the right;
  - grouped by workspace, with a filter for status;
  - the sidebar's Fleet entry shows the counts working and waiting.
- **The New workspace dialog:**
  - a name and a primary folder, then "Add folder", with each folder's path and git state;
  - a sentence listing what the agent can read and write.
- **The folder switcher:** a compact select, primary first.
- Both themes; keyboard reachable (X-12).

## 8. Security and privacy

- **More folders mean more scope.**
  - The dialog says which folders the agent can read and write.
  - The guard's containment covers exactly those folders.
  - Home, a filesystem root and nested folders are refused.
- **A task run's roots are its worktrees,** so an agent can't change the person's checkouts during a run.
- **The fleet view** reads only what the sidecar already holds, and adds no network surface.
- **THREAT_MODEL:** a new row, T-15 "folders added to a workspace by mistake", and an update to T-05 for
  `fleet.list`.
- **PRIVACY:** workspace definitions stay in the app's settings on this computer.

## 9. Testing

- **The guard with several roots:** `rm -rf` in each folder, between folders and outside them; and a read-only step
  reading across them.
- **`fleet.list`:** status changes over a scripted session (fake SDK) and a task step; the notification order.
- **The settings schema:** reading old settings without `workspaces`; and the dialog's refusals (home, root, nested,
  missing).
- **Live (haiku, a few cents):**
  - a session in a two-folder workspace edits a file in the added folder;
  - the result of the CLAUDE.md and settings check (§5.2, **(verify)**).
- **Live, as M8-01's demonstration:** a task across two fixture repositories, with a worktree each, gates per folder,
  and the evidence grouped by folder.
- **In the app:** two workspaces running at once in the fleet view, with stop, approve and open; light and dark.

## 10. Delivery (one PR per step)

1. **The fleet view:** sidecar-side session status, `fleet.list` and `fleet.changed`, the page, and the sidebar entry
   → M8-02.
2. **The workspace model:** settings, the New workspace dialog, and the recent list showing workspaces.
3. **Sessions across folders:** `additionalDirectories`, the multi-root guard, and the live check of what loads from
   added folders.
4. **Per-folder features:** the folder switcher in the right panel and in Workspace settings, and readiness per folder.
5. **Tasks across folders,** in two PRs:
   - 5a: worktrees, steps across them, gates, evidence, merge and cleanup;
   - 5b: XL sub-tasks per folder and one PR per repository → M8-01.

## 11. Alternatives considered

- **The definition in a repository file, or a `.code-workspace`-style file:** set aside by owner decision 2. Paths
  differ per computer, and a file adds a type to manage.
- **One session per folder instead of `additionalDirectories`:** rejected. Neither agent can see the other folder,
  which is the problem in §1.
- **A fleet view that polls:** rejected. Every change already passes through the sidecar, so it pushes.
- **CAO's web dashboard or tmux backends:** not adopted. There's no network port (T-05), and the app has its own
  sessions and terminal.

## 12. Decisions and what's still open

**Owner decisions (2026-11-03):**
1. This doc covers M8-01 and M8-02 in detail; M8-03…06 are sketched and designed later.
2. Workspace definitions live in the app's settings, not in a repository.
3. The fleet view is built first.
4. The folder prefix in affected areas is the folder's name (`api:src/routes.ts`).
5. The fleet view doesn't keep finished items after a restart; Sessions and Tasks keep those.
6. The chat and task overhaul ([chat-and-tasks.md](chat-and-tasks.md)) comes before the fleet view.

**Still open:** nothing for M8-01 and M8-02. What the CLI loads from added folders was settled in step 3 (§5.2).
