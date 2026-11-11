# Design: one chat for sessions and tasks, a complete chat room, and a live workflow canvas (UX-12…UX-14)

- **Status:** Draft, waiting for the owner
- **Date:** 2026-11-03
- **Covers:** UX-12 (a complete chat room), UX-13 (one thread for chats and tasks, superseding UX-11's task pages
  pass), UX-14 (a live, AI-made workflow canvas)
- **Source:** the owner's feedback of 2026-11-03
- **Builds on:** M1's sessions and composer, M3's tasks, M4's agent tree, M6-04's workflow canvas

## 1. What problem this solves

The owner's words, translated:
- "New task and New session are confusing; why are they separate?"
- "A task has no chat room."
- "The contract and the rest are still very messy; the task part doesn't look like a proper IDE."
- "Shift+Tab should change the chat mode like other agent harnesses; slash commands should autocomplete; the chat
  room should be as complete as it gets; and it should switch from auto to plan mode by itself when the agent needs to
  ask, like the real Claude CLI."
- "I thought the React Flow workflow could pinpoint the flow between agents during a task, and that AI could make it."

What the code does today:
- **A task is a full-page form.** `apps/desktop/src/tasks/TaskPage.tsx` is 1748 lines. The page covers the main area,
  so a task has no tab, right panel, terminal or status bar.
- **Drafting is hidden.** It's a bare `sdk.query` (`packages/sidecar/src/tasks/contract.ts:158`), shown as a spinner.
- **Nothing reaches a running step.** `runner.followUp` (`packages/sidecar/src/tasks/runner.ts:272`) is used only by
  the orchestrator's fix rounds.
- **Step approvals are a global modal** (`apps/desktop/src/App.tsx:115`). Step transcripts already stream with a task
  tag (`packages/sidecar/src/main.ts:153`), but they render only inside collapsed steps.
- **The composer** (`apps/desktop/src/Composer.tsx`):
  - lists slash commands by name only, from the init message's `slash_commands`;
  - has no Shift+Tab, no input history, no drag-drop, and no editing of queued messages;
  - has no todo panel, no context meter and no compaction marker.
- **Questions and plan mode:**
  - `ExitPlanMode` has a review dialog (`apps/desktop/src/PermissionDialog.tsx:39`).
  - `AskUserQuestion` and `EnterPlanMode` aren't handled. They fall into the generic approval and show raw JSON.

The pinned SDK already has what's needed:
- `Query.supportedCommands()`, which returns name, description, argument hint and aliases, plus a push when the list
  changes;
- `Query.getContextUsage()`;
- `compact_boundary` system messages;
- `AskUserQuestionInput`, whose answers go back through the permission response;
- `EnterPlanModeInput`.

All of these are in `@anthropic-ai/claude-agent-sdk`'s `sdk.d.ts` and `sdk-tools.d.ts`. The exact answer shape is
**(verify)**, checked live in step 1.

## 2. Decisions (owner, 2026-11-03)

1. **One chat; a task is a kind of thread.**
   - A single **New** opens the chat, and the composer picks **Chat** or **Task**.
   - A task's drafting streams in the thread. The contract and triage are cards there, and replying refines them.
   - During a run, each step and its agent stream into the same thread, and the person can message the running step.
   - **Make this a task** turns a chat into a task.
   - Tasks get tabs, the right panel, the terminal and the status bar, like chats.
2. **AI makes flows both ways, and the canvas is live.**
   - For an M, L or XL task, the planner may propose a task-specific flow. It's shown with the contract and approved
     with it.
   - The workflow editor gets **Generate with AI** for project workflows.
   - Both are validated like a hand-written workflow, and a running task shows its live flow on the canvas.
3. **This comes before the M8 fleet view**, which is easier once tasks are tabs.

## 3. The shell

A task is a tab like a chat. The sidebar lists both, each with its status. The right panel gains two tabs for tasks:
**Task** and **Flow**.

```
┌ Sidebar ──────┐┌ Fix cart total  ·  Task · S · running ───────────────┐┌ Task │ Flow │ Changes │ Git ┐
│ + New    ⌘N   ││                                                       ││ Contract (approved)         │
│               ││ you  total() ignores the quantity…                    ││  Objective  Cart totals…    │
│ ● Fix cart  T ││                                                       ││  Criteria   2 · gate:test   │
│ ○ API chat    ││ ▸ Drafting · Read 3 files · $0.004                    ││ Tier S · budget $2 · $0.01  │
│ ◐ Docs pass T ││ ┌ Contract ───────────────────────────────── Edit ┐   ││ Worktree agentchainer/…     │
│               ││ │ Objective  Cart totals count every unit…        │   ││ Overlaps · none             │
│ Workspaces    ││ │ Criteria   ✓ total() = Σ price × quantity  test │   ││ Accept risk…  Revise        │
│  sample-app   ││ │ Areas      src/cart.js · test/cart.test.js      │   │└─────────────────────────────┘
│               ││ └ Tier S · $2 · [ Approve & run ] ────────────────┘   │
│               ││ ▾ Implement · implementer · running · $0.006          │
│               ││    Edit src/cart.js  +1 −1                            │
│               ││ ▸ Gates · waiting                                     │
│               ││ ┌──────────────────────────────────────────────────┐  │
│               ││ │ Message Implement…                     @ / 📎    │  │
│               ││ │ [Chat | Task]  ⇧⇥ Standard · haiku · effort     │  │
│               ││ └──────────────────────────────────────────────────┘  │
└───────────────┘└ status: ctx 23% · $0.012 · worktree ──────────────────┘
```

- **New** (⌘N) opens the composer in Chat mode. ⌘⇧N opens it in Task mode. The Home view keeps its folder picker and
  readiness, with one composer.
- A task's tab works in the task's worktree once it has one. Until then, it works in the workspace. Changes, Files,
  Git and the terminal follow that folder.

## 4. The chat room (UX-12)

### 4.1 Modes and Shift+Tab

- **Shift+Tab cycles the mode:** Safe → Standard → Plan first → Autonomous, then back to Safe.
  - Autonomous is in the cycle only when the session has a budget cap (`apps/desktop/src/options.ts:60`).
  - It goes through the existing `session.setMode`.
- A **mode chip** in the composer shows the current mode with "⇧⇥". Clicking it opens the existing picker and its
  help.

### 4.2 Slash commands

- **The sidecar relays the command list.** After init it calls `supportedCommands()`, and it relays the SDK's
  "commands changed" push. Both go out as a new `session.commands` notification carrying name, description, argument
  hint and aliases.
- **The menu shows each command's name, description and argument hint.** It matches on names and aliases with the
  existing fuzzy filter (`apps/desktop/src/fuzzy.ts`).
- **App commands run in the app and aren't sent:**

  | Command | What it does |
  |---|---|
  | `/clear` | A new chat in the same folder |
  | `/model`, `/mode`, `/effort` | Open those pickers, or set the value given as the argument |
  | `/cost` | Show the session's spend and the context meter |
  | `/fork` | Fork the session |
  | `/rewind` | The rewind menu |
  | `/task` | Make this a task (§5.4) |

- **Every other command is sent as text**, as today: the CLI's own, the project's and plugins'. Examples: `/compact`,
  `/review`, skills.

### 4.3 Questions and plan mode on its own

- **AskUserQuestion:** `canUseTool` sends it to the UI as a question request, not as an approval. A **question card**
  shows in the thread:

  ```
  ┌ Claude asks ─────────────────────────────────────────┐
  │ Which rounding should withTax use?                     │
  │  ○ Half up (1082.5 → 1083)                             │
  │  ○ Banker's rounding                                   │
  │  ○ Other: [__________________]                         │
  │                                    [ Skip ] [ Answer ] │
  └────────────────────────────────────────────────────────┘
  ```

  - It offers single or multi-select options, and "Other" as free text.
  - The answers return as the tool's updated input. Skip denies the tool with "the person skipped the question".
- **EnterPlanMode:** it's allowed without asking, and the session's mode becomes Plan first.
  - A banner says "Claude switched to Plan first to ask before changing anything", with **Back to Standard** (or
    whatever the previous mode was).
  - ExitPlanMode's existing review then picks the mode to run in.
- **Prompting:** the system prompt append asks the agent to enter plan mode and ask, rather than guess, when a request
  is ambiguous, as the CLI does.
- **Safety:** Plan first can't edit, so switching into it on its own never widens what the agent may do.

### 4.4 The composer

- **History:** ↑ and ↓ at the start or end of the text walk the session's sent messages.
- **Attachments:** drag and drop, or an attach button.
  - Images are attached as today: png, jpeg, gif or webp, up to 5 of 5 MB each.
  - Any other file inside the workspace is inserted as `@path`.
- **The queue:**
  - a queued message can be edited or removed;
  - **Send now** interrupts the turn and sends it.

### 4.5 The thread and the status bar

- **Todo panel:** the latest `TodoWrite`, as a checklist pinned above the composer. It's collapsible and shows a
  count, e.g. "3 of 5".
- **Context meter:** the status bar shows the context window in use, from `getContextUsage()` after each turn. It
  warns from 80%.
- **Compaction:** a `compact_boundary` message shows as a divider: "Earlier messages were summarized (N tokens)".

## 5. One thread for tasks (UX-13)

### 5.1 Drafting in the thread

- The request is the first message.
- **Drafting runs as a read-only session**, the same `Session` class as a chat, with:
  - the tools Read, Grep and Glob, and the guard;
  - the same budget, turns and structured output as `draftContract` today.

  Its events stream into the thread with the task tag, so the person sees what it read.
  - **As built:** drafting is still `draftContract`'s one-off query, not a `Session`. Its events are tagged the same
    way.
- **Asking first (UX-24, as built):**
  - **When it asks:** drafting can ask the person once, through `AskUserQuestion` (at most 4 questions, 2–4 options
    each, plus the person's own answer), when the request leaves open a decision that changes the work and the
    repository doesn't answer it.
  - **How the question travels:** it reaches the task page as the question card a step's questions use. It's a
    `permission.request` tagged with the task's draft step, waiting in the sidecar's `DraftQuestions`.
  - **Answer, Skip, stop:**
    - an answer goes back through `permission.respond`;
    - Skip, or stopping the draft, drafts with what it has;
    - a second ask in the same draft is refused.
  - **Where answers go:** they're kept on the task (`clarifications`) and shown on the contract card as "Settled
    with you". A redraft is told them, so it doesn't ask again.
  - **What stays open:** `openQuestions` holds only what's still open after the person answered.
- **Contract card:**
  - It shows the objective, criteria with their check, constraints, out of scope, risks and areas.
  - It's edited in place. A field turns into an input on click; there's no separate form.
  - The contract's open questions show as question cards. Their answers go into the next redraft.
    - **As built:** they stay a list the person edits (owner's choice, UX-24). The questions come before the draft
      instead.
- **Triage card:** the proposed tier with its signals, the budget, and a tier override that asks why.
- **Refining:** a reply in the composer while the task is a draft calls a new `task.redraft {id, feedback}`. It
  re-drafts with the feedback and the current contract, then triages again.
- **Approve & run** sits on the cards. For a tier other than S, it's **Approve**, then **Run**.

### 5.2 The run in the thread

- **Each step streams under a step header:** label, role badge, status, cost and turns.
  - A finished step folds to its header.
  - The headers reuse `withStepEvent`, `fromHistory` and `TranscriptView` (`apps/desktop/src/tasks/run.ts`).
- **Messaging the running step:** while a step runs, the composer targets it ("Message Implement…"). A new
  `task.message {id, text}` sends the text to that step's session. Between steps, the composer is disabled with the
  reason.
- **Approvals and questions are cards** in the thread at the point they happened. The global modal is no longer used
  for tasks. The sidebar marks the task as waiting.
- **Result cards follow in the thread:** gate rounds with their logs, the evidence report, the result and worktree,
  the PR and its checks, the deploy, and XL sub-tasks.

### 5.3 The Task tab

The right panel's **Task** tab holds what the person checks rather than reads:
- the contract summary, tier, budget and spend, and the state;
- the worktree and branch;
- overlaps with other tasks;
- Accept risk…, Revise, Resume and Run again.

### 5.4 Make this a task

- `/task`, or a button on a chat's header, starts a task in the same folder.
- Its drafting gets the chat's transcript as context: the last messages, capped in size.
- The chat stays as it is, and the task opens in a new tab that links back to the chat.

### 5.5 What goes

- `TaskPage.tsx`'s centred form and the task-page CSS.
- The components move to `apps/desktop/src/tasks/thread/`: one file per card, IDE density, and the session's tokens.

## 6. The live and AI-made flow (UX-14)

### 6.1 The Flow tab

- **The run's workflow on the canvas:** the right panel's **Flow** tab shows the workflow the run uses (the tier's,
  the project's, or the task's own), read-only. It reuses `apps/desktop/src/workflows/workflowGraph.ts` and
  `WorkflowCanvas.tsx`.
- **Each node shows its step live:**
  - its status: pending, running with a pulse, done, failed or skipped;
  - its role, cost and turns.

  Status is an icon and a label, never color alone (X-12).
- **Edges are the hand-offs.** A fix loop's edge shows "fix round 1 of 2".
- **An XL run** shows its sub-tasks as nodes with their dependencies, each with its state.
- **Clicking a node** scrolls the thread to that step's header.
- **The data** is the existing `task.updated` run steps; the sidecar doesn't change.

### 6.2 Generate with AI: project workflows

- The workflow editor gets **Generate with AI**: the person describes the flow, e.g. "plan with the architect, then
  implement, then a security review before the gates".
- A new `workflow.generate {cwd, tier, description}` makes one read-only model call with structured output. Its
  prompt gets the workflow schema, the roles and the tier's current workflow.
- The result is checked with `checkWorkflowText` (`packages/sidecar/src/tasks/project-workflows.ts:148`). If it fails,
  it's retried once with the errors.
- The editor shows the result as a diff against the current YAML, to keep or discard. Saving uses the existing path.

### 6.3 Generate with AI: a task's own flow

- **When:** for an M, L or XL task, drafting may also propose a task-specific flow, when the contract suggests one,
  e.g. a migration that wants a test-planner step first.
- **Checks:** it's checked like a project workflow, against the shipped roles and step kinds only. It shows on the
  Flow tab next to the contract.
- **Approving the contract approves the flow.** **Use the tier's flow** drops it.
- **The run** keeps it as its `workflow.json` snapshot, with a ref of `source: "task"` and its hash. Metrics then
  groups it as its own workflow (`packages/sidecar/src/tasks/metrics.ts`, `byWorkflow`).

## 7. Security and privacy

- **Question answers** are the person's text, passed to the tool as input. They're shown in the thread and kept in
  the session like any message.
- **EnterPlanMode** only narrows what the agent may do. Leaving plan mode still needs the person, through
  ExitPlanMode's review or the mode chip.
- **Messages to a running step** go through the same session and guard as the step's own turns.
- **AI-made flows** use only the shipped roles and the existing step kinds. They're validated like a hand-written
  workflow, and never run before a person approves them.
- **THREAT_MODEL** gets these in the steps that build them. Nothing new leaves the computer.

## 8. Testing

- **Unit:**
  - the mode cycle;
  - the slash menu's data and the app commands;
  - question answers to updated input;
  - input history;
  - the thread reducer (drafting, cards, steps, results);
  - `task.redraft` and `task.message` routing;
  - the Flow tab's status mapping;
  - generated workflow validation and its retry.
- **Live, haiku, a few cents:**
  - an AskUserQuestion round trip;
  - an EnterPlanMode switch;
  - a task drafted, refined, run and messaged mid-step from the thread;
  - a generated workflow that passes `workflow.check`.
- **In the app (`pnpm dev` with CDP), light and dark:**
  - Shift+Tab, the slash menu, a question card and the plan banner;
  - a task as a tab, with its thread and its Task and Flow tabs live during a run;
  - Make this a task.

## 9. Delivery (one PR per step)

1. **The chat room (UX-12):**
   - Shift+Tab and the mode chip;
   - slash commands with descriptions, and the app commands;
   - question cards, and plan mode on its own;
   - history, attachments and the queue;
   - the todo panel, context meter and compaction dividers.
2. **Tasks as threads, drafting and the contract (UX-13a):**
   - one New and the Chat | Task switch;
   - tasks as tabs;
   - streamed drafting, the contract and triage cards, and `task.redraft`;
   - the Task tab;
   - Make this a task.
3. **Tasks as threads, the run (UX-13b):** steps in the thread, `task.message`, inline approvals and questions, result
   cards, and TaskPage retired.
4. **The live flow (UX-14a):** the Flow tab.
5. **AI-made flows (UX-14b):** `workflow.generate`, the editor's Generate with AI, and the task's own flow.

Then the M8 fleet view ([workspaces-and-fleet.md](workspaces-and-fleet.md) §10).

## 10. Alternatives considered

- **Keep chats and tasks separate and only add a converter:** set aside by decision 1. The confusion is the two
  entry points, not a missing converter.
- **A task chat beside the TaskPage form:** two places to read the same run. The thread with cards replaces the form.
- **Switching into plan mode only with the person's click:** the CLI's agent enters plan mode itself, and the owner
  asked for the same. It's safe because Plan first can't edit.
- **Generating a flow for every task:** most tasks are S, and the tier's flow fits them. Proposing one only when the
  contract calls for it keeps runs predictable.
