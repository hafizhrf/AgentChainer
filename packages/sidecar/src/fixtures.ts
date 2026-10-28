import { homedir, userInfo } from "node:os";

/**
 * Turns raw SDK messages recorded on a developer machine into a fixture that is safe to commit to a public repo.
 * Spike S4 found the user's name in *encoded* project paths (e.g. `-Users-jane-doe-…`), so plain path replacement
 * is not enough.
 */

/** Message kinds the normalizer cares about. Everything else is dropped: hook output, rate limits, status… */
const KEEP_TYPES = new Set(["assistant", "user", "result", "stream_event"]);
const KEEP_SYSTEM = new Set(["init", "task_started", "task_progress", "task_updated", "task_notification", "compact_boundary"]);

/** Fields of the init message that describe the recording machine rather than the session. */
const INIT_INVENTORY = ["tools", "mcp_servers", "slash_commands", "terminal_slash_commands", "skills", "plugins", "agents", "plugin_errors", "betas"];
const INIT_LOCAL_PATHS = ["memory_paths", "scratchpad_path"];

/** Claude Code encodes a path into a directory name by replacing every non-alphanumeric character with "-". */
export const encodePath = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

export type Identity = { cwd: string; home: string; username: string };

export function localIdentity(cwd: string): Identity {
  return { cwd, home: homedir(), username: userInfo().username };
}

export function sanitizeForFixture(message: unknown, id: Identity): Record<string, unknown> | null {
  const m = message as Record<string, unknown>;
  const type = String(m.type);
  if (type === "system" ? !KEEP_SYSTEM.has(String(m.subtype)) : !KEEP_TYPES.has(type)) return null;

  let json = JSON.stringify(m);
  const replacements: [string, string][] = [
    [id.cwd, "/workspace"],
    [encodePath(id.cwd), "-workspace"],
    [id.home, "/home/user"],
    [encodePath(id.home), "-home-user"],
    [id.username, "user"],
    [encodePath(id.username), "user"],
  ];
  for (const [from, to] of replacements) if (from.length > 2) json = json.split(from).join(to);

  const obj = JSON.parse(json) as Record<string, unknown>;
  if (obj.type === "system" && obj.subtype === "init") {
    for (const key of INIT_INVENTORY) if (key in obj) obj[key] = [];
    for (const key of INIT_LOCAL_PATHS) if (key in obj) obj[key] = "<redacted>";
  }
  return obj;
}

/** Returns the identity strings still present in `text`; a committed fixture must return []. */
export function leaks(text: string, id: Identity): string[] {
  return [id.home, encodePath(id.home), id.username, encodePath(id.username)].filter((s) => s.length > 2 && text.includes(s));
}
