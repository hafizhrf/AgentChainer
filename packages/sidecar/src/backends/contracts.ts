import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * What the Codex backend (backends/codex.ts) relies on in `codex app-server`'s protocol (M9-04, X-05): the methods it
 * sends and answers, and the values and fields it reads. `codex app-server generate-json-schema --out <dir>` writes
 * the protocol's JSON Schema with no login and no model calls; `codexContractProblems` checks a folder of it. The
 * weekly drift job runs that against the newest Codex CLI (scripts/cli-contract.ts --codex <path>).
 */
export const CODEX_CONTRACT = {
  /** Requests the app sends, in `ClientRequest.json`. */
  clientRequests: [
    "initialize",
    "model/list",
    "thread/start",
    "thread/resume",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    // The usage page (CP-01): the account's daily tokens and the plan's quota.
    "account/usage/read",
    "account/rateLimits/read",
  ],
  /** In `ClientNotification.json`. */
  clientNotifications: ["initialized"],
  /** Notifications it reads, in `ServerNotification.json`. */
  serverNotifications: [
    "error",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "thread/tokenUsage/updated",
    "turn/started",
    "turn/completed",
  ],
  /** Requests it answers, in `ServerRequest.json`: approvals, and MCP elicitations it declines. */
  serverRequests: [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "mcpServer/elicitation/request",
  ],
  /** Words each definition must still have: enum values it sends or reads, and fields it reads. */
  definitions: {
    SandboxMode: ["read-only", "workspace-write"],
    AskForApproval: ["never", "untrusted"],
    ThreadStartParams: ["cwd", "sandbox", "approvalPolicy", "model", "developerInstructions"],
    ThreadResumeParams: ["threadId", "excludeTurns"],
    TurnStartParams: ["threadId", "input"],
    TurnInterruptParams: ["threadId", "turnId"],
    ModelListResponse: ["data", "id", "isDefault"],
    ThreadItem: [
      "agentMessage",
      "commandExecution",
      "fileChange",
      "webSearch",
      "text",
      "command",
      "commandActions",
      "exitCode",
      "aggregatedOutput",
      "changes",
      "path",
    ],
    TokenUsageBreakdown: ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"],
    ThreadTokenUsage: ["total", "last"],
    CommandExecutionRequestApprovalParams: ["itemId", "command", "commandActions"],
    CommandExecutionRequestApprovalResponse: ["decision", "accept", "decline"],
    FileChangeRequestApprovalParams: ["itemId"],
    FileChangeRequestApprovalResponse: ["decision", "accept", "decline"],
    McpServerElicitationRequestResponse: ["action", "decline", "content"],
    GetAccountTokenUsageResponse: ["summary", "dailyUsageBuckets", "lifetimeTokens", "startDate", "tokens"],
    GetAccountRateLimitsResponse: [
      "rateLimits",
      "rateLimitsByLimitId",
      "limitId",
      "limitName",
      "planType",
      "primary",
      "secondary",
      "usedPercent",
      "windowDurationMins",
      "resetsAt",
    ],
  } as Record<string, string[]>,
} as const;

type Schema = { definitions?: Record<string, unknown>; [key: string]: unknown };

/** What's wrong with a generated schema folder against the contract; empty when everything is still there. */
export function codexContractProblems(dir: string): string[] {
  const read = (file: string): Schema | null => {
    try {
      return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Schema;
    } catch {
      return null;
    }
  };
  const problems: string[] = [];

  // Each top-level file is a definition of its own name, with its own nested definitions.
  const defs: Record<string, unknown> = {};
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const s = read(f);
    if (!s) continue;
    Object.assign(defs, s.definitions ?? {});
    defs[f.replace(/\.json$/, "")] ??= s;
  }

  const methods = (file: string): Set<string> | null => {
    const s = read(file);
    if (!s) return null;
    const out = new Set<string>();
    for (const variant of [...((s.oneOf as unknown[]) ?? []), ...((s.anyOf as unknown[]) ?? [])]) {
      const m = (variant as { properties?: { method?: { enum?: unknown[] } } }).properties?.method?.enum?.[0];
      if (typeof m === "string") out.add(m);
    }
    return out;
  };
  const lists: [string, readonly string[]][] = [
    ["ClientRequest.json", CODEX_CONTRACT.clientRequests],
    ["ClientNotification.json", CODEX_CONTRACT.clientNotifications],
    ["ServerNotification.json", CODEX_CONTRACT.serverNotifications],
    ["ServerRequest.json", CODEX_CONTRACT.serverRequests],
  ];
  for (const [file, wanted] of lists) {
    const have = methods(file);
    if (!have) {
      problems.push(`${file} is missing or isn't JSON`);
      continue;
    }
    const gone = wanted.filter((m) => !have.has(m));
    if (gone.length) problems.push(`${file} lost ${gone.join(", ")}`);
  }

  for (const [name, wanted] of Object.entries(CODEX_CONTRACT.definitions)) {
    if (!(name in defs)) {
      problems.push(`no definition ${name}`);
      continue;
    }
    const have = wordsOf(defs[name], defs);
    const gone = wanted.filter((w) => !have.has(w));
    if (gone.length) problems.push(`${name} lost ${gone.join(", ")}`);
  }
  return problems;
}

/** Every enum value, const and property name in a schema, following `$ref`s once each. */
function wordsOf(schema: unknown, defs: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }
    const o = x as Record<string, unknown>;
    if (Array.isArray(o.enum)) for (const v of o.enum) if (typeof v === "string") out.add(v);
    if (typeof o.const === "string") out.add(o.const);
    if (o.properties && typeof o.properties === "object") for (const k of Object.keys(o.properties)) out.add(k);
    if (typeof o.$ref === "string") {
      const name = o.$ref.split("/").pop() ?? "";
      if (!seen.has(name) && name in defs) {
        seen.add(name);
        walk(defs[name]);
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== "$ref" && k !== "definitions") walk(v);
  };
  walk(schema);
  return out;
}

/**
 * The `agy` flags and subcommands the Antigravity backend (backends/agy.ts) and readiness use (M9-05, X-05), checked
 * against `agy --help` like the Claude CLI's (`missingFlags`). agy has no package the drift job can install without
 * running an install script, so this is checked by hand: `scripts/cli-contract.ts --agy <path>`.
 */
export const AGY_CONTRACT = {
  flags: [
    "-p",
    "--output-format",
    "--sandbox",
    "--settings",
    "--mode",
    "--model",
    "--conversation",
    "--json-schema",
    "--add-dir",
  ],
  /** Subcommands listed under "Available subcommands". */
  subcommands: ["models"],
  /** Values the app passes, which the help text names. */
  values: ["stream-json", "accept-edits"],
  why: "task steps on agy run `agy -p … --output-format stream-json --sandbox --settings …`; readiness runs `agy models`",
};

/** The Codex CLI commands the app runs besides the app-server: readiness and the version line (M9-06). */
export const CODEX_COMMANDS = [
  { command: ["login", "status"], why: "readiness asks whether Codex is signed in by its exit code" },
  { command: ["app-server"], why: "task steps on Codex run its app-server" },
];
