import type { ModelOption } from "@agentchainer/protocol";
import { EFFORTS, type Effort, PERMISSION_MODES, type PermissionMode, type SlashCommand } from "@agentchainer/protocol";
import { fuzzyFilter } from "./fuzzy.ts";
import { knownModels, MODE_NAMES } from "./options.ts";
import type { Item } from "./transcript.ts";

/**
 * The chat room's slash commands and keys (UX-12, docs/design/chat-and-tasks.md §4). App commands run in the app;
 * every other command is sent to Claude as text, as typed.
 */

export type AppCommand = "clear" | "model" | "mode" | "effort" | "usage" | "fork" | "task" | "help";

export const APP_COMMANDS: (SlashCommand & { name: AppCommand })[] = [
  { name: "clear", description: "Start a new chat in this folder", argumentHint: "" },
  { name: "model", description: "Pick the model", argumentHint: "" },
  { name: "mode", description: "Pick the permission mode (also Shift+Tab)", argumentHint: "" },
  { name: "effort", description: "Pick the reasoning effort", argumentHint: "" },
  {
    name: "usage",
    description: "This chat's spend, tokens and context window",
    argumentHint: "",
    aliases: ["cost", "stats", "context"],
  },
  { name: "fork", description: "Fork this chat into a new tab", argumentHint: "" },
  {
    name: "task",
    description: "Make a task from this chat: Claude drafts a contract first",
    argumentHint: "<what to do>",
  },
  { name: "help", description: "List the app's commands", argumentHint: "" },
];

/** A command in the `/` menu: the app's or the session's, with what `/` + `name` inserts. */
export type MenuCommand = SlashCommand & { app: boolean };

/**
 * The `/` menu for a query: the app's commands first, then the session's (the CLI's own, the project's, skills),
 * matched on names and aliases. A session command with an app command's name is left out: the app's runs.
 */
export function slashMenu(session: SlashCommand[], query: string): MenuCommand[] {
  const app = new Set<string>(APP_COMMANDS.map((c) => c.name));
  const all: MenuCommand[] = [
    ...APP_COMMANDS.map((c) => ({ ...c, app: true })),
    ...session.filter((c) => !app.has(c.name)).map((c) => ({ ...c, app: false })),
  ];
  const byKey = new Map<string, MenuCommand>();
  for (const c of all) {
    byKey.set(c.name, c);
    for (const a of c.aliases ?? []) if (!byKey.has(a)) byKey.set(a, c);
  }
  const seen = new Set<string>();
  const out: MenuCommand[] = [];
  for (const key of fuzzyFilter(query, [...byKey.keys()], 400)) {
    const c = byKey.get(key);
    if (c && !seen.has(c.name)) {
      seen.add(c.name);
      out.push(c);
    }
  }
  return out;
}

/**
 * `/model sonnet` → `{ name: "model", arg: "sonnet" }`, for app commands or their aliases (`/cost` is `/usage`);
 * anything else goes to Claude.
 */
export function parseAppCommand(text: string): { name: AppCommand; arg: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const word = m?.[1] ?? "";
  const name = APP_COMMANDS.find((c) => c.name === word || c.aliases?.includes(word))?.name;
  return name ? { name, arg: (m?.[2] ?? "").trim() } : null;
}

/** Commands that open a picker or a panel above the composer when typed without an argument. */
export const POPUP_COMMANDS = new Set<AppCommand>(["model", "mode", "effort", "usage", "help"]);

/** The mode a name or id means: "plan", "Plan first", "acceptEdits" and "standard" all work. */
export function modeFromArg(arg: string): PermissionMode | null {
  const a = arg
    .trim()
    .toLowerCase()
    .replace(/\s+first$/, "");
  return (
    PERMISSION_MODES.find((m) => m.toLowerCase() === a || MODE_NAMES[m].toLowerCase().replace(/\s+first$/, "") === a) ??
    null
  );
}

/** A model by its value ("sonnet", "claude-opus-5") or its CLI name ("Opus 5.5"); "default" is the app's "". */
export function modelFromArg(arg: string, models: ModelOption[] = knownModels()): string | null {
  const a = arg.trim().toLowerCase();
  if (a === "default") return "";
  const m = models.find((x) => x.value.toLowerCase() === a || x.displayName.toLowerCase() === a);
  if (m) return m.value === "default" ? "" : m.value;
  return /^claude-[a-z0-9-]+$/.test(a) ? a : null;
}

export function effortFromArg(arg: string): Effort | null | undefined {
  const a = arg.trim().toLowerCase();
  if (a === "default") return null;
  return EFFORTS.find((e) => e === a);
}

/** The order Shift+Tab walks, like the CLI's: Safe → Standard → Plan first → Autonomous (only with a budget cap). */
export function nextMode(mode: PermissionMode, canAutonomous: boolean): PermissionMode {
  const cycle: PermissionMode[] = ["default", "acceptEdits", "plan", ...(canAutonomous ? ["auto" as const] : [])];
  const i = cycle.indexOf(mode);
  return cycle[(i + 1) % cycle.length] ?? "default";
}

/** The person's sent messages, oldest first, for ↑/↓ in the composer. */
export function sentMessages(items: Item[]): string[] {
  const out: string[] = [];
  for (const i of items) if (i.kind === "user" && i.text.trim() && out.at(-1) !== i.text) out.push(i.text);
  return out;
}

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

/** The main agent's latest todo list (its last `TodoWrite`), or null when it has none. */
export function latestTodos(items: Item[]): Todo[] | null {
  for (let k = items.length - 1; k >= 0; k--) {
    const i = items[k];
    if (i?.kind !== "tool" || i.name !== "TodoWrite") continue;
    const todos = (i.input as { todos?: unknown } | null)?.todos;
    if (!Array.isArray(todos)) return null;
    return todos.filter(
      (t): t is Todo => typeof t?.content === "string" && ["pending", "in_progress", "completed"].includes(t?.status),
    );
  }
  return null;
}

/** `@src/a.ts` for a file in the workspace, `@C:/elsewhere/b.png` for one outside it; quoted when it has spaces. */
export function mention(cwd: string, path: string): string {
  const norm = (p: string) => p.replaceAll("\\", "/");
  const root = norm(cwd).replace(/\/$/, "");
  const p = norm(path);
  const same = p.toLowerCase().startsWith(`${root.toLowerCase()}/`);
  const rel = same ? p.slice(root.length + 1) : p;
  return rel.includes(" ") ? `@"${rel}"` : `@${rel}`;
}

/**
 * The chat a task is made from (UX-13), for its drafting: the last messages, newest kept, as "you:" and "Claude:"
 * lines, at most `max` characters.
 */
export function chatContext(items: Item[], max = 12_000): string {
  const lines: string[] = [];
  for (const i of items) {
    if (i.kind === "user" && i.text.trim()) lines.push(`you: ${i.text.trim()}`);
    else if (i.kind === "assistant" && i.text.trim()) lines.push(`Claude: ${i.text.trim()}`);
  }
  const out: string[] = [];
  let size = 0;
  for (const line of lines.reverse()) {
    const cut = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
    if (size + cut.length + 1 > max) break;
    out.unshift(cut);
    size += cut.length + 1;
  }
  return out.join("\n");
}
