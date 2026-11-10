# ADR-0012: Other agents' CLIs as task-step backends

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** hafizhrf (owner)
- **Related:** M9 (CHECKLIST), PRD §7, [ADR-0002](0002-auth-and-branding.md), [ADR-0003](0003-agent-runtime-and-ipc.md),
  THREAT_MODEL T-19, RISKS R-19 and R-20

## Context

The owner wants AgentChainer to chain more than Claude: Claude plans, the OpenAI Codex CLI implements, Google's
Antigravity CLI (`agy`) reviews, and the other way round. Until now PRD §7 kept "non-Claude models or providers" out
of scope, and M8 turned down other providers' CLIs for that reason.

What the code offers:
- **A task's orchestrator doesn't touch Claude.** It talks to a `Runner` and hands files between steps (`plan.md`,
  `review.json`, the diff, the gate results). Only `sessionRunner.openSession` (`packages/sidecar/src/tasks/runner.ts`)
  creates a Claude `Session`. That makes the workflow step the narrowest seam.
- **Chats, Team supervisors, triage, contracts, splits, lessons and generators** call the Claude Agent SDK directly.
  Team's tools run in an in-process SDK MCP server that only the Claude SDK hosts.
- **The guard** sits in Claude's `PreToolUse` hook, the one place that sees every call (ARCHITECTURE §6). Another CLI
  has no such hook.

What the CLIs offer (research of 2026-11-10; the M9-02 spike checks each point):
- **Codex** (Apache-2.0):
  - `codex app-server` is JSON-RPC over stdio. It asks before running a command or changing a file
    (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`), so the app can answer through its
    guard and approval dialog.
  - `codex exec --json` never asks.
  - `codex login status` reports the sign-in; the CLI owns login.
  - Usage comes as tokens, not dollars.
  - Sources: [app-server](https://learn.chatgpt.com/docs/app-server) and
    [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) **(verify)**.
- **agy** (Antigravity CLI):
  - `agy -p --output-format stream-json` runs headless, with a sandbox flag and resume by conversation id.
  - It never asks: an action that isn't pre-allowed is refused, and the run still exits 0.
  - Pre-approval lives in its settings file.
  - Whether a third-party tool may drive it headless on a personal account is unanswered (R-19).
  - Sources: [headless](https://antigravity.google/docs/cli/headless) **(verify)**.

## Decision

Other agents' CLIs can run **task steps**. Claude stays the default for every step and the only backend for chats,
Team supervisors and the app's own model calls.

1. **Their own binary and login (ADR-0002 holds).**
   - The app finds the user's installed `codex` or `agy`, with a path setting like the Claude CLI's.
   - It runs only their version and sign-in status commands, and keeps an allowlist of fields from them.
   - It never starts, automates or proxies a login, and never reads their credential files. The guard denies those
     files to every agent.
2. **One step backend interface.** `StepSession` (id, turn, inject, close, respond, fleet item) is what the runner
   needs. Claude's `Session` implements it. Each other backend:
   - runs its CLI over stdio, with no network port (ADR-0003);
   - maps the CLI's events onto the app's `AgentEvent`s, so the thread, approvals, evidence and graph work as they
     do for Claude. A command becomes `Bash`, a file change becomes `Edit` or `Write`.
3. **Every write passes the guard.**
   - **Codex** runs through `app-server`. Each command and file change is checked against the guard before it's
     answered, and then goes to the permission profile and the approval dialog as Claude's do. Read steps run in
     Codex's `read-only` sandbox.
   - **agy** asks nothing (owner decision, 2026-11-10: it may still write).
     - **Spike S8 found** (agy 1.5.4) that per-run command rules don't hold: `request-review` refuses every command,
       allowed or not, and `proceed-in-sandbox` runs every command, denied or not. Per-run file rules do hold.
     - **So agy writes files but runs no commands:** `--mode accept-edits --sandbox` with
       `toolPermission: request-review`, through `--settings` (session only), never the user's own settings file.
       The project's gates are run by AgentChainer, as for every agent.
     - **Afterwards,** every path it wrote is checked against the guard and the worktree. A breach fails the step and
       is recorded in the evidence.
     - **Read steps** also get `deny: write_file(*)`.
4. **Cost is an estimate.** Tokens × a pinned price table, labeled as an estimate wherever it shows. A step's cap and
   the task's budget count it like Claude's spend.
   - As built (M9-07): the table is `packages/sidecar/src/backends/prices.ts`, each price with its source and the
     date it applies from. It's the API price, the same kind of number the Agent SDK reports for a Claude
     subscription, so the three agents add up.
   - A model with no price shows its tokens and an unknown cost, and counts $0 toward the budget. The evidence says
     so.
   - Codex reports tokens during a turn, so its turn stops once the estimate passes the step's cap. agy reports them
     only at the end of a turn, so its spend is checked between steps.
   - A step names its model, so it can be priced: Codex's default is `model/list`'s, and agy's is the first model
     `agy models` lists, since agy doesn't report its own default.
5. **Any role on any agent the user has** (owner, 2026-11-10: "gak selalu gitu, bisa diadjust… jadi fleksibel"). No
   pairing is built in.
   - **Examples:**
     - Claude plans, Codex implements, agy reviews;
     - with only Claude and agy: Claude plans and implements, agy reviews;
     - or agy implements and Claude reviews.
   - **Where it's set,** first match wins:
     1. a step's own `agent:` in the workflow YAML;
     2. the task's choice when it's approved: an agent per role on the triage card;
     3. the workspace's defaults per role (planner, implementer, reviewer), in Workspace settings;
     4. Claude.
   - **Only agents that are installed and signed in** are offered.
     - A workflow or default that names a missing one stops the run before it starts.
     - The message says which agent is missing, and offers to run that step on Claude instead.
   - **YAML:** `agent: claude | codex | agy` (default `claude`), and an optional `model`.
   - **Stays Claude:** the split step of XL and the app's own calls.
   - **Evals:** a shipped workflow that names another agent needs a new eval report (M7-03), with an `agent=`
     variant.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|
| Chats on other agents first | The most visible | The chat UI relies on the Claude SDK throughout (modes, rewind, history, commands, context); the largest change | Later (M9-09), once steps prove the backends |
| Team workers first | Claude delegates live, in a chat | The supervisor must stay Claude; worker approvals in tabs; no evidence trail | Second (M9-08); steps first, where gates and evidence check the work |
| Other CLIs as MCP servers inside Claude (e.g. PAL `clink`) | No new runtime | `codex mcp-server` was removed; no per-call approvals; another vendor's tool becomes one opaque call | Loses the guard and the evidence |
| `codex exec --json` instead of `app-server` | Simpler, stable | No approvals, so the guard can't see a command before it runs | Only acceptable for read-only steps; `app-server` is used |
| A model gateway (claude-code-router) | One CLI | Swaps the model behind Claude Code rather than chaining agents; touches auth and keys | Against ADR-0002 |

## Consequences

- **Positive:**
  - Workflows can mix agents: one plans, another implements, a third reviews.
  - The gates and the evidence judge the result whatever agent produced it.
  - The step seam makes ADR-0003's `AgentRuntime` real.
- **Negative:**
  - Two more CLIs to track for drift (`cli-contract.ts`, the weekly job) and two more event formats.
  - Costs for other agents are estimates.
  - agy's writes are checked after the fact, not before (R-20).
  - The app now depends on two more vendors' terms (R-19).
- **Revisit when:**
  - agy gains an approval callback, or its terms rule on third-party use;
  - Codex's `app-server` stops being experimental or changes its protocol;
  - Team workers or chats move to M9-08 and M9-09.

## References

- Research of 2026-11-10 (PR description of M9-01), and the M9-02 spike write-up when it lands.
- [openai/codex](https://github.com/openai/codex), [google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli)
- [codex-plugin-cc](https://github.com/openai/codex-plugin-cc): Codex driven from Claude Code through `app-server`.
