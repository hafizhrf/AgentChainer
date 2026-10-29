import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { PROTOCOL_VERSION, RpcErrorCode } from "@agentchainer/protocol";
import pkg from "../package.json" with { type: "json" };
import { applyActions, type Cli, listRuns, rollback } from "./bootstrap/apply.ts";
import { buildPlan, planEnv } from "./bootstrap/plan.ts";
import { catalog } from "./catalog/index.ts";
import { checkEnvironment, claudeVersion, findClaude } from "./claude.ts";
import { auditWorkspace, saveProfile } from "./detect/audit.ts";
import { detectWorkspace } from "./detect/detect.ts";
import { branches, commit, draftMessage, push, stage, switchBranch, unstage } from "./git.ts";
import { installPlugin, listMarketplaces, listPlugins, uninstallPlugin } from "./installer.ts";
import { listRules, removeRule } from "./permissions.ts";
import { log, notify, RpcFailure, serve } from "./rpc.ts";
import { loadSdk } from "./sdk-loader.ts";
import { Session } from "./session.ts";
import { historyEvents, retention, toSessionInfo } from "./stored-sessions.ts";
import { fileDiff, gitInit, listFiles, revert } from "./workspace.ts";

/** Live sessions by SDK session id, one per workspace tab (M1-08). */
const sessions = new Map<string, Session>();

function requireSession(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new RpcFailure(RpcErrorCode.noSession, "This session isn't running. Resume it from the session list.");
  }
  return session;
}

/** The user's own CLI for plugin installs (spike S6), or null when it isn't found. */
function cliFor(cwd: string): Cli | null {
  const claude = findClaude();
  if (!claude) return null;
  return {
    installPlugin: (id, scope) => installPlugin(claude, id, scope, cwd),
    uninstallPlugin: (id, scope) => uninstallPlugin(claude, id, scope, cwd),
    listPlugins: () => listPlugins(claude, cwd),
    listMarketplaces: () => listMarketplaces(claude, cwd),
  };
}

function requireFolder(cwd: string): void {
  if (!existsSync(cwd)) throw new RpcFailure(RpcErrorCode.invalidParams, `Folder not found: ${cwd}`);
}

function rejectIfOpen(sessionId: string, action: string): void {
  if (sessions.has(sessionId)) {
    throw new RpcFailure(RpcErrorCode.sessionOpen, `Close this session's tab before you ${action} it.`);
  }
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

    "session.start": async ({ cwd, model, permissionMode, effort, maxBudgetUsd, showThinking, resume }) => {
      const claudePath = findClaude();
      if (!claudePath) {
        throw new RpcFailure(RpcErrorCode.claudeNotFound, "Claude Code CLI not found. See docs/guides/AUTH_SETUP.md.");
      }
      if (resume && sessions.has(resume)) {
        throw new RpcFailure(RpcErrorCode.sessionOpen, "This session is already open in another tab.");
      }
      // First run of the packaged app downloads and verifies the SDK here (a few seconds).
      const { sdk } = await prepareSdk();
      const session: Session = new Session(
        sdk,
        {
          cwd,
          claudePath,
          ...(model ? { model } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(effort ? { effort } : {}),
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          ...(showThinking ? { showThinking } : {}),
          ...(resume ? { resume } : {}),
        },
        {
          emit: (event) => notify("agent.event", { sessionId: session.id, event }),
          askPermission: (request) => notify("permission.request", { sessionId: session.id, ...request }),
          onEnd: () => {
            if (sessions.get(session.id) === session) sessions.delete(session.id);
          },
        },
      );
      sessions.set(session.id, session);
      return { sessionId: session.id };
    },

    "session.send": ({ sessionId, text, images }) => ({
      ok: true,
      messageId: requireSession(sessionId).send(text, images),
    }),

    "session.interrupt": async ({ sessionId }) => ({
      ok: true,
      interrupted: await requireSession(sessionId).interrupt(),
    }),

    "session.setMode": async ({ sessionId, mode }) => {
      await requireSession(sessionId).setMode(mode);
      return { ok: true };
    },

    "session.close": ({ sessionId }) => {
      sessions.get(sessionId)?.close();
      sessions.delete(sessionId);
      return { ok: true };
    },

    "session.rewind": ({ sessionId, messageId, dryRun }) =>
      requireSession(sessionId).rewind(messageId, dryRun ?? false),

    "session.setModel": async ({ sessionId, model }) => {
      await requireSession(sessionId).setModel(model);
      return { ok: true };
    },

    "session.setEffort": async ({ sessionId, effort }) => {
      await requireSession(sessionId).setEffort(effort);
      return { ok: true };
    },

    "permission.respond": ({ sessionId, requestId, ...answer }) => {
      if (!requireSession(sessionId).respond(requestId, answer)) {
        throw new RpcFailure(RpcErrorCode.noPendingPermission, `No pending permission request ${requestId}`);
      }
      return { ok: true };
    },

    "session.list": async ({ cwd, limit }) => {
      const { sdk } = await prepareSdk();
      const found = await sdk.listSessions({ dir: cwd, limit: limit ?? 50 });
      return { sessions: found.map(toSessionInfo) };
    },

    "session.history": async ({ cwd, sessionId }) => {
      const { sdk } = await prepareSdk();
      return { events: historyEvents(await sdk.getSessionMessages(sessionId, { dir: cwd })) };
    },

    "session.rename": async ({ cwd, sessionId, title }) => {
      const { sdk } = await prepareSdk();
      await sdk.renameSession(sessionId, title, { dir: cwd });
      return { ok: true };
    },

    "session.tag": async ({ cwd, sessionId, tag }) => {
      const { sdk } = await prepareSdk();
      await sdk.tagSession(sessionId, tag || null, { dir: cwd });
      return { ok: true };
    },

    "session.delete": async ({ cwd, sessionId }) => {
      rejectIfOpen(sessionId, "delete");
      const { sdk } = await prepareSdk();
      await sdk.deleteSession(sessionId, { dir: cwd });
      return { ok: true };
    },

    "session.fork": async ({ cwd, sessionId }) => {
      const { sdk } = await prepareSdk();
      return sdk.forkSession(sessionId, { dir: cwd });
    },

    "session.retention": async ({ cwd }) => {
      const { sdk } = await prepareSdk();
      return retention(sdk, cwd);
    },

    "permissions.list": ({ cwd }) => listRules(cwd),

    "permissions.remove": ({ cwd, behavior, rule }) => {
      removeRule(cwd, behavior, rule);
      return { ok: true };
    },

    "workspace.files": ({ cwd }) => listFiles(cwd),

    "workspace.diff": ({ cwd, path }) => fileDiff(cwd, path),

    "workspace.revert": ({ cwd, path, hunk }) => {
      revert(cwd, path, hunk);
      return { ok: true };
    },

    "workspace.gitInit": ({ cwd }) => {
      gitInit(cwd);
      return { ok: true };
    },

    "workspace.scan": ({ cwd }) => {
      if (!existsSync(cwd)) throw new RpcFailure(RpcErrorCode.invalidParams, `Folder not found: ${cwd}`);
      const profile = detectWorkspace(cwd);
      return { profile, findings: auditWorkspace(cwd, profile) };
    },

    "workspace.saveProfile": ({ cwd }) => ({ path: saveProfile(cwd, detectWorkspace(cwd)) }),

    "bootstrap.apply": async ({ cwd, actions, profiles }) => {
      requireFolder(cwd);
      return applyActions(cwd, actions, {
        catalog,
        env: planEnv(cwd),
        cli: cliFor(cwd),
        optIn: profiles ?? [],
      });
    },

    "bootstrap.runs": ({ cwd }) => {
      requireFolder(cwd);
      return {
        runs: listRuns(cwd).map(({ runId, startedAt, catalogVersion, actions }) => ({
          runId,
          startedAt,
          catalogVersion,
          actions: actions.map(({ id, title, status, error, warnings }) => ({
            id,
            title,
            status,
            warnings,
            ...(error ? { error } : {}),
          })),
        })),
      };
    },

    "bootstrap.rollback": ({ cwd, runId, actionId, force }) => {
      requireFolder(cwd);
      return {
        results: rollback(
          cwd,
          runId,
          { cli: cliFor(cwd) },
          { ...(actionId ? { actionId } : {}), ...(force ? { force } : {}) },
        ),
      };
    },

    "bootstrap.plan": ({ cwd, profiles }) => {
      requireFolder(cwd);
      const profile = detectWorkspace(cwd);
      return buildPlan(cwd, profile, auditWorkspace(cwd, profile), catalog, planEnv(cwd), profiles ?? []);
    },

    "git.branches": ({ cwd }) => branches(cwd),

    "git.switch": ({ cwd, branch, create }) => {
      switchBranch(cwd, branch, create ?? false);
      return { ok: true };
    },

    "git.stage": ({ cwd, paths }) => {
      stage(cwd, paths);
      return { ok: true };
    },

    "git.unstage": ({ cwd, paths }) => {
      unstage(cwd, paths);
      return { ok: true };
    },

    "git.commit": ({ cwd, message }) => ({ sha: commit(cwd, message) }),

    "git.push": ({ cwd }) => ({ output: push(cwd) }),

    "git.draftMessage": async ({ cwd }) => {
      const claudePath = findClaude();
      if (!claudePath) throw new RpcFailure(RpcErrorCode.claudeNotFound, "Claude Code CLI not found.");
      const { sdk } = await prepareSdk();
      return { message: await draftMessage(sdk, claudePath, cwd) };
    },
  },
  () => {
    for (const session of sessions.values()) session.close();
  },
);

log(`agentchainer-sidecar ready (protocol v${PROTOCOL_VERSION}, node ${process.version})`);
