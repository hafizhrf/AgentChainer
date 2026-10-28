import { z } from "zod";

/**
 * Contract between the UI (via the Rust relay) and the sidecar, as zod schemas (checklist M1-02).
 * - The sidecar validates every request's params and its own results.
 * - The UI validates every notification and result it receives.
 * - TypeScript types are inferred from the schemas, so the two can't drift.
 * - `schema/protocol.schema.json` is the JSON Schema export (`pnpm --filter @agentchainer/protocol export-schema`).
 * - The Rust core only relays frames (ADR-0003), so it needs no generated types.
 *
 * `PROTOCOL_VERSION` is exchanged in `system.hello`; see docs/ARCHITECTURE.md §4.
 */
export const PROTOCOL_VERSION = 2;

/* ---------- JSON-RPC envelope ---------- */

export type RpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
export type RpcError = { code: number; message: string };
export type RpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: RpcError };
/** `ts` (sidecar send time, epoch ms) is only present when AGENTCHAINER_METRICS=1, for latency measurement (spike S2). */
export type RpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown; ts?: number };
export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

/** JSON-RPC error codes used by the sidecar. */
export const RpcErrorCode = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  noSession: -32001,
  claudeNotFound: -32002,
  noPendingPermission: -32003,
  sdkUnavailable: -32004,
  protocolMismatch: -32005,
  /** The session is already open in another tab, or is open and can't be deleted. */
  sessionOpen: -32006,
} as const;

/* ---------- Shared shapes ---------- */

/**
 * Permission modes the app offers. `bypassPermissions` is deliberately excluded. `auto` lets Claude's
 * classifier approve or deny each call and only asks when unsure; our PreToolUse guard still applies.
 * Profiles (Safe/Standard/Autonomous, ARCHITECTURE §6) arrive in M1-18.
 */
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "auto", "plan"]);
export const PERMISSION_MODES = PermissionModeSchema.options;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * Only the fields ADR-0002 allows us to read from `claude auth status --json`:
 * - `method`: "claude.ai" | "api_key" | "third_party" | "none" | …
 * - `provider`: "firstParty" | "bedrock" | "vertex" | "foundry" | …
 */
export const AuthStateSchema = z.object({ loggedIn: z.boolean(), method: z.string(), provider: z.string() });
export type AuthState = z.infer<typeof AuthStateSchema>;

export const EnvCheckSchema = z.object({
  platform: z.string(),
  node: z.string(),
  claude: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
    minVersion: z.string(),
    versionOk: z.boolean(),
  }),
  /** null when the CLI is missing or its status can't be read. */
  auth: AuthStateSchema.nullable(),
  git: z.object({ version: z.string().nullable() }),
  /** True when a session can start: CLI found, version OK, signed in, git present. */
  ready: z.boolean(),
});
export type EnvCheck = z.infer<typeof EnvCheckSchema>;

const Empty = z.object({});
const Ok = z.object({ ok: z.literal(true) });

export const SessionIdSchema = z.uuid();
/** A live session, open in a tab. */
const SessionRef = z.object({ sessionId: SessionIdSchema });
/** A session on disk; `cwd` lets the SDK look in that project only instead of scanning every project. */
const StoredSessionRef = z.object({ cwd: z.string().min(1), sessionId: SessionIdSchema });

/** Metadata from the SDK's `listSessions` (ADR-0004: we never read the transcript files ourselves). */
export const SessionInfoSchema = z.object({
  sessionId: SessionIdSchema,
  /** Custom title, the CLI's summary, or the first prompt. */
  title: z.string(),
  lastModified: z.number(),
  createdAt: z.number().optional(),
  gitBranch: z.string().optional(),
  tag: z.string().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const RewindResultSchema = z.object({
  canRewind: z.boolean(),
  error: z.string().optional(),
  filesChanged: z.array(z.string()),
  insertions: z.number(),
  deletions: z.number(),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;

/** Normalized agent activity, independent of raw SDK message shapes (ARCHITECTURE §5.2). */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.started"),
    sessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
    claudeCodeVersion: z.string(),
    permissionMode: z.string(),
  }),
  z.object({ type: z.literal("text.delta"), text: z.string() }),
  /** Only in `session.history`: live user messages are added by the UI when it sends them. */
  z.object({ type: z.literal("user.message"), messageId: z.string(), text: z.string() }),
  /**
   * `parentToolUseId` is null for the main agent; otherwise it is the `toolUseId` of the Agent tool call that
   * spawned the subagent doing this work (the key of the agent tree, ARCHITECTURE §5.2).
   */
  z.object({
    type: z.literal("tool.started"),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolUseId: z.string().nullable(),
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    toolUseId: z.string(),
    isError: z.boolean(),
    output: z.string(),
    parentToolUseId: z.string().nullable(),
  }),
  /** A subagent was spawned by the Agent tool call `toolUseId` (spike S4). */
  z.object({
    type: z.literal("agent.started"),
    toolUseId: z.string(),
    taskId: z.string(),
    description: z.string(),
    agentType: z.string().optional(),
    depth: z.number().optional(),
    background: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("agent.text"),
    parentToolUseId: z.string(),
    agentId: z.string().optional(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent.completed"),
    toolUseId: z.string(),
    taskId: z.string(),
    status: z.string(),
    summary: z.string(),
    totalTokens: z.number().optional(),
    toolUses: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  /**
   * `totalCostUsd` is the session's running total, not this turn's cost: the SDK's `total_cost_usd` is cumulative in
   * streaming-input sessions, and a resumed session starts from its saved total. An estimate (ARCHITECTURE §5.3).
   */
  z.object({
    type: z.literal("turn.completed"),
    subtype: z.string(),
    isError: z.boolean(),
    totalCostUsd: z.number(),
    durationMs: z.number(),
    numTurns: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/* ---------- Requests: UI → sidecar ---------- */

export const methodSchemas = {
  "system.hello": {
    params: z.object({ protocolVersion: z.number().int() }),
    result: z.object({
      protocolVersion: z.number().int(),
      sdkVersion: z.string(),
      nodeVersion: z.string(),
      homeDir: z.string(),
      claudePath: z.string().nullable(),
      claudeVersion: z.string().nullable(),
    }),
  },
  /** Liveness check used by the UI's health ping (M1-01). */
  "system.ping": { params: Empty, result: Ok },
  /** Readiness of the user's machine (spike S5). Never includes account identity (email, org). */
  "env.check": { params: Empty, result: EnvCheckSchema },
  /**
   * Makes the Claude Agent SDK ready. The packaged app downloads and verifies the pinned SDK on first use (ADR-0003);
   * dev builds use node_modules.
   */
  "sdk.prepare": {
    params: Empty,
    result: z.object({ version: z.string(), source: z.enum(["node_modules", "download", "cache"]) }),
  },
  /** Dev-only: lets the UI write a line to the sidecar's log, e.g. self-test metrics (spike S2). */
  "debug.log": { params: z.object({ message: z.string().max(10_000) }), result: Ok },
  /**
   * Starts a session, or resumes one from `session.list` when `resume` is set. Returns its SDK session id, which every
   * other session method and notification carries (multi-session, M1-08).
   */
  "session.start": {
    params: z.object({
      cwd: z.string().min(1),
      model: z.string().optional(),
      permissionMode: PermissionModeSchema.optional(),
      resume: SessionIdSchema.optional(),
    }),
    result: z.object({ sessionId: SessionIdSchema }),
  },
  /** `messageId` is the user message's uuid: the anchor for "Rewind files to here" (M1-23). */
  "session.send": {
    params: z.object({ sessionId: SessionIdSchema, text: z.string().min(1) }),
    result: z.object({ ok: z.literal(true), messageId: z.string() }),
  },
  /** `interrupted: false` means no turn was running, so nothing was sent to the CLI. */
  "session.interrupt": {
    params: SessionRef,
    result: z.object({ ok: z.literal(true), interrupted: z.boolean() }),
  },
  "session.setMode": { params: z.object({ sessionId: SessionIdSchema, mode: PermissionModeSchema }), result: Ok },
  /** Ends the live session (its tab closed). The transcript stays on disk and can be resumed. */
  "session.close": { params: SessionRef, result: Ok },
  /**
   * Restores files edited by Edit/Write to their state before the user message `messageId` (SDK file checkpoints).
   * `dryRun` previews the change. Bash-made changes are not tracked.
   */
  "session.rewind": {
    params: z.object({ sessionId: SessionIdSchema, messageId: z.string().min(1), dryRun: z.boolean().optional() }),
    result: RewindResultSchema,
  },
  "permission.respond": {
    params: z.object({
      sessionId: SessionIdSchema,
      requestId: z.string().min(1),
      allow: z.boolean(),
      message: z.string().optional(),
    }),
    result: Ok,
  },

  /* Stored sessions (SDK session APIs, ADR-0004). Includes sessions started in the terminal CLI (M1-22). */
  "session.list": {
    params: z.object({ cwd: z.string().min(1), limit: z.number().int().positive().max(500).optional() }),
    result: z.object({ sessions: z.array(SessionInfoSchema) }),
  },
  /** The main conversation of a stored session as events, to render before resuming it. */
  "session.history": {
    params: StoredSessionRef,
    result: z.object({ events: z.array(AgentEventSchema) }),
  },
  "session.rename": { params: StoredSessionRef.extend({ title: z.string().trim().min(1).max(200) }), result: Ok },
  /** `tag: null` clears the tag. */
  "session.tag": { params: StoredSessionRef.extend({ tag: z.string().trim().max(50).nullable() }), result: Ok },
  "session.delete": { params: StoredSessionRef, result: Ok },
  /** Copies a stored session into a new one (without its file checkpoints) and returns the new id. */
  "session.fork": { params: StoredSessionRef, result: z.object({ sessionId: SessionIdSchema }) },
  /** How long Claude Code keeps session transcripts (`cleanupPeriodDays`, M1-24). No other settings leave the sidecar. */
  "session.retention": {
    params: z.object({ cwd: z.string().min(1) }),
    result: z.object({ days: z.number(), source: z.string() }),
  },
} as const;

export type MethodName = keyof typeof methodSchemas;
export type Methods = {
  [M in MethodName]: {
    params: z.input<(typeof methodSchemas)[M]["params"]>;
    result: z.output<(typeof methodSchemas)[M]["result"]>;
  };
};

/* ---------- Notifications: sidecar → UI ---------- */

export const PermissionRequestSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  toolName: z.string(),
  toolUseId: z.string(),
  agentId: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  description: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const AgentEventNotificationSchema = z.object({ sessionId: z.string(), event: AgentEventSchema });

export const notificationSchemas = {
  "agent.event": AgentEventNotificationSchema,
  "permission.request": PermissionRequestSchema,
} as const;

export type NotificationName = keyof typeof notificationSchemas;
export type Notifications = { [N in NotificationName]: z.infer<(typeof notificationSchemas)[N]> };

/** Params as handlers receive them (after validation and defaults) and results as they must return them. */
export type MethodParams<M extends MethodName> = z.output<(typeof methodSchemas)[M]["params"]>;
export type MethodResult<M extends MethodName> = Methods[M]["result"];

export const isMethodName = (name: string): name is MethodName => Object.hasOwn(methodSchemas, name);
export const isNotificationName = (name: string): name is NotificationName => Object.hasOwn(notificationSchemas, name);

/** Human-readable validation errors, so callers never need to import zod themselves. */
export function describeIssues(error: z.ZodError): string {
  return z.prettifyError(error);
}
