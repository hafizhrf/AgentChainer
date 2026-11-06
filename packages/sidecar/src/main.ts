import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  asLanguage,
  folderProblems,
  PROTOCOL_VERSION,
  RpcErrorCode,
  setLanguage,
  type Task,
} from "@agentchainer/protocol";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { agentTemplates } from "./agent-templates.ts";
import { deleteAgent, listAgents, saveAgent } from "./agents.ts";
import { applyActions, type Cli, listRuns, rollback } from "./bootstrap/apply.ts";
import { autoApplicable } from "./bootstrap/auto-apply.ts";
import { generate, resolveActionlint } from "./bootstrap/generate.ts";
import { buildPlan, planEnv } from "./bootstrap/plan.ts";
import { proposals } from "./bootstrap/proposals.ts";
import { toolsDir } from "./bootstrap/tools.ts";
import { catalog } from "./catalog/index.ts";
import { checkEnvironment, claudeVersion, findClaude } from "./claude.ts";
import { setDockerImage } from "./deploy/adapters.ts";
import {
  deployPreview,
  deployProduction,
  deployTargets,
  listDeploys,
  productionPlan,
  rollbackDeploy,
} from "./deploy/service.ts";
import { auditWorkspace, saveProfile } from "./detect/audit.ts";
import { detectWorkspace } from "./detect/detect.ts";
import {
  abortMerge,
  branches,
  commit,
  deleteBranch,
  draftMessage,
  fetchAll,
  merge,
  pull,
  push,
  renameBranch,
  stage,
  switchBranch,
  unstage,
} from "./git.ts";
import { githubStatus, systemGh } from "./github.ts";
import { t } from "./i18n/index.ts";
import {
  addMcpServer,
  installPlugin,
  listMarketplaces,
  listPlugins,
  pluginCli,
  removeMcpServer,
  uninstallPlugin,
} from "./installer.ts";
import { normalize } from "./normalize.ts";
import { listRules, removeRule } from "./permissions.ts";
import { cliError, installListed, listPluginsFor, parseDetails, uninstallListed, updateListed } from "./plugins.ts";
import { CHAT_TOOLS, loadProfile, type ProfileOptions, profileOptions, profileSummaries } from "./profiles.ts";
import { log, notify, RpcFailure, serve } from "./rpc.ts";
import { type AgentSdkModule, loadSdk } from "./sdk-loader.ts";
import { ASK_FIRST, Session } from "./session.ts";
import { replayEvents, retention, toSessionInfo } from "./stored-sessions.ts";
import { generateWorkflow } from "./tasks/generate-workflow.ts";
import { applyLessons, dismissLessons, previewLessons, storedLessons, suggestLessons } from "./tasks/lessons.ts";
import { computeMetrics, loadAllTasks } from "./tasks/metrics.ts";
import {
  checkWorkflowText,
  readWorkflowFile,
  saveProjectWorkflow,
  tierWorkflows,
  workflowSource,
  writeWorkflowFile,
} from "./tasks/project-workflows.ts";
import type { SessionHost } from "./tasks/runner.ts";
import { AlreadyRunning, Scheduler } from "./tasks/schedules.ts";
import {
  acceptRisk,
  approveSubtasks,
  approveTask,
  type Claude,
  cancelTask,
  ciLog,
  cleanupTask,
  continueTask,
  createTaskPr,
  deleteTaskSafe,
  draftTask,
  dropFlow,
  evidenceOf,
  fixCiTask,
  listTasksLive,
  mergeGates,
  mergePrTask,
  mergeResult,
  messageRun,
  newTask,
  overlapsOf,
  present,
  proposeFlow,
  prPreview,
  prStatus,
  resumeTask,
  retriageTask,
  reviewPrTask,
  reviseTask,
  runningTask,
  schedulable,
  settleRun,
  shippedLibrary,
  shutdownRuns,
  splitTask,
  startTask,
  taskEvidence,
  taskWorkflow,
  workflowsOf,
  writeEvidence,
} from "./tasks/service.ts";
import { loadTask } from "./tasks/store.ts";
import { sessionWorkers, Team, teamTools, type WorkerBase } from "./team.ts";
import { fileDiff, gitInit, listFiles, revert } from "./workspace.ts";

/** Live sessions by SDK session id, one per workspace tab (M1-08). */
const sessions = new Map<string, Session>();

function requireSession(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new RpcFailure(RpcErrorCode.noSession, t("rpc.session.notRunning"));
  }
  return session;
}

/**
 * A Team chat's crew (M8-03): its workers are live sessions like any tab's, opened by the sidecar, so the UI is told
 * of each before its first event.
 */
function newTeam(sdk: AgentSdkModule, capUsd: number, parentId: () => string, base: WorkerBase): Team {
  const team: Team = new Team(
    capUsd,
    {
      emit: (event) => notify("agent.event", { sessionId: parentId(), event }),
      open: (spec, on) => open(spec, on),
    },
    // A worker may run as one of the workspace's or the user's agent profiles (M8-04).
    (name) => loadProfile(base.cwd, claudeConfigDir(), name),
  );
  const open = sessionWorkers(sdk, base, parentId, {
    register: (s) => sessions.set(s.id, s),
    unregister: (s) => {
      if (sessions.get(s.id) === s) sessions.delete(s.id);
    },
    opened: (info) => notify("session.opened", info),
    event: (sessionId, event) => notify("agent.event", { sessionId, event }),
    permission: (sessionId, request) => notify("permission.request", { sessionId, ...request }),
    status: (item) => notify("fleet.changed", { item }),
  });
  return team;
}

/** The CLI's config folder, where the user's own agents live (`~/.claude`, or `CLAUDE_CONFIG_DIR`). */
const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Generators whose proposals include GitHub workflows, checked with actionlint (M2-24). */
const WORKFLOW_GENERATORS = new Set(["generate-ci", "smoke-test"]);

function cliFor(cwd: string): Cli | null {
  const claude = findClaude();
  if (!claude) return null;
  return {
    installPlugin: (id, scope) => installPlugin(claude, id, scope, cwd),
    uninstallPlugin: (id, scope) => uninstallPlugin(claude, id, scope, cwd),
    addMcp: (name, scope, command, args) => addMcpServer(claude, name, scope, command, args, cwd),
    removeMcp: (name, scope) => removeMcpServer(claude, name, scope, cwd),
    listPlugins: () => listPlugins(claude, cwd),
    listMarketplaces: () => listMarketplaces(claude, cwd),
  };
}

/** The user's CLI for the Plugins page (UX-10); every call fails clearly when the CLI isn't found. */
function pluginsCli(cwd: string) {
  const claude = findClaude();
  if (!claude) throw new RpcFailure(RpcErrorCode.invalidParams, t("rpc.claude.noCliForPlugins"));
  return pluginCli(claude, cwd);
}

function requireFolder(cwd: string): void {
  if (!existsSync(cwd)) throw new RpcFailure(RpcErrorCode.invalidParams, t("rpc.folder.notFound", { path: cwd }));
}

/** The SDK and the CLI, for methods that make model calls. */
async function claude(): Promise<Claude> {
  const claudePath = findClaude();
  if (!claudePath) throw new RpcFailure(RpcErrorCode.claudeNotFound, t("rpc.claude.notFound"));
  const { sdk } = await prepareSdk();
  return { sdk, claudePath };
}

/**
 * How a task's step sessions plug into the sidecar: registered with the live sessions (so approvals and interrupts
 * reach them), and their events and approvals tagged with the task, since they have no tab of their own.
 */
function sessionHost({ sdk, claudePath }: Claude): SessionHost {
  return {
    sdk,
    claudePath,
    register: (session) => sessions.set(session.id, session),
    unregister: (id) => sessions.delete(id),
    event: (sessionId, event, task) => notify("agent.event", { sessionId, event, task }),
    permission: (sessionId, request, task) => notify("permission.request", { sessionId, ...request, task }),
    status: (item) => notify("fleet.changed", { item }),
  };
}

const taskUpdated = (cwd: string) => (task: Task) => notify("task.updated", { cwd, task });

/** Where a lesson came from, as its CLAUDE.md line says: "task “Fix the totals”, 2026-11-03" (M8-06). */
function lessonOrigin(cwd: string, id: string): string {
  const task = loadTask(cwd, id);
  const full = (task.title ?? task.request).replace(/\s+/g, " ").trim();
  // Cut at a word, not inside one.
  const title = full.length > 60 ? `${full.slice(0, 60).replace(/\s+\S*$/, "")}…` : full;
  return `task “${title}”, ${task.createdAt.slice(0, 10)}`;
}

/**
 * Scheduled flows (M8-05): the watched workspaces' schedules, checked once a minute while the app is open. A run
 * starts like Run again, in `acceptEdits`: edits go ahead, anything else waits for the person, who is notified.
 */
const scheduler = new Scheduler({
  start: (cwd, taskId, check) => {
    if (check) {
      schedulable(cwd, taskId);
      return;
    }
    // Starting needs the SDK, which is async: the checks that can refuse a run are made first, here.
    if (runningTask(taskId)) throw new AlreadyRunning(t("rpc.task.alreadyRunning"));
    // Like Run again: the model of the task's last run, so a schedule never switches it to a costlier one.
    const model = schedulable(cwd, taskId).run?.model;
    void claude().then(
      (c) =>
        startTask(
          cwd,
          taskId,
          sessionHost(c),
          { permissionMode: "acceptEdits", scheduled: true, ...(model ? { model } : {}) },
          taskUpdated(cwd),
        ),
      (err: unknown) => log(`a scheduled run couldn't start: ${err instanceof Error ? err.message : String(err)}`),
    );
  },
  title: (cwd, taskId) => {
    const task = loadTask(cwd, taskId);
    return (task.title ?? task.request).slice(0, 120);
  },
  changed: (schedule) => notify("schedule.changed", { schedule }),
  deleted: (cwd, id) => notify("schedule.deleted", { cwd, id }),
});

/**
 * Drafting's messages as agent events tagged with the task's "draft" step (UX-13), so its thread shows what drafting
 * reads. Each drafting is its own session id: a redraft starts a new block.
 */
function draftEvents(cwd: string, id: string) {
  const sessionId = `draft-${id}-${Date.now()}`;
  const task = { id, cwd, stepId: "draft", label: t("rpc.task.draftingContract"), role: "planner" };
  return (m: SDKMessage) => {
    for (const event of normalize(m)) notify("agent.event", { sessionId, event, task });
  };
}

function rejectIfOpen(sessionId: string): void {
  if (sessions.has(sessionId)) {
    throw new RpcFailure(RpcErrorCode.sessionOpen, t("rpc.session.closeTabBeforeDelete"));
  }
}

/** Loads the SDK; the packaged app downloads and verifies it on first use (a few seconds). */
function prepareSdk() {
  return loadSdk().catch((err: unknown) => {
    throw new RpcFailure(RpcErrorCode.sdkUnavailable, err instanceof Error ? err.message : String(err));
  });
}

// Params arrive validated against the protocol schemas (rpc.ts), so handlers can trust their shape.
// The app's language (X-13), passed at spawn from the settings; a change restarts the app. The catalogs are bundled,
// so it applies at once, before the first request. zod's own messages (invalid params) follow it.
const language = asLanguage(process.env.AGENTCHAINER_LANGUAGE);
void setLanguage(language);
if (language === "id") z.config(z.locales.id());

serve(
  {
    "system.hello": ({ protocolVersion }) => {
      // An app and sidecar from different releases must fail loudly, not misread each other's frames.
      if (protocolVersion !== PROTOCOL_VERSION) {
        throw new RpcFailure(
          RpcErrorCode.protocolMismatch,
          t("rpc.protocol.mismatch", { app: protocolVersion, runtime: PROTOCOL_VERSION }),
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

    "session.start": async ({
      cwd,
      model,
      permissionMode,
      effort,
      maxBudgetUsd,
      showThinking,
      resume,
      folders,
      team,
      profile: profileName,
    }) => {
      // A Team chat (M8-03) runs workers on the person's budget, so it needs a cap for them all.
      if (team && !maxBudgetUsd) {
        throw new RpcFailure(RpcErrorCode.invalidParams, t("rpc.team.needsBudget"));
      }
      // A multi-folder workspace's other folders (M8-01): the same rules as the New workspace dialog, and they exist.
      if (folders?.length) {
        const problems = folderProblems([cwd, ...folders], homedir());
        if (problems.length) throw new RpcFailure(RpcErrorCode.invalidParams, problems.join(" "));
        for (const dir of folders) requireFolder(dir);
      }
      const claudePath = findClaude();
      if (!claudePath) {
        throw new RpcFailure(RpcErrorCode.claudeNotFound, t("rpc.claude.notFoundSeeGuide"));
      }
      if (resume && sessions.has(resume)) {
        throw new RpcFailure(RpcErrorCode.sessionOpen, t("rpc.session.alreadyOpen"));
      }
      // An agent profile (M8-04): its instructions come before the chat's own, and only its tools are there. A Team
      // chat keeps its MCP tools, the app's own among them.
      let own: ProfileOptions | null = null;
      if (profileName) {
        try {
          own = profileOptions(loadProfile(cwd, claudeConfigDir(), profileName), {
            extraTools: CHAT_TOOLS,
            keepMcp: team === true,
          });
        } catch (err) {
          throw new RpcFailure(RpcErrorCode.invalidParams, err instanceof Error ? err.message : String(err));
        }
      }
      const chatModel = model || own?.model;
      // First run of the packaged app downloads and verifies the SDK here (a few seconds).
      const { sdk } = await prepareSdk();
      const crew =
        team && maxBudgetUsd
          ? newTeam(sdk, maxBudgetUsd, () => session.id, {
              cwd,
              claudePath,
              ...(chatModel ? { model: chatModel } : {}),
              ...(effort ? { effort } : {}),
              ...(folders?.length ? { additionalDirectories: folders } : {}),
            })
          : null;
      const session: Session = new Session(
        sdk,
        {
          cwd,
          claudePath,
          ...(chatModel ? { model: chatModel } : {}),
          ...(own ? { appendSystemPrompt: `${own.appendSystemPrompt}\n\n${ASK_FIRST}` } : {}),
          ...(own?.tools ? { tools: own.tools } : {}),
          ...(own?.disallowedTools ? { disallowedTools: own.disallowedTools } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(effort ? { effort } : {}),
          ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
          ...(showThinking ? { showThinking } : {}),
          ...(resume ? { resume } : {}),
          ...(folders?.length ? { additionalDirectories: folders } : {}),
          // Interactive sessions show their background tasks and stop them one by one (M4-07).
          background: true,
          interactive: true,
          ...(crew ? { appTools: teamTools(sdk, crew, profileSummaries(cwd, claudeConfigDir())) } : {}),
        },
        {
          emit: (event) => notify("agent.event", { sessionId: session.id, event }),
          askPermission: (request) => notify("permission.request", { sessionId: session.id, ...request }),
          statusChanged: (item) => notify("fleet.changed", { item }),
          ...(crew ? { turnEnded: () => crew.supervisorTurnEnded() } : {}),
          onEnd: () => {
            if (sessions.get(session.id) === session) sessions.delete(session.id);
            void crew?.close();
          },
        },
      );
      crew?.attach(session);
      sessions.set(session.id, session);
      return { sessionId: session.id };
    },

    "fleet.list": () => ({ items: [...sessions.values()].map((s) => s.fleetItem) }),

    "session.send": ({ sessionId, text, images }) => ({
      ok: true,
      messageId: requireSession(sessionId).send(text, images),
    }),

    "session.interrupt": async ({ sessionId }) => ({
      ok: true,
      interrupted: await requireSession(sessionId).interrupt(),
    }),

    "session.stopAgent": async ({ sessionId, taskId }) => ({
      ok: true,
      stopped: await requireSession(sessionId).stopAgent(taskId),
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
        throw new RpcFailure(RpcErrorCode.noPendingPermission, t("rpc.permission.noPending", { requestId }));
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
      const main = await sdk.getSessionMessages(sessionId, { dir: cwd });
      const ids = await sdk.listSubagents(sessionId, { dir: cwd });
      const subagents = new Map(
        await Promise.all(
          ids.map(async (id) => [id, await sdk.getSubagentMessages(sessionId, id, { dir: cwd })] as const),
        ),
      );
      return replayEvents(main, subagents);
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
      rejectIfOpen(sessionId);
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

    "permissions.list": ({ cwd }) => ({ workspace: listRules(cwd, "workspace"), team: listRules(cwd, "team") }),

    "agents.list": ({ cwd }) => {
      requireFolder(cwd);
      return { agents: listAgents(cwd, claudeConfigDir()) };
    },

    "agents.save": ({ cwd, agent, previousName }) => {
      requireFolder(cwd);
      const runId = saveAgent(cwd, claudeConfigDir(), agent, catalog.version, previousName);
      return runId ? { runId } : {};
    },

    "agents.delete": ({ cwd, name, scope }) => {
      requireFolder(cwd);
      const runId = deleteAgent(cwd, claudeConfigDir(), name, scope ?? "project", catalog.version);
      return runId ? { runId } : {};
    },

    "agents.templates": () => ({ templates: agentTemplates() }),

    "schedule.list": ({ cwd }) => {
      if (cwd) requireFolder(cwd);
      return { schedules: scheduler.list(cwd) };
    },

    "schedule.save": ({ cwd, id, taskId, cadence, enabled }) => {
      requireFolder(cwd);
      try {
        return { schedule: scheduler.save(cwd, { ...(id ? { id } : {}), taskId, cadence, enabled }) };
      } catch (err) {
        if (err instanceof RpcFailure) throw err;
        throw new RpcFailure(RpcErrorCode.invalidParams, err instanceof Error ? err.message : String(err));
      }
    },

    "schedule.delete": ({ cwd, id }) => {
      requireFolder(cwd);
      scheduler.delete(cwd, id);
      return { ok: true };
    },

    "schedule.runNow": ({ cwd, id }) => {
      requireFolder(cwd);
      return { schedule: scheduler.runNow(cwd, id) };
    },

    "schedule.watch": ({ cwds }) => ({ schedules: scheduler.watch(cwds) }),

    "permissions.remove": ({ cwd, behavior, rule, scope }) => {
      removeRule(cwd, behavior, rule, scope ?? "workspace");
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
      if (!existsSync(cwd)) throw new RpcFailure(RpcErrorCode.invalidParams, t("rpc.folder.notFound", { path: cwd }));
      const profile = detectWorkspace(cwd);
      return { profile, findings: auditWorkspace(cwd, profile) };
    },

    "workspace.saveProfile": ({ cwd }) => ({ path: saveProfile(cwd, detectWorkspace(cwd)) }),

    "bootstrap.apply": async ({ cwd, actions, profiles, install }) => {
      requireFolder(cwd);
      const result = await applyActions(cwd, actions, {
        catalog,
        env: planEnv(cwd),
        cli: cliFor(cwd),
        optIn: profiles ?? [],
        proposals: proposals.of(cwd),
        install: install ?? [],
      });
      for (const r of result.results) {
        if (r.status === "applied" && r.id.startsWith("gen:")) proposals.delete(cwd, r.id.slice(4));
      }
      return result;
    },

    "bootstrap.autoApply": async ({ cwd }) => {
      requireFolder(cwd);
      const profile = detectWorkspace(cwd);
      const env = planEnv(cwd);
      const plan = buildPlan(cwd, profile, auditWorkspace(cwd, profile), catalog, env);
      const ids = plan.actions.filter(autoApplicable).map((a) => a.id);
      if (ids.length === 0) return { runId: null, results: [] };
      return applyActions(cwd, ids, { catalog, env, cli: cliFor(cwd) });
    },

    "bootstrap.generate": async ({ cwd, action, model }) => {
      requireFolder(cwd);
      const claudePath = findClaude();
      if (!claudePath) throw new RpcFailure(RpcErrorCode.claudeNotFound, t("rpc.claude.notFound"));
      const { sdk } = await prepareSdk();
      const name = action.replace(/^gen:/, "");
      // Workflow checks use actionlint, fetched (pinned) on first use.
      const tools = WORKFLOW_GENERATORS.has(name)
        ? {
            actionlint: await resolveActionlint(
              catalog.items.find((i) => i.id === "actionlint"),
              toolsDir(),
            ),
          }
        : undefined;
      const p = await generate(sdk, claudePath, cwd, name, detectWorkspace(cwd), {
        ...(model ? { model } : {}),
        ...(tools ? { tools } : {}),
      });
      proposals.set(cwd, p);
      return {
        summary: p.summary,
        files: p.files.map((f) => f.path),
        checks: p.checks,
        attempts: p.attempts,
        costUsd: p.costUsd,
      };
    },

    "bootstrap.runs": ({ cwd }) => {
      requireFolder(cwd);
      return {
        runs: listRuns(cwd).map(({ runId, startedAt, catalogVersion, actions }) => ({
          runId,
          startedAt,
          catalogVersion,
          actions: actions.map(({ id, title, status, error, warnings, checks }) => ({
            id,
            title,
            status,
            warnings,
            ...(error ? { error } : {}),
            ...(checks ? { checks } : {}),
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

    "plugins.list": ({ cwd, refresh }) => {
      requireFolder(cwd);
      return listPluginsFor(cwd, pluginsCli(cwd), catalog, refresh ?? false);
    },

    "plugins.details": async ({ cwd, id }) => {
      requireFolder(cwd);
      const res = await pluginsCli(cwd).details(id);
      if (!res.ok) throw cliError("claude plugin details", res);
      return parseDetails(res.stdout);
    },

    "plugins.install": ({ cwd, id, scope, acceptCommand }) => {
      requireFolder(cwd);
      return installListed(cwd, pluginsCli(cwd), catalog, id, scope, acceptCommand);
    },

    "plugins.update": ({ cwd, id, scope, acceptCommand }) => {
      requireFolder(cwd);
      return updateListed(cwd, pluginsCli(cwd), catalog, id, scope, acceptCommand);
    },

    "plugins.uninstall": async ({ cwd, id, scope }) => {
      requireFolder(cwd);
      await uninstallListed(cwd, pluginsCli(cwd), id, scope);
      return { ok: true as const };
    },

    "plugins.setEnabled": async ({ cwd, id, scope, enabled }) => {
      requireFolder(cwd);
      const res = await pluginsCli(cwd).setEnabled(id, scope, enabled);
      if (!res.ok) throw cliError(`claude plugin ${enabled ? "enable" : "disable"}`, res);
      return { ok: true as const };
    },

    "bootstrap.plan": ({ cwd, profiles }) => {
      requireFolder(cwd);
      const profile = detectWorkspace(cwd);
      return buildPlan(
        cwd,
        profile,
        auditWorkspace(cwd, profile),
        catalog,
        planEnv(cwd),
        profiles ?? [],
        proposals.of(cwd),
      );
    },

    "git.branches": ({ cwd }) => branches(cwd),

    "git.switch": ({ cwd, branch, create, track }) => {
      switchBranch(cwd, branch, create ?? false, track ?? false);
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

    "git.push": async ({ cwd }) => ({ output: await push(cwd) }),

    "git.fetch": async ({ cwd }) => ({ output: await fetchAll(cwd) }),

    "git.pull": async ({ cwd }) => ({ output: await pull(cwd) }),

    "git.deleteBranch": ({ cwd, branch, force }) => deleteBranch(cwd, branch, force ?? false),

    "git.renameBranch": ({ cwd, from, to }) => {
      renameBranch(cwd, from, to);
      return { ok: true };
    },

    "git.merge": ({ cwd, branch }) => merge(cwd, branch),

    "git.abortMerge": ({ cwd }) => {
      abortMerge(cwd);
      return { ok: true };
    },

    "git.draftMessage": async ({ cwd }) => {
      const claudePath = findClaude();
      if (!claudePath) throw new RpcFailure(RpcErrorCode.claudeNotFound, t("rpc.claude.notFound"));
      const { sdk } = await prepareSdk();
      return { message: await draftMessage(sdk, claudePath, cwd) };
    },

    "task.create": ({ cwd, request, context, folders }) => {
      requireFolder(cwd);
      // A multi-folder workspace's other folders (M8-01), checked like a session's.
      if (folders?.length) {
        const problems = folderProblems([cwd, ...folders], homedir());
        if (problems.length) throw new RpcFailure(RpcErrorCode.invalidParams, problems.join(" "));
        for (const dir of folders) requireFolder(dir);
      }
      return newTask(cwd, request, context, folders);
    },

    "task.draft": async ({ cwd, id, model }) => {
      requireFolder(cwd);
      return draftTask(cwd, id, await claude(), model, draftEvents(cwd, id));
    },

    "task.proposeFlow": async ({ cwd, id, model }) => {
      requireFolder(cwd);
      return proposeFlow(cwd, id, await claude(), model);
    },

    "task.dropFlow": ({ cwd, id }) => {
      requireFolder(cwd);
      return dropFlow(cwd, id);
    },

    "task.workflow": ({ cwd, id }) => {
      requireFolder(cwd);
      return taskWorkflow(cwd, id);
    },

    "task.message": ({ cwd, id, text }) => {
      requireFolder(cwd);
      return { sent: messageRun(id, text) };
    },

    "task.redraft": async ({ cwd, id, model, feedback }) => {
      requireFolder(cwd);
      return draftTask(cwd, id, await claude(), model, draftEvents(cwd, id), feedback);
    },

    "task.retriage": async ({ cwd, id, contract }) => {
      requireFolder(cwd);
      return retriageTask(cwd, id, contract, await claude());
    },

    "task.approve": ({ cwd, id, contract, tier, reason, budgetUsd }) => {
      requireFolder(cwd);
      return approveTask(cwd, id, contract, tier, reason, budgetUsd);
    },

    "task.revise": ({ cwd, id }) => {
      requireFolder(cwd);
      return reviseTask(cwd, id);
    },

    "task.cancel": ({ id }) => ({ cancelled: cancelTask(id) }),

    "task.start": async ({ cwd, id, permissionMode, model }) => {
      requireFolder(cwd);
      const host = sessionHost(await claude());
      return startTask(cwd, id, host, { permissionMode, ...(model ? { model } : {}) }, taskUpdated(cwd));
    },

    "task.resume": async ({ cwd, id }) => {
      requireFolder(cwd);
      return resumeTask(cwd, id, sessionHost(await claude()), taskUpdated(cwd));
    },

    "task.acceptRisk": ({ cwd, id, reason }) => {
      requireFolder(cwd);
      return acceptRisk(cwd, id, reason);
    },

    "task.evidence": ({ cwd, id }) => {
      requireFolder(cwd);
      return taskEvidence(cwd, id);
    },

    "task.lessons": async ({ cwd, id, model, stored }) => {
      requireFolder(cwd);
      if (stored) return { lessons: storedLessons(cwd, id), costUsd: 0 };
      return suggestLessons(await claude(), cwd, id, evidenceOf(cwd, id), model);
    },

    "task.lessonsPreview": ({ cwd, id, ids }) => {
      requireFolder(cwd);
      return previewLessons(cwd, id, ids, lessonOrigin(cwd, id));
    },

    "task.lessonsApply": ({ cwd, id, ids }) => {
      requireFolder(cwd);
      return applyLessons(cwd, id, ids, lessonOrigin(cwd, id), catalog.version);
    },

    "task.lessonsDismiss": ({ cwd, id, ids }) => {
      requireFolder(cwd);
      return { lessons: dismissLessons(cwd, id, ids) };
    },

    "task.split": async ({ cwd, id, model }) => {
      requireFolder(cwd);
      return splitTask(cwd, id, await claude(), model);
    },

    "task.approveSubtasks": ({ cwd, id }) => {
      requireFolder(cwd);
      return approveSubtasks(cwd, id);
    },

    "task.continue": async ({ cwd, id }) => {
      requireFolder(cwd);
      return continueTask(cwd, id, sessionHost(await claude()), taskUpdated(cwd));
    },

    "task.mergeResult": async ({ cwd, id }) => {
      requireFolder(cwd);
      await settleRun(id);
      return mergeResult(cwd, id);
    },

    "task.cleanup": async ({ cwd, id, deleteBranches }) => {
      requireFolder(cwd);
      await settleRun(id);
      cleanupTask(cwd, id, deleteBranches);
      return { ok: true };
    },

    "github.status": ({ cwd }) => {
      requireFolder(cwd);
      return githubStatus(cwd, systemGh());
    },

    "task.prPreview": async ({ cwd, id }) => {
      requireFolder(cwd);
      await settleRun(id);
      return prPreview(cwd, id, systemGh());
    },

    "task.createPr": async ({ cwd, id, title, draft }) => {
      requireFolder(cwd);
      await settleRun(id);
      return await createTaskPr(cwd, id, { title, draft }, systemGh());
    },

    "task.prStatus": ({ cwd, id }) => {
      requireFolder(cwd);
      return prStatus(cwd, id, systemGh());
    },

    "task.ciLog": async ({ cwd, id, link }) => {
      requireFolder(cwd);
      return { log: await ciLog(cwd, id, link, systemGh()) };
    },

    "task.fixCi": async ({ cwd, id, link }) => {
      requireFolder(cwd);
      await settleRun(id);
      return fixCiTask(cwd, id, link, sessionHost(await claude()), systemGh(), taskUpdated(cwd));
    },

    "task.mergeGates": async ({ cwd, id }) => {
      requireFolder(cwd);
      await settleRun(id);
      return mergeGates(cwd, id, systemGh());
    },

    "task.reviewPr": async ({ cwd, id }) => {
      requireFolder(cwd);
      await settleRun(id);
      return reviewPrTask(cwd, id, sessionHost(await claude()), systemGh(), taskUpdated(cwd));
    },

    "task.mergePr": async ({ cwd, id, method, headSha, acceptReason }) => {
      requireFolder(cwd);
      await settleRun(id);
      return mergePrTask(cwd, id, { method, headSha, ...(acceptReason ? { acceptReason } : {}) }, systemGh());
    },

    "deploy.targets": async ({ cwd }) => {
      requireFolder(cwd);
      return { targets: await deployTargets(cwd) };
    },

    "deploy.preview": async ({ cwd, id, adapter }) => {
      requireFolder(cwd);
      const record = await deployPreview(cwd, id, adapter);
      try {
        writeEvidence(cwd, loadTask(cwd, id));
      } catch {
        // The report is built again on request.
      }
      return record;
    },

    "deploy.plan": async ({ cwd, adapter }) => {
      requireFolder(cwd);
      return productionPlan(cwd, adapter);
    },

    "deploy.production": async ({ cwd, adapter, confirm, commit }) => {
      requireFolder(cwd);
      return deployProduction(cwd, adapter, { typed: confirm, commit });
    },

    "deploy.rollback": async ({ cwd, id, confirm }) => {
      requireFolder(cwd);
      return rollbackDeploy(cwd, id, confirm);
    },

    "deploy.setDockerImage": ({ cwd, image }) => {
      requireFolder(cwd);
      setDockerImage(cwd, image);
      return { ok: true as const };
    },

    "deploy.list": ({ cwd, taskId }) => {
      requireFolder(cwd);
      return { deploys: listDeploys(cwd, taskId) };
    },

    "workflow.list": ({ cwd }) => {
      requireFolder(cwd);
      const eff = workflowsOf(cwd);
      return { workflows: tierWorkflows(eff), problems: eff.problems };
    },

    "workflow.get": ({ cwd, tier }) => {
      requireFolder(cwd);
      return workflowSource(cwd, tier, shippedLibrary);
    },

    "workflow.generate": async ({ cwd, tier, description, current, model }) => {
      requireFolder(cwd);
      const { sdk, claudePath } = await claude();
      return generateWorkflow(sdk, claudePath, cwd, tier, current, { description }, shippedLibrary, {
        ...(model ? { model } : {}),
      });
    },

    "workflow.check": ({ tier, yaml }) => ({ error: checkWorkflowText(tier, yaml, shippedLibrary) }),

    "workflow.save": ({ cwd, tier, yaml }) => {
      requireFolder(cwd);
      try {
        saveProjectWorkflow(cwd, tier, yaml, shippedLibrary);
      } catch (err) {
        throw new RpcFailure(RpcErrorCode.invalidParams, err instanceof Error ? err.message : String(err));
      }
      return { ok: true as const };
    },

    "workflow.import": ({ path: file }) => {
      try {
        return { yaml: readWorkflowFile(file) };
      } catch (err) {
        throw new RpcFailure(RpcErrorCode.invalidParams, err instanceof Error ? err.message : String(err));
      }
    },

    "workflow.export": ({ path: file, yaml }) => {
      try {
        writeWorkflowFile(file, yaml);
      } catch (err) {
        throw new RpcFailure(RpcErrorCode.invalidParams, err instanceof Error ? err.message : String(err));
      }
      return { ok: true as const };
    },

    "metrics.summary": ({ cwd, since, tier }) => {
      requireFolder(cwd);
      return computeMetrics(loadAllTasks(cwd), { ...(since ? { since } : {}), ...(tier ? { tier } : {}) });
    },

    "task.overlaps": ({ cwd, id }) => {
      requireFolder(cwd);
      return { overlaps: overlapsOf(cwd, id) };
    },

    "task.list": ({ cwd }) => {
      requireFolder(cwd);
      return { tasks: listTasksLive(cwd) };
    },

    "task.get": ({ cwd, id }) => {
      requireFolder(cwd);
      return present(loadTask(cwd, id));
    },

    "task.delete": ({ cwd, id }) => {
      requireFolder(cwd);
      deleteTaskSafe(cwd, id);
      return { ok: true };
    },
  },
  () => {
    // Runs still going stay `running` on disk, so they read back as interrupted and can be resumed.
    shutdownRuns();
    scheduler.stop();
    for (const session of sessions.values()) session.close();
  },
);

log(`agentchainer-sidecar ready (protocol v${PROTOCOL_VERSION}, node ${process.version})`);
