# ADR-0004: Session data — SDK session APIs are the source of truth; never parse transcript JSONL

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** project owner
- **Related:** [ARCHITECTURE §7](../ARCHITECTURE.md#7-sessions-checkpoints-and-persistence), checklist M1-21…M1-24

## Context

- Claude Code stores transcripts at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The docs state that this format
  is **internal and may change**.
- The TS SDK provides session APIs: `listSessions`, `getSessionMessages`, `forkSession`, `renameSession`, `tagSession` and
  `deleteSession`, plus `resume`, `resumeSessionAt` and `forkSession` options.
- SDK- and `-p`-created sessions do not show up in the CLI's `--continue` picker.
- Retention defaults to 30 days (`cleanupPeriodDays`).

## Decision

- Sessions and transcripts are read and written **only through the SDK**. AgentChainer never parses or writes the JSONL files.
- The app's SQLite DB stores only **metadata that the SDK doesn't**:
  - workspace ↔ session links;
  - cost and usage snapshots per turn;
  - later, task contracts and evidence reports, keyed by session ID.
- Titles and tags use the SDK's rename/tag APIs, so they stay consistent with the CLI.
- The UI shows the retention setting and how to change it (M1-24).

## Consequences

- **Positive:** robust to CLI storage changes; sessions started in the terminal and in the app stay interoperable.
- **Negative:** features need SDK support. Anything the SDK can't do (e.g. full-text search across sessions) has to be
  built from `getSessionMessages` results that we cache ourselves.
- **Revisit when:** the SDK adds a `sessionStore` adapter we want to use, or session APIs change shape.

## References

- Sessions: https://code.claude.com/docs/en/sessions
- Session storage (SDK): https://code.claude.com/docs/en/agent-sdk/session-storage
