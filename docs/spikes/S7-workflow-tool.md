# Spike S7 — The SDK's Workflow tool as an XL executor

- **Date:** 2026-10-30
- **Checklist:** M3-07 (evaluate the SDK `Workflow` tool where the user's plan supports it)
- **Setup:**
  - macOS 26.5 (x86_64), Node 24.18.0, Claude Code CLI 2.1.293 (user install), Agent SDK 0.3.311, model `haiku`.
  - An empty scratch workspace; nothing from it is in this repo.

## Question

Can XL tasks (planner.md §8) run on the CLI's `Workflow` tool instead of AgentChainer's own orchestration? If not,
how does the tool relate to a task's steps?

## What the SDK says

From the installed SDK's types (`sdk.d.ts`, 0.3.311):
- `Workflow` is one of the CLI's built-in tools (`BUILTIN_TOOL_NAMES`). A session's tools are listed in its
  `system/init` message.
- Settings:
  - `enableWorkflows` turns it on or off per user; unset means "default by plan once the feature is available";
  - `disableWorkflows` and `CLAUDE_CODE_DISABLE_WORKFLOWS` turn it off, also through managed settings;
  - `workflowSizeGuideline` is an advisory agent count (small < 5, medium < 10, large < 50, or unrestricted);
  - `workflowKeywordTriggerEnabled` controls the `ultracode` keyword, which opts a turn into the tool.
- Cost: a result's `modelUsage` includes Workflow agents' calls.

## Probe

A one-turn haiku session ("Reply with the single word OK."), loading the user, project and local settings like a
task's write steps do, and reading `system/init`. It cost ≈$0.006.

| Check | Result |
|---|---|
| Tools in the session | 43 |
| `Workflow` among them | **Yes**, on the owner's account with default settings |

Availability depends on the account's plan and on settings. Another account, or managed settings, can turn it off.

## Decision

**Not the XL executor.** AgentChainer keeps its own orchestration (`tasks/xl.ts`): a split into sub-tasks the user
approves, worktrees, the app's own gates, merges and evidence. The Workflow tool runs agents inside one session, so:
- the gates would run inside the model's loop, not by the app. That's what planner §14 rejects ("evidence over
  claims");
- each sub-task's contract, approval, budget, transcript and report would blur into one session;
- availability varies by plan and settings, and XL must work for every account.

**Inside a step it stays available.** Write steps load the user's settings, so Claude can use `Workflow` like any
other tool where the account has it. A call shows up in the step's transcript and in its approvals like any tool call,
and its spend counts toward the step's budget through `modelUsage`. Read steps (planners, reviewer, split) use only
Read, Grep and Glob, so it can't run there.

**Revisit** if the tool gains hooks for an external gate runner, or per-agent budgets and transcripts that the app
can read through the SDK.
