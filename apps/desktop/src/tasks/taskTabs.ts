import type { Task } from "@agentchainer/protocol";

/** A task open as a tab (UX-13), beside the chats; its thread is `TaskPage`. */
export type TaskTab = {
  id: string;
  cwd: string;
  title: string;
  state: Task["state"];
  /** Drafting, splitting or running: the sidebar shows it working. */
  busy: boolean;
  /** Made a moment ago from the composer: drafting starts as soon as the thread opens. */
  autoDraft: boolean;
  model: string;
};

/** The `active` key of a task's tab; session ids are UUIDs, so they can't collide. */
export const taskKey = (id: string) => `task:${id}`;
