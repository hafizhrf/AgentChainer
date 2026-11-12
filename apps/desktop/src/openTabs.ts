import type { PermissionMode, StepAgent } from "@agentchainer/protocol";
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n/index.ts";
import { isFresh, newTab, type Tab } from "./tabs.ts";
import { type TaskTab, taskKey } from "./tasks/taskTabs.ts";
import { type Item, nextId } from "./transcript.ts";

/**
 * The tabs open when the app last closed (CP-09), as the Rust core keeps them in `open-tabs.json` (`open_tabs.rs`):
 * enough to resume each chat and reopen each task, and whether a chat's turn was still running.
 */
export type OpenTabs = {
  version: number;
  active?: string;
  chats: OpenChat[];
  tasks: OpenTask[];
};

export type OpenChat = {
  sessionId: string;
  cwd: string;
  title: string;
  agent?: "codex" | "agy";
  folders?: string[];
  profile?: string;
  modelAlias: string;
  kind?: "chat" | "task";
  wasRunning: boolean;
};

export type OpenTask = { id: string; cwd: string; title: string; model: string };

export const loadOpenTabs = () => invoke<OpenTabs>("open_tabs_get");
export const saveOpenTabs = (tabs: OpenTabs) => invoke<void>("open_tabs_set", { tabs });

/**
 * What to remember of the open tabs. Left out: chats with nothing sent (a new chat is one click away), and a Team
 * chat's workers, whose Team ends with the app (M8-03); the supervisor comes back as its chat.
 */
export function snapshot(tabs: readonly Tab[], taskTabs: readonly TaskTab[], active: string | null): OpenTabs {
  const chats = tabs
    .filter((tab) => !tab.parentId && !isFresh(tab))
    .map(
      (tab): OpenChat => ({
        sessionId: tab.sessionId,
        cwd: tab.cwd,
        title: tab.title,
        ...(tab.agent && tab.agent !== "claude" ? { agent: tab.agent } : {}),
        ...(tab.folders?.length ? { folders: tab.folders } : {}),
        ...(tab.profile ? { profile: tab.profile } : {}),
        modelAlias: tab.modelAlias,
        ...(tab.kind ? { kind: tab.kind } : {}),
        // A turn, background work, or a restored chat whose cut-off turn nobody has continued yet.
        wasRunning: tab.running || tab.background.length > 0 || Boolean(tab.cutOff),
      }),
    );
  const tasks = taskTabs.map((task) => ({ id: task.id, cwd: task.cwd, title: task.title, model: task.model }));
  return { version: 1, ...(active ? { active } : {}), chats, tasks };
}

/**
 * The chats as tabs again, each ended until it's opened (`restored`): only then is it resumed, so a restart starts
 * no CLI for tabs nobody looks at. A chat whose turn was running when the app closed is `cutOff`.
 */
export function restoredTabs(saved: OpenTabs, mode: PermissionMode): Tab[] {
  return saved.chats.map((chat) => {
    const items: Item[] = [{ kind: "notice", id: nextId(), text: t("app.restore.reopened") }];
    const tab = newTab(chat.sessionId, chat.cwd, {
      title: chat.title || t("app.session.newTitle"),
      mode,
      items,
      resumed: true,
      modelAlias: chat.modelAlias,
      ...(chat.folders?.length ? { folders: chat.folders } : {}),
      ...(chat.profile ? { profile: chat.profile } : {}),
      ...(chat.agent ? { agent: chat.agent as StepAgent } : {}),
    });
    return {
      ...tab,
      ...(chat.kind ? { kind: chat.kind } : {}),
      ended: true,
      restored: true,
      ...(chat.wasRunning ? { cutOff: true } : {}),
    };
  });
}

/** The tasks' tabs again; each task page reads its task, and a run the app's closing cut off shows Resume. */
export function restoredTasks(saved: OpenTabs): TaskTab[] {
  return saved.tasks.map((task) => ({
    id: task.id,
    cwd: task.cwd,
    title: task.title || t("app.task.defaultTitle"),
    state: "draft",
    busy: false,
    autoDraft: false,
    model: task.model,
  }));
}

/** The tab to show: the one that was, if it came back (or is one of `pages`), else Home. */
export function restoredActive(saved: OpenTabs, pages: readonly string[]): string | null {
  const a = saved.active;
  if (!a) return null;
  const known =
    pages.includes(a) ||
    saved.chats.some((c) => c.sessionId === a) ||
    saved.tasks.some((task) => taskKey(task.id) === a);
  return known ? a : null;
}

/** Adds what was restored to what's already open (a reload's live chats, M1-36), which wins. */
export function mergeOpen<T>(open: readonly T[], restored: readonly T[], key: (x: T) => string): T[] {
  const have = new Set(open.map(key));
  return [...open, ...restored.filter((x) => !have.has(key(x)))];
}
