import type { AgentEvent, SessionInfo } from "@agentchainer/protocol";
import type { Cli } from "../deploy/cli.ts";
import { t } from "../i18n/index.ts";
import { type Ask, withAppServer } from "./app-server.ts";
import { type CodexItem, itemCompleted, itemStarted } from "./codex-events.ts";

/**
 * A folder's Codex threads and their conversations (M9-09), from Codex's own app-server (`thread/list`,
 * `thread/turns/list`): what Previous sessions lists beside Claude's, and what a Codex chat shows before it's resumed.
 * Codex keeps them; the app reads them through its protocol, never its files (as ADR-0004 does for Claude).
 */

/** Every kind of thread a person starts, the app's own app-server threads included. */
const SOURCES = ["cli", "vscode", "exec", "appServer"];

type Thread = { id?: unknown; name?: unknown; preview?: unknown; createdAt?: unknown; updatedAt?: unknown };

export function threadInfo(th: Thread): SessionInfo | null {
  if (typeof th.id !== "string") return null;
  const preview = typeof th.preview === "string" ? th.preview.split("\n")[0]?.trim() : "";
  const title = (typeof th.name === "string" && th.name.trim()) || preview || t("rpc.session.untitled");
  const seconds = (v: unknown) => (typeof v === "number" ? v * 1000 : undefined);
  const updated = seconds(th.updatedAt) ?? seconds(th.createdAt) ?? 0;
  const created = seconds(th.createdAt);
  return {
    sessionId: th.id,
    title: title.slice(0, 200),
    lastModified: updated,
    ...(created !== undefined ? { createdAt: created } : {}),
    agent: "codex",
  };
}

export async function codexThreads(cli: Cli, cwd: string, limit: number): Promise<SessionInfo[]> {
  return withAppServer(cli, undefined, async (ask) => {
    const r = await ask("thread/list", {
      cwd,
      limit,
      sortKey: "updated_at",
      sourceKinds: SOURCES,
      useStateDbOnly: true,
    });
    const data = (r.result as { data?: Thread[] } | undefined)?.data ?? [];
    return data.map(threadInfo).filter((s): s is SessionInfo => s !== null);
  });
}

/** One turn's items as the events a live Codex session emits, the person's message first. */
export function turnEvents(items: readonly Record<string, unknown>[]): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const item of items) {
    if (item.type === "userMessage") {
      const content = Array.isArray(item.content) ? (item.content as { type?: unknown; text?: unknown }[]) : [];
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
      if (text.trim()) out.push({ type: "user.message", messageId: String(item.id ?? ""), text });
    } else if (item.type === "agentMessage" && typeof item.text === "string" && item.text) {
      out.push({ type: "text.delta", text: item.text });
    } else if (typeof item.id === "string") {
      const it = item as CodexItem;
      out.push(...itemStarted(it), ...itemCompleted(it));
    }
  }
  return out;
}

/** A thread's conversation, oldest turn first, a page at a time. */
export async function codexThreadEvents(cli: Cli, threadId: string): Promise<AgentEvent[]> {
  return withAppServer(cli, undefined, async (ask: Ask) => {
    const events: AgentEvent[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const r = await ask("thread/turns/list", {
        threadId,
        itemsView: "full",
        limit: 50,
        sortDirection: "asc",
        ...(cursor ? { cursor } : {}),
      });
      if (r.error) throw new Error(r.error.message ?? "thread/turns/list failed");
      const result = r.result as { data?: { items?: Record<string, unknown>[] }[]; nextCursor?: unknown } | undefined;
      for (const turn of result?.data ?? []) events.push(...turnEvents(turn.items ?? []));
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    return events;
  });
}
