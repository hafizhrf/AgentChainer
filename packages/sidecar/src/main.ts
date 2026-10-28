import { homedir } from "node:os";
import { PROTOCOL_VERSION, RpcErrorCode } from "@agentchainer/protocol";
import pkg from "../package.json" with { type: "json" };
import { checkEnvironment, claudeVersion, findClaude } from "./claude.ts";
import { log, notify, RpcFailure, serve } from "./rpc.ts";
import { loadSdk } from "./sdk-loader.ts";
import { Session } from "./session.ts";

// One session at a time for now. Multi-session (workspace tabs) arrives with the M1 session work.
let session: Session | null = null;

function requireSession(): Session {
  if (!session) throw new RpcFailure(RpcErrorCode.noSession, "No active session. Call session.start first.");
  return session;
}

/** Loads the SDK; the packaged app downloads and verifies it on first use (a few seconds). */
function prepareSdk() {
  return loadSdk().catch((err: unknown) => {
    throw new RpcFailure(RpcErrorCode.sdkUnavailable, err instanceof Error ? err.message : String(err));
  });
}

// Params arrive validated against the protocol schemas (rpc.ts), so handlers can trust their shape.
serve(
  {
    "system.hello": ({ protocolVersion }) => {
      // An app and sidecar from different releases must fail loudly, not misread each other's frames.
      if (protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcFailure(
          RpcErrorCode.protocolMismatch,
          `Protocol mismatch: the app speaks v${protocolVersion}, the agent runtime v${PROTOCOL_VERSION}. Reinstall AgentChainer.`,
        );
      }
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

    "system.ping": () => ({ ok: true }),

    "env.check": () => checkEnvironment(),

    "sdk.prepare": async () => {
      const { version, source } = await prepareSdk();
      return { version, source };
    },

    "debug.log": ({ message }) => {
      log(`ui: ${message}`);
      return { ok: true };
    },

    "session.start": async ({ cwd, model, permissionMode }) => {
      const claudePath = findClaude();
      if (!claudePath) {
        throw new RpcFailure(RpcErrorCode.claudeNotFound, "Claude Code CLI not found. See docs/guides/AUTH_SETUP.md.");
      }
      // First run of the packaged app downloads and verifies the SDK here (a few seconds).
      const { sdk } = await prepareSdk();
      session?.close();
      session = new Session(
        sdk,
        { cwd, claudePath, ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}) },
        {
          emit: (event) => notify("agent.event", event),
          askPermission: (request) => notify("permission.request", request),
        },
      );
      return { ok: true };
    },

    "session.send": ({ text }) => {
      requireSession().send(text);
      return { ok: true };
    },

    "session.interrupt": async () => ({ ok: true, interrupted: await requireSession().interrupt() }),

    "session.setMode": async ({ mode }) => {
      await requireSession().setMode(mode);
      return { ok: true };
    },

    "permission.respond": ({ requestId, allow, message }) => {
      if (!requireSession().respond(requestId, allow, message)) {
        throw new RpcFailure(RpcErrorCode.noPendingPermission, `No pending permission request ${requestId}`);
      }
      return { ok: true };
    },
  },
  () => session?.close(),
);

log(`agentchainer-sidecar ready (protocol v${PROTOCOL_VERSION}, node ${process.version})`);
