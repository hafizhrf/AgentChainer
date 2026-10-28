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
export const PROTOCOL_VERSION = 1;

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
  "session.start": {
    params: z.object({
      cwd: z.string().min(1),
      model: z.string().optional(),
      permissionMode: PermissionModeSchema.optional(),
    }),
    result: Ok,
  },
  "session.send": { params: z.object({ text: z.string().min(1) }), result: Ok },
  /** `interrupted: false` means no turn was running, so nothing was sent to the CLI. */
  "session.interrupt": { params: Empty, result: z.object({ ok: z.literal(true), interrupted: z.boolean() }) },
  "session.setMode": { params: z.object({ mode: PermissionModeSchema }), result: Ok },
  "permission.respond": {
    params: z.object({ requestId: z.string().min(1), allow: z.boolean(), message: z.string().optional() }),
    result: Ok,
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
  z.object({
    type: z.literal("turn.completed"),
    subtype: z.string(),
    isError: z.boolean(),
    costUsd: z.number(),
    durationMs: z.number(),
    numTurns: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const PermissionRequestSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  toolUseId: z.string(),
  agentId: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  description: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const notificationSchemas = {
  "agent.event": AgentEventSchema,
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
