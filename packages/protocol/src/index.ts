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
 * Permission modes the app offers. `bypassPermissions` is deliberately excluded; profiles
 * (Safe/Standard/Autonomous, ARCHITECTURE §6) arrive in M1-18.
 */
export const PERMISSION_MODES = ["default", "acceptEdits", "plan"] as const;
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
  | { type: "tool.started"; toolUseId: string; name: string; input: unknown; parentToolUseId: string | null }
  | { type: "tool.completed"; toolUseId: string; isError: boolean; output: string }
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
