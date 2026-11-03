# Design: supervisor and worker sessions (M8-03)

- **Status:** Accepted by the owner, 2026-11-03
- **Covers:** M8-03, a chat that runs worker sessions
- **Source:** [CLI Agent Orchestrator](https://github.com/awslabs/cli-agent-orchestrator)'s supervisor and worker
  model (CAO, Apache-2.0), used as ideas only; no code is copied
- **Builds on:** M8-02's fleet view, UX-12's chat, M3's budgets and read-only sessions

## 1. The problem

A chat can already run subagents through the CLI's own Agent tool, but they're invisible to the person. They have no
tab, take no messages and get no approvals of their own, and they finish inside the chat's turn. For work that
splits into parallel parts, the person wants agents they can watch and talk to, all under one budget. XL tasks
(M3-07) split work too, but by a fixed plan from the contract, with worktrees and a merge.

## 2. Decisions (owner, 2026-11-03)

1. **Results come back both ways.**
   - `handoff` waits for the worker and returns its final answer as the tool's result.
   - `assign` returns at once. The worker's report goes to the supervisor's inbox and is delivered as the
     supervisor's next message once it's idle.
2. **Workers work in the supervisor's folders**: the primary folder and a multi-folder workspace's other folders. The
   supervisor picks the access for each worker:
   - `read`, the default: Read, Grep and Glob, isolated like a task's read step;
   - `write`: the usual tools, with the usual approvals in the worker's own tab.

   There are no worktrees and no merge.
3. **One cap covers the supervisor and all its workers.** An assignment may set a smaller cap for its worker. At the
   cap, the workers are closed and no more reports are delivered.
4. **Team is an opt-in toggle on a new chat.**
   - Workers show as tabs nested under the supervisor, and in the fleet view.
   - XL tasks keep their fixed split, unchanged. A Team chat is for open-ended work; an XL task is for a contract
     with a plan, gates and evidence.

## 3. How it works

```
 Team chat (supervisor)                      sidecar                         workers
 ──────────────────────                      ───────                         ───────
 mcp__agentchainer__assign ───────────────▶ Team.assign ── session.opened ─▶ tab "scan" (read)
   ◀── {workerId} at once                                 ── send(prompt) ─▶ works…
 …ends its turn                                                              turn ends
 ◀── "[From worker "scan" (id)] report" ─── inbox, delivered when idle ◀──── turnEnded(report)
 answers the person
```

- **The tools** come from an in-process MCP server named `agentchainer` (`packages/sidecar/src/team.ts`). It has no
  network and no process of its own.
  - `assign {name, prompt, access?, budgetUsd?, worker?}` starts a worker, or gives an idle one more work.
  - `handoff {…}` does the same, then waits for the report.
  - `send_message {worker, text}` adds to a running turn (`Session.inject`), or starts a turn whose report goes to
    the inbox.
  - `read_inbox {}` returns the reports not yet delivered, once.
  - `list_workers {}` lists each worker's status, access, cost and last report.
  - `close_worker {worker}` frees a place: at most 4 workers are open at once.
- **The supervisor's calls to these tools are allowed without asking.** They only start or message sessions whose own
  tool calls are asked about as usual, and the guard hook runs on every worker.
- **A worker is an ordinary sidecar session.**
  - Its `parentId` is the supervisor's id.
  - Its system prompt adds that it reports to a supervisor and should end with a concise report.
  - It takes the supervisor's model, effort and folders, and gets no Team of its own: one level only.
  - The UI gets `session.opened {sessionId, parentId, cwd, name, access}` before any of the worker's events (stdout
    keeps frame order), so its tab exists first.
  - Every turn end reports, including a turn the person starts by typing in the worker's tab.
- **Inbox delivery:**
  - When the supervisor is idle, every waiting report goes to it in one message, `[From worker "<name>" (<id>)]` and
    the report.
  - The supervisor's transcript gets a `worker.message` event for each, so the UI shows a worker's card rather than a
    message the person typed.
- **The budget:**
  - `session.start {team: true}` needs `maxBudgetUsd`, which caps the supervisor's own session and the team's total.
  - A new worker's cap is the smaller of `budgetUsd` and what's left. No worker starts below $0.05.
  - After every turn end, the supervisor's transcript gets `team.budget {spentUsd, capUsd, stopped}`.
- **Lifetime:**
  - Closing the supervisor closes its workers.
  - Resuming a supervisor gives it a new, empty team.
  - Workers aren't resumed.

## 4. UI (PR 2)

```
 Sidebar                          Composer of a new chat
 ─────────                        ───────────────────────────────────────────
 ▾ Refactor auth   ● working      [ Ask anything…                          ]
     ↳ scan        read  ● idle   [Team ●]  $2.00 cap   Standard ▾  haiku ▾
     ↳ api-tests   write ● waiting
                                  In the supervisor's transcript
                                  ┌ worker  scan · read · idle · $0.02   Open ┐
                                  │ assigned: count the files in src           │
                                  └────────────────────────────────────────────┘
                                  ┌ from scan ─────────────────────────────────┐
                                  │ 12 files, listed below…                    │
                                  └────────────────────────────────────────────┘
```

- **Team toggle:**
  - The composer of a chat that hasn't started has a **Team** toggle. Turning it on fills in the budget cap with the
    Autonomous default, and the cap is required.
  - Once the chat starts, a Team chip shows the shared spend against the cap.
- **Worker tabs:**
  - They open on `session.opened`, without taking focus, nested under the supervisor in the sidebar, with an access
    badge.
  - A write worker's approvals show in its own tab, and the sidebar and fleet show it waiting.
- **Cards in the supervisor's transcript:**
  - Calls to `assign`, `handoff` and `send_message` render as a worker card: name, access, live status, cost, and
    Open.
  - `worker.message` renders as the worker's report.
- **The fleet view:** a row shows "worker of <supervisor>".

## 5. Security

See THREAT_MODEL T-16:
- Spend is bounded by the one cap and at most 4 open workers.
- Every write worker asks in its own tab.
- Text crosses between sessions only as messages: a message grants no tool and changes no mode.
- The MCP server is in-process: no network, no port, no process.

## 6. Verification

- Unit tests:
  - `team.test.ts`: the inbox and delivery, handoff, messages, the 4-worker limit, the shared cap, and a refusal as a
    tool error;
  - `session.test.ts`: app tools allowed without asking, turn ends, and the worker's `parentId`.
- Live: `node packages/sidecar/scripts/spike-host.ts --cwd <empty dir> --scenario team` on haiku, about $0.03. It
  checked that:
  - a Team chat needs a cap;
  - two read workers are opened and announced before their events;
  - both reports reach the supervisor, which answers from them;
  - read workers ask nothing, and the spend stays under the cap;
  - `handoff` returns the worker's answer.
