/**
 * Version of the JSON-RPC protocol between the Rust core and the sidecar.
 * Exchanged in the `system.hello` handshake; see docs/ARCHITECTURE.md §4.
 *
 * Spike-level contract (S2/S3): plain TS types, validated by hand.
 * zod schemas and generated Rust types replace this in M1-02.
 */
export const PROTOCOL_VERSION = 1;

export type RpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
export type RpcError = { code: number; message: string };
export type RpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: RpcError };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

/** Requests from the host (UI via Rust) to the sidecar. */
export type Methods = {
  "system.hello": {
    params: { protocolVersion: number };
    result: {
      protocolVersion: number;
      sdkVersion: string;
      nodeVersion: string;
      homeDir: string;
      claudePath: string | null;
      claudeVersion: string | null;
    };
  };
  /** Readiness of the user's machine (spike S5). Never includes account identity (email, org). */
  "env.check": { params: Record<string, never>; result: EnvCheck };
  "session.start": {
    params: { cwd: string; model?: string; permissionMode?: PermissionMode };
    result: { ok: true };
  };
  "session.send": { params: { text: string }; result: { ok: true } };
  /** `interrupted: false` means no turn was running, so nothing was sent to the CLI. */
  "session.interrupt": { params: Record<string, never>; result: { ok: true; interrupted: boolean } };
  "session.setMode": { params: { mode: PermissionMode }; result: { ok: true } };
  "permission.respond": {
    params: { requestId: string; allow: boolean; message?: string };
    result: { ok: true };
  };
};
export type MethodName = keyof Methods;

/**
 * Only the fields ADR-0002 allows us to read from `claude auth status --json`:
 * - `method`: "claude.ai" | "api_key" | "third_party" | "none" | …
 * - `provider`: "firstParty" | "bedrock" | "vertex" | "foundry" | …
 */
export type AuthState = { loggedIn: boolean; method: string; provider: string };

export type EnvCheck = {
  platform: "darwin" | "win32" | "linux" | string;
  node: string;
  claude: { path: string | null; version: string | null; minVersion: string; versionOk: boolean };
  /** null when the CLI is missing or its status can't be read. */
  auth: AuthState | null;
  git: { version: string | null };
  /** True when a session can start: CLI found, version OK, signed in, git present. */
  ready: boolean;
};

/**
 * Permission modes the app offers. `bypassPermissions` is deliberately excluded. `auto` lets Claude's
 * classifier approve or deny each call and only asks when unsure; our PreToolUse guard still applies.
 * Profiles (Safe/Standard/Autonomous, ARCHITECTURE §6) arrive in M1-18.
 */
export const PERMISSION_MODES = ["default", "acceptEdits", "auto", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Normalized agent activity, independent of raw SDK message shapes (ARCHITECTURE §5.2). */
export type AgentEvent =
  | {
      type: "session.started";
      sessionId: string;
      model: string;
      cwd: string;
      claudeCodeVersion: string;
      permissionMode: string;
    }
  | { type: "text.delta"; text: string }
  /**
   * `parentToolUseId` is null for the main agent; otherwise it is the `toolUseId` of the Agent tool call that
   * spawned the subagent doing this work (the key of the agent tree, ARCHITECTURE §5.2).
   */
  | {
      type: "tool.started";
      toolUseId: string;
      name: string;
      input: unknown;
      parentToolUseId: string | null;
      agentId?: string;
    }
  | { type: "tool.completed"; toolUseId: string; isError: boolean; output: string; parentToolUseId: string | null }
  /** A subagent was spawned by the Agent tool call `toolUseId` (spike S4). */
  | {
      type: "agent.started";
      toolUseId: string;
      taskId: string;
      description: string;
      agentType?: string;
      depth?: number;
      background?: boolean;
    }
  | { type: "agent.text"; parentToolUseId: string; agentId?: string; text: string }
  | {
      type: "agent.completed";
      toolUseId: string;
      taskId: string;
      status: string;
      summary: string;
      totalTokens?: number;
      toolUses?: number;
      durationMs?: number;
    }
  | {
      type: "turn.completed";
      subtype: string;
      isError: boolean;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { type: "error"; message: string };

export type PermissionRequest = {
  requestId: string;
  toolName: string;
  toolUseId: string;
  agentId?: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
};

/** Notifications from the sidecar to the host. */
export type Notifications = {
  "agent.event": AgentEvent;
  "permission.request": PermissionRequest;
};
