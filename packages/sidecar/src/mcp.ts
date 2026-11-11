import {
  hasSecret,
  type McpServer,
  type McpServerDetails,
  type MethodParams,
  RpcErrorCode,
  redactSecrets,
} from "@agentchainer/protocol";
import { forgetMcp, mcpAddFiles, recordCliChange } from "./bootstrap/apply.ts";
import { t } from "./i18n/index.ts";
import { type McpAddSpec, type McpCli, mcpAddArgs } from "./installer.ts";
import { cliError } from "./plugins.ts";
import { RpcFailure } from "./rpc.ts";

/**
 * The MCP servers page (CP-02, ADR-0015): the servers the user's CLI knows for a workspace, and adding, testing and
 * removing them through that CLI. The CLI has no JSON output for MCP, so its text is read here (`claude mcp list`,
 * `claude mcp get`; the format was captured from 2.1.293). Never its config files: `~/.claude.json` holds the
 * account's details. Values of environment variables and headers are dropped while reading, so they never leave the
 * sidecar, and an add only ever passes `${NAME}` references (ADR-0002).
 */

type Scope = "local" | "project" | "user";
type Listing = { servers: McpServer[]; checkedAt: string };

/** How long a status text may be: a failed HTTP server's can quote a whole web page. */
const STATUS_TEXT_MAX = 300;

const cut = (text: string, max = STATUS_TEXT_MAX) => {
  const one = redactSecrets(text.replace(/\s+/g, " ").trim());
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function statusOf(text: string): McpServer["status"] {
  if (/^connected/i.test(text)) return "connected";
  if (/needs auth/i.test(text)) return "needsAuth";
  if (/pending approval/i.test(text)) return "pending";
  if (/^failed/i.test(text)) return "failed";
  return "unknown";
}

function managedByOf(name: string): McpServer["managedBy"] {
  if (name.startsWith("plugin:")) return "plugin";
  if (name.startsWith("claude.ai ")) return "claudeai";
  return undefined;
}

function transportOf(word: string | undefined, target: string, managedBy: McpServer["managedBy"]) {
  const w = word?.toLowerCase();
  if (w === "http" || w === "sse" || w === "stdio") return w;
  if (w) return "other";
  return managedBy === "claudeai" && /^https?:\/\//.test(target) ? "http" : "stdio";
}

/** A status after its icon ("✔ Connected", "! Needs authentication"): the words only. */
const words = (status: string) => status.replace(/^[^\p{L}\p{N}]+/u, "").trim();

/**
 * `claude mcp list`: one line per server, `name: target [(HTTP)] - <icon> <status>`, then the CLI's config
 * diagnostics, whose warnings are attached to their server.
 */
export function parseList(text: string): McpServer[] {
  const servers: McpServer[] = [];
  const warnings = new Map<string, string[]>();
  let diagnostics = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^MCP config diagnostics/i.test(line)) diagnostics = true;
    const w = /\[(?:Warning|Error)\] \[([^\]]+)\] (?:mcpServers\.[^:]+: )?(.+)$/.exec(line);
    if (w?.[1] && w[2]) {
      warnings.set(w[1], [...(warnings.get(w[1]) ?? []), cut(w[2])]);
      continue;
    }
    if (diagnostics) continue;
    const m = /^(\S.*?): (.*) - (\S+ .+)$/.exec(line);
    if (!m?.[1] || m[2] === undefined || !m[3]) continue;
    const name = m[1];
    const managedBy = managedByOf(name);
    const typed = /^(.*?)\s*\((\w+)\)$/.exec(m[2].trim());
    const target = (typed ? typed[1] : m[2]) ?? "";
    const status = words(m[3]);
    servers.push({
      name,
      target: redactSecrets(target.trim()),
      transport: transportOf(typed?.[2], target.trim(), managedBy),
      status: statusOf(status),
      statusText: cut(status),
      ...(managedBy ? { managedBy } : {}),
      warnings: [],
    });
  }
  return servers.map((s) => ({ ...s, warnings: warnings.get(s.name) ?? [] }));
}

/**
 * `claude mcp get <name>`: the name, then `  Key: value` lines, and `Environment:` / `Headers:` sections of indented
 * entries. Of those entries only the names are kept: the values can be secrets.
 */
export function parseGet(text: string): McpServerDetails | null {
  const lines = text.split(/\r?\n/);
  const head = lines.findIndex((l) => /^\S.*:$/.test(l));
  if (head < 0) return null;
  const name = (lines[head] ?? "").slice(0, -1);
  const fields = new Map<string, string>();
  const env: string[] = [];
  const headers: string[] = [];
  let section: "env" | "headers" | null = null;
  for (const line of lines.slice(head + 1)) {
    if (!line.trim()) {
      section = null;
      continue;
    }
    const entry = /^ {4,}(\S.*)$/.exec(line);
    if (entry?.[1] && section) {
      // Only what comes before `=` (a variable) or `:` (a header): the value is never kept.
      const key = section === "env" ? entry[1].split("=")[0] : entry[1].split(":")[0];
      if (key) (section === "env" ? env : headers).push(key.trim());
      continue;
    }
    const field = /^ {2}([A-Za-z][\w ]*):\s*(.*)$/.exec(line);
    if (!field?.[1]) break;
    section = field[1] === "Environment" ? "env" : field[1] === "Headers" ? "headers" : null;
    if (!section) fields.set(field[1], field[2] ?? "");
  }
  const scopeText = fields.get("Scope") ?? "";
  const statusRaw = words(fields.get("Status") ?? "");
  const issue = fields.get("Issue");
  const managedBy = managedByOf(name);
  const url = fields.get("URL");
  const target = url ?? [fields.get("Command"), fields.get("Args")].filter(Boolean).join(" ");
  return {
    name,
    target: redactSecrets(target),
    transport: transportOf(fields.get("Type"), target, managedBy),
    status: statusOf(statusRaw),
    statusText: cut(issue ? `${statusRaw} — ${issue}` : statusRaw),
    ...(managedBy ? { managedBy } : {}),
    warnings: [],
    scope: /^local/i.test(scopeText)
      ? "local"
      : /^project/i.test(scopeText)
        ? "project"
        : /^user/i.test(scopeText)
          ? "user"
          : "other",
    scopeText,
    env,
    headers,
  };
}

/**
 * A command line split into words like a POSIX shell would (quotes keep words together), without running one. A
 * backslash escapes only a quote or a space, so a Windows path keeps its backslashes. Null when a quote isn't closed.
 */
export function splitCommand(line: string): string[] | null {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    const next = line[i + 1] ?? "";
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next === '"') word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && /["'\s]/.test(next)) {
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) out.push(word);
  return out;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** A header value that only refers to a variable, with an optional scheme: `${TOKEN}`, `Bearer ${TOKEN}`. */
const HEADER_REFERENCE = /^(?:[A-Za-z][\w.-]* )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const invalid = (message: string) => new RpcFailure(RpcErrorCode.invalidParams, message);

/**
 * Checks an add request and turns it into the CLI's arguments. Nothing secret may come in: a variable is passed by
 * name, a header's value must refer to one, and a command or URL that looks like it holds a key or token is refused.
 */
export function addSpec(p: MethodParams<"mcp.add">): McpAddSpec {
  const env = [...new Set((p.env ?? []).map((e) => e.trim()).filter(Boolean))];
  const headers = (p.headers ?? []).map((h) => ({ name: h.name.trim(), value: h.value.trim() }));
  const spec: McpAddSpec = {
    name: p.name,
    scope: p.scope,
    transport: p.transport,
    argv: [],
    url: "",
    env: [],
    headers: [],
  };
  if (p.transport === "stdio") {
    if (headers.length) throw invalid(t("mcp.add.headersNeedUrl"));
    const argv = splitCommand(p.command ?? "");
    if (!argv) throw invalid(t("mcp.add.unclosedQuote"));
    if (!argv.length) throw invalid(t("mcp.add.noCommand"));
    if (hasSecret(p.command ?? "")) throw invalid(t("mcp.add.secretInCommand"));
    for (const e of env) if (!ENV_NAME.test(e)) throw invalid(t("mcp.add.badEnvName", { name: e }));
    return { ...spec, argv, env: env.map((e) => `${e}=\${${e}}`) };
  }
  if (env.length) throw invalid(t("mcp.add.envNeedsStdio"));
  let url: URL;
  try {
    url = new URL((p.url ?? "").trim());
  } catch {
    throw invalid(t("mcp.add.badUrl"));
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw invalid(url.protocol === "http:" ? t("mcp.add.httpsOnly") : t("mcp.add.badUrl"));
  }
  if (url.username || url.password || hasSecret(url.href)) throw invalid(t("mcp.add.secretInUrl"));
  for (const h of headers) {
    if (!HEADER_NAME.test(h.name)) throw invalid(t("mcp.add.badHeaderName", { name: h.name }));
    if (!HEADER_REFERENCE.test(h.value)) throw invalid(t("mcp.add.headerNeedsReference", { name: h.name }));
  }
  return { ...spec, url: url.href, headers: headers.map((h) => `${h.name}: ${h.value}`) };
}

/** The listing, kept per workspace for the app session: checking every server takes the CLI a while. */
const listings = new Map<string, Listing>();

export async function listServers(root: string, cli: McpCli, refresh = false): Promise<Listing> {
  const kept = listings.get(root);
  if (kept && !refresh) return kept;
  const res = await cli.list();
  if (!res.ok) throw cliError("claude mcp list", res);
  const fresh = { servers: parseList(res.stdout), checkedAt: new Date().toISOString() };
  listings.set(root, fresh);
  return fresh;
}

/** One server's details and a fresh check of it. The kept listing takes the new status. */
export async function serverDetails(root: string, cli: McpCli, name: string): Promise<McpServerDetails> {
  const res = await cli.get(name);
  if (!res.ok) throw cliError("claude mcp get", res);
  const details = parseGet(res.stdout);
  if (!details) throw new Error(t("mcp.get.unreadable", { name }));
  const kept = listings.get(root);
  if (kept) {
    const { status, statusText, transport, target } = details;
    kept.servers = kept.servers.map((s) =>
      s.name === name ? { ...s, status, statusText, transport, ...(target ? { target } : {}) } : s,
    );
  }
  return details;
}

/**
 * Adds a server through the CLI and records it as a History run, so Roll back removes it. At project scope the run
 * keeps `.mcp.json` as it was, to put back. With `dryRun`, only the command it would run.
 */
export async function addServer(
  root: string,
  cli: McpCli,
  params: MethodParams<"mcp.add">,
  catalogVersion: string,
): Promise<{ command: string[]; runId?: string }> {
  const spec = addSpec(params);
  const command = ["claude", ...mcpAddArgs(spec)];
  if (params.dryRun) return { command };
  const runId = await recordCliChange(
    root,
    {
      id: `mcp:${spec.name}`,
      title: t("mcp.add.title", { name: spec.name }),
      watch: spec.scope === "project" ? [".mcp.json"] : [],
    },
    async () => {
      const res = await cli.add(spec);
      if (!res.ok) throw cliError("claude mcp add", res);
      return { undo: { type: "mcp", name: spec.name, scope: spec.scope }, warnings: [] };
    },
    catalogVersion,
  );
  const kept = listings.get(root);
  if (kept) {
    // Shown at once, unchecked; opening it checks it.
    const added: McpServer = {
      name: spec.name,
      target: redactSecrets(spec.transport === "stdio" ? spec.argv.join(" ") : spec.url),
      transport: spec.transport,
      status: "unknown",
      statusText: "",
      warnings: [],
    };
    kept.servers = [...kept.servers.filter((s) => s.name !== spec.name), added];
  }
  return { command, ...(runId ? { runId } : {}) };
}

/**
 * Removes a server through the CLI. When `.mcp.json` is still as the page's add left it, it goes back to how it was
 * before (the CLI would leave an empty `mcpServers` behind), and History shows the add rolled back.
 */
export async function removeServer(root: string, cli: McpCli, name: string, scope: Scope): Promise<void> {
  const restore = mcpAddFiles(root, name, scope);
  const res = await cli.remove(name, scope);
  if (!res.ok) throw cliError("claude mcp remove", res);
  restore?.();
  forgetMcp(root, name, scope);
  const kept = listings.get(root);
  if (kept) kept.servers = kept.servers.filter((s) => s.name !== name);
}
