import { homedir } from "node:os";
import { PERMISSION_MODES, PROTOCOL_VERSION, type PermissionMode } from "@agentchainer/protocol";
import pkg from "../package.json" with { type: "json" };
import { checkEnvironment, claudeVersion, findClaude } from "./claude.ts";
import { log, notify, requireString, RpcFailure, serve } from "./rpc.ts";
import { Session } from "./session.ts";

// Spike S2/S3: one session at a time. Multi-session and the full method surface arrive in M1.
let session: Session | null = null;

function requireSession(): Session {
  if (!session) throw new RpcFailure(-32001, "No active session. Call session.start first.");
  return session;
}

function parseMode(value: unknown): PermissionMode {
  const mode = PERMISSION_MODES.find((m) => m === value);
  if (!mode) throw new RpcFailure(-32602, `Unsupported permission mode ${JSON.stringify(value)}`);
  return mode;
}

serve({
  "system.hello": () => {
    const claudePath = findClaude();
    return {
      protocolVersion: PROTOCOL_VERSION,
      sdkVersion: pkg.dependencies["@anthropic-ai/claude-agent-sdk"],
      nodeVersion: process.version,
      homeDir: homedir(),
      claudePath,
      claudeVersion: claudePath ? claudeVersion(claudePath) : null,
    };
  },

  "env.check": () => checkEnvironment(),

  "session.start": (params) => {
    const cwd = requireString(params, "cwd");
    const model = typeof params.model === "string" && params.model ? params.model : undefined;
    const permissionMode = params.permissionMode === undefined ? undefined : parseMode(params.permissionMode);
    const claudePath = findClaude();
    if (!claudePath) throw new RpcFailure(-32002, "Claude Code CLI not found. See docs/guides/AUTH_SETUP.md.");
    session?.close();
    session = new Session(
      { cwd, claudePath, ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}) },
      {
        emit: (event) => notify("agent.event", event),
        askPermission: (request) => notify("permission.request", request),
      },
    );
    return { ok: true };
  },

  "session.send": (params) => {
    requireSession().send(requireString(params, "text"));
    return { ok: true };
  },

  "session.interrupt": async () => ({ ok: true, interrupted: await requireSession().interrupt() }),

  "session.setMode": async (params) => {
    await requireSession().setMode(parseMode(params.mode));
    return { ok: true };
  },

  "permission.respond": (params) => {
    const requestId = requireString(params, "requestId");
    const message = typeof params.message === "string" ? params.message : undefined;
    if (!requireSession().respond(requestId, params.allow === true, message)) {
      throw new RpcFailure(-32003, `No pending permission request ${requestId}`);
    }
    return { ok: true };
  },
}, () => session?.close());

log(`agentchainer-sidecar ready (protocol v${PROTOCOL_VERSION}, node ${process.version})`);
