# Design: agent observability (M4)

- **Status:** Approved (2026-10-31). The owner made three decisions and left the other four to the implementer (§17).
- **Date:** 2026-10-31
- **Covers:** M4-01…M4-08 and the exit criteria M4-E1/E2. Scope source: PRD [F4](../PRD.md#f4--agent-observability-p1).
- **Builds on:**
  - subagent cards in the chat (M1-12) and the attribution found in [spike S4](../spikes/S4-S5-S6.md);
  - normalized events (ARCHITECTURE §5.2) and the recorded fixtures they are tested against;
  - stored sessions read through the SDK only ([ADR-0004](../adr/0004-session-data.md));
  - foreground-only subagents for now ([#43](https://github.com/hafizhrf/AgentChainer/pull/43)), which M4-07 lifts.

## 1. What problem this solves

A session with subagents is hard to follow today:

- **Nesting isn't modelled.** `transcript.ts` keeps one level of `AgentItem`. A subagent that spawns its own subagent
  is never shown as such: `hasAgent`/`updateAgent` only scan top-level items.
- **There's no picture of the work.** Parallel subagents appear as cards one under another. You can't see what ran
  at the same time, what waited (for an approval, for another agent), or which branch is still busy.
- **Cost per agent is invisible.** The session has a total. A card shows tokens and duration only once the subagent
  ends, and nothing while it runs.
- **There's no control below the session.** Esc interrupts everything. You can't stop one runaway subagent.
- **History loses it.** A reopened session shows a subagent as its Agent tool call only (`stored-sessions.ts`
  `historyEvents`), with no tree, timing or tokens.

F4 adds a live agent tree, a graph and a timeline of it, a drawer per agent, per-agent stop, replay of finished
sessions, background work, and a manager for the project's agent definitions.

## 2. The user's flow

1. A session runs. In the session header, **Chat | Graph | Timeline** switches the centre view. Chat stays the
   default.
2. **Graph** shows the main agent, each subagent as a node under its parent, and the key tool calls. Live status shows
   on each node: running with its current tool, waiting for an approval, done, failed, or stopped. Tokens and ≈USD are
   shown too.
3. Clicking a node opens its **drawer** in the right panel. The drawer shows the subagent's prompt, its transcript so
   far, its tool calls, tokens and ≈USD, and a **Stop this agent** button.
4. **Timeline** shows one bar per agent on a shared time axis, so you can see parallel work and waiting.
5. A finished session opened from history shows the same Graph (**replay**), rebuilt from the stored transcripts.
6. Background agents and shells (M4-07) appear in the same tree with a "background" mark. A small panel lists the
   ones still running, each with Stop.

## 3. Agent tree store (M4-01)

**Node identity.**
- A node is one subagent run, keyed like the cards today: by the spawning Agent call's `tool_use_id`
  (ARCHITECTURE §5.2).
- It also keeps the SDK's `task_id`, `run_id` (a resumed task gets a new run) and `agent_id`.
- The main agent is the root.

**Parent.**
- The parent comes from `parent_task_id` on `task_started`, which the sidecar drops today.
- When that's missing, it comes from the spawning call's `parentToolUseId`. That covers CLIs that predate the field
  and depth-1 subagents.

**What each node tracks:**
- description, `subagent_type`, the prompt (`task_started.prompt`, when sent) and depth;
- status: pending, running, waiting for approval, done, failed, stopped, killed or paused (`task_updated.patch.status`);
- the current tool: `task_progress.last_tool_name`, or the latest `tool.started` attributed to the agent;
- start, end and paused time: the first event, `task_updated.end_time` and `total_paused_ms`;
- tokens, tool uses and duration: from `task_progress.usage` while it runs and `task_notification.usage` at the end;
- ≈USD (§11);
- its tool calls and text, as today's card children.

**Protocol changes** (`packages/protocol`; the JSON Schema is regenerated):
- `agent.started` gains `parentTaskId?`, `runId?` and `prompt?`.
- New `agent.progress {toolUseId?, taskId, runId?, tokens, toolUses, durationMs, lastTool?, summary?}` from
  `task_progress`.
- New `agent.updated {taskId, runId?, status?, endTime?, pausedMs?, error?, background?}` from `task_updated`.
- `agent.completed` gains `reason?` and keeps `status` as the SDK's (completed, failed or stopped).

**Where it lives.**
- The sidecar stays a pure mapper (`normalize.ts`).
- The tree is the transcript itself: `transcript.ts` nests a subagent's `AgentItem` under its parent's card and keeps
  the fields above on it, so the chat cards and the graph read one model. The graph and timeline get their nodes from
  a pure selector over those items, added with step 2.
- An agent whose spawning call wasn't seen goes under its parent task (`parentTaskId`), else at the top level.
  `agent.updated` finds its agent by `taskId`; ids with no agent (shells, monitors) are ignored.

**Tests:**
- the reducer, replaying `subagents-parallel.jsonl`;
- new recorded fixtures for nesting, progress, stop and background, made with `make-fixture.ts`.

## 4. Graph (M4-02)

- **Library:** `@xyflow/react` (MIT, already named in ADR-0001 and ADR-0006).
- **Layout:** top-down, with `@dagrejs/dagre` (MIT; §17). The layout is recomputed only when the tree's structure
  changes, not on every progress event.
- **Nodes:**
  - one per agent;
  - for tools, only the key calls: a spawn, an edit or write, a failed call, and any call running longer than 10 s
    or waiting for an approval.
  - The other tools of an agent fold into a count on its node ("12 tools"), which expands on click.
  - Above 200 nodes, completed subtrees fold first.
- **Edges:** a spawn from parent to child. Hand-offs, such as a result returned to the parent, show as the child's
  completion on the edge, not as extra edges.
- **Performance (E2):** 60 fps with 200 nodes on the slowest supported WebView (WebKitGTK on Ubuntu). This uses
  memoized custom nodes, `onlyRenderVisibleElements`, and status updates that patch node data without a re-layout.
  A synthetic 200-node scene is measured in the app.

## 5. Node drawer (M4-03)

- **Prompt:** `task_started.prompt`, when the CLI sends it.
- **Transcript:**
  - live: the agent's text and tool calls from the events the app already receives (`forwardSubagentText`);
  - after the fact: `getSubagentMessages(sessionId, agentId)` through a new request `session.subagentMessages`,
    which comes with replay (§9; step 2 shipped the live drawer only);
  - both through SDK APIs only (ADR-0004).
- **Tool calls:** with their results, the same views as in the chat.
- **Tokens and ≈USD:** §11.
- **Stop this agent:** M4-05.

## 6. Timeline (M4-04)

- One row per agent, ordered by start, indented by depth.
- Each bar is drawn from start to end. Paused spans and **waiting for an approval** are drawn differently; the waits
  come from `permission.request` up to its answer, per `agentId`.
- Live: the right edge follows the clock. Done: the axis fits the session.
- **Replay has no timeline durations.** Stored `SessionMessage`s carry no timestamps (`sdk.d.ts`
  `SessionMessage`), so a reopened session shows order, not time. The timeline says so instead of guessing.

## 7. Controls (M4-05)

- **Stop this agent:** `Query.stopTask(taskId)` through a new request `session.stopAgent`. The SDK then sends
  `task_notification` with status `stopped`, and the tree marks the node.
- **Interrupt** (Esc and Stop) still ends the whole turn.
- `perTaskStopAffordance` stays off until M4-07. With it on, an interrupt spares background agents, which only makes
  sense once the app shows them.

## 8. Background tasks (M4-07)

This is the largest runtime change in M4, so it ships after the read-only views:

- Remove `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` from `foregroundOnly()`.
- Map `background_tasks_changed` (a level signal: replace the set on every message) to `session.background`. The
  session shows as **busy** while that set isn't empty, even between turns.
- **Each background task** gets a Stop button (`stopTask`). Shells and Monitor tasks also get their output tail
  (`getTaskOutput`).
- `perTaskStopAffordance: true`, because the app now offers a per-task Stop.
- **M3 task steps** wait for the step's background tasks to settle before the gates run, so gates never test
  half-done work.
- **Tests:** a recorded CLI 2.1.314 fixture with a backgrounded subagent and shell; the M1 exit run (E5) passes with
  background on.
- **THREAT_MODEL:** background work outlives a turn. It is bounded by the session's budget, and the app stops it when
  the session closes.

## 9. Replay (M4-08)

- Rebuild the tree of a stored session as follows:
  1. `getSessionMessages` gives the main chain;
  2. `listSubagents(sessionId)` lists the subagent transcripts;
  3. `getSubagentMessages` reads each one;
  4. `parent_agent_id` and `parent_tool_use_id` on `SessionMessage` place each subagent under its parent.
- A new mapper turns these into the same events the live path emits, so one reducer serves both. It sits next to
  `historyEvents`, which stays for the chat.
- No timing or token totals are stored with the messages **(verify: whether tool results carry usage)**. Replay shows
  structure, status, tools and text.

## 10. Agent library (M4-06)

- List the agent definitions in `.claude/agents/*.md` (project) and `~/.claude/agents` (user, read-only), plus the
  app's own `ac-*` roles (M3-05).
- **Create, edit and delete** project agents, with front matter checked against the format the M3 roles already
  render (`agents/ac-*.md`). Writes go through the same backup and rollback as setup apply (M2).
- **Manual or auto-spawned:** an agent whose description invites automatic use ("use proactively") is marked
  auto-spawned, and the others manual. The user can change it, which rewrites that wording.

## 11. Cost per agent

- **Tokens are the SDK's own:** `usage.total_tokens` on `task_progress` and `task_notification`.
- **≈USD is the app's estimate:** the agent's tokens × the session's own cost per token so far (`total_cost_usd`
  divided by every token the session reported, cache reads and writes included; `tabs.ts` `agentUsd`).
  - The input/output split isn't reported per task, so a blended rate is the best available. Taking it from the
    session's own totals builds in caching and the models actually used, and needs no price table to keep current.
  - A subagent on a cheaper model than the main agent is overestimated, and the other way round; the label says
    "estimate" and the drawer explains how it's made.
  - The session total stays the SDK's `total_cost_usd`. The agents' estimates don't have to add up to it (caching,
    the main agent's own turns), and the UI says so next to the total.

## 12. UI

- **Chat | Graph | Timeline** is a segmented control in the session header. The choice is kept per session.
- The drawer uses the right panel. Like a file's diff, it covers the tabs while a node is selected and closes with
  its × or Esc, which closes the drawer before it would interrupt the turn. Changes, Files and Git stay.
- **Light and dark:** status colours come from the existing tokens (`--ok`, `--warn`, `--err`, `--accent`).
- **Keyboard** (X-12): arrows move between nodes, Enter opens the drawer, Esc closes it.
- **Empty states:** "No subagents in this session yet" in the graph; replay explains when transcripts were cleaned up
  by `cleanupPeriodDays`.

## 13. Security and privacy

- Transcripts are read through SDK APIs only; the app never parses `~/.claude/projects` itself (ADR-0004).
- No new network calls. The price table ships with the app.
- Prompts and transcripts can contain secrets the agent read. They are shown as the agent saw them (T-08, as today),
  and diagnostics bundles never include them (X-03).
- Stop and background control act only on the app's own sessions.
- THREAT_MODEL gets a background-work entry with M4-07 (§8).

## 14. Testing

- **Reducer and mappers:** against recorded fixtures (live) and stored-session fixtures (replay), with snapshot
  files as in `normalize.test.ts`.
- **New fixtures** via `make-fixture.ts`:
  - nested subagents;
  - `task_progress` and `task_updated`;
  - a stopped subagent;
  - a backgrounded subagent and shell (CLI 2.1.314).
- **E1:** a live session with ≥3 parallel subagents renders correctly, then again on replay. This is checked in the
  app (WebView2 remote debugging on Windows, as for M1) and with `spike-host` for the events.
- **E2:** the synthetic 200-node scene, with frame times measured in the app on each OS.

## 15. Delivery

One PR per step, each merged before the next starts:

1. **Tree store and protocol:** the new events, the reducer, nested cards in the chat, and the fixtures.
2. **Graph, drawer and Stop this agent:** the session view switch, plus the layout dependency once §17's licence
   question is decided.
3. **Timeline.**
4. **Replay.**
5. **Background tasks** (M4-07), with the THREAT_MODEL update.
6. **Agent library** (M4-06).

## 16. Alternatives considered

| Option | Why not |
|---|---|
| Graph as a right-panel tab | Too narrow for 200 nodes and for a timeline; the owner chose a session view (§17) |
| Graph on its own page | Separates it from the chat it explains |
| elkjs for layout | Better layouts, but EPL-2.0 **(verify)**, while ADR-0006 lists only permissive libraries (§17) |
| `SubagentStart`/`SubagentStop` hooks | `task_*` messages already carry everything, and S4 found the hooks add nothing |
| Reading transcript JSONL files directly | ADR-0004: SDK session APIs only |
| Tokens only, no ≈USD | Hides which agent is expensive; the owner chose an estimate (§17) |
| Background tasks first | Biggest runtime risk; the read-only views come first and make it visible when it lands |

## 17. Decisions

**Decided** (owner, 2026-10-31):
1. **Where:** a session view, **Chat | Graph | Timeline**, with the node drawer in the right panel.
2. **Cost per agent:** tokens plus an ≈USD estimate, always labelled; the session total stays the SDK's.
3. **Order:** tree store, then graph, drawer and stop, then timeline, replay, background tasks, and the library.

**Decided** (by the implementer, as the owner asked, 2026-10-31):
4. **Layout library:** dagre (MIT). It fits ADR-0006 as it stands; elkjs would need an ADR for its EPL-2.0 licence
   **(verify)**, and a tree of agents doesn't need its layered routing.
5. **Folding:** 10 s for a long tool call and 200 nodes before completed subtrees fold. Both are named constants, tuned
   after the E1 run on real sessions.
6. **Price source:** none. The estimate uses the session's own cost per token (§11) instead of a price table, so
   there are no prices to copy, verify or keep current.
7. **Background timing:** M4-07 stays fifth. #43 keeps the CLI in the foreground until then, and the read-only views
   come first so background work is visible when it lands.
