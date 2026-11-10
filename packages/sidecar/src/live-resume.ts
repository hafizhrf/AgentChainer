import type { TaskTag } from "@agentchainer/protocol";

/** What `session.start` with `resume` does about a session the sidecar still runs (M1-36). */
export type LiveResume =
  /** Not running: start it from its stored history. */
  | { kind: "start" }
  /** A plain chat that is still running, e.g. after the window reloaded: hand it back to the tab that asks. */
  | { kind: "attach" }
  /** A task's step or a Team worker: its own tab or task owns it. */
  | { kind: "busy"; task?: string; supervisor?: string };

/**
 * Decides what resuming `live` means. A WebView reload wipes the tabs but not the sidecar's sessions, so a chat the
 * person resumes may still be running: it's re-attached rather than refused. A session a task or a Team runs isn't
 * the person's to take over.
 */
export function liveResume(live: { tag?: TaskTag | undefined; parentId?: string | undefined } | undefined): LiveResume {
  if (!live) return { kind: "start" };
  if (live.tag) return { kind: "busy", task: live.tag.title ?? live.tag.id };
  if (live.parentId) return { kind: "busy", supervisor: live.parentId };
  return { kind: "attach" };
}
