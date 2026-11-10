import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentEvent,
  type ApprovalRecord,
  type Described,
  describeRequest,
  displayPath,
  type FleetItem,
  type GuardBlock,
  type PermissionRequest,
  type Task,
  type TaskTag,
} from "@agentchainer/protocol";
import { type AgyHost, agyBackend } from "../backends/agy.ts";
import { agentFor } from "../backends/choose.ts";
import { type ClaudeHost, claudeBackend } from "../backends/claude.ts";
import { type CodexHost, codexBackend } from "../backends/codex.ts";
import type { StepAgent, StepBackend, StepOptions, StepSession } from "../backends/types.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { GUARD_PREFIX } from "../guard.ts";
import { t } from "../i18n/index.ts";
import { git, repoOf } from "../workspace.ts";
import type { FileChange } from "./evidence.ts";
import { resolveGates, runGates } from "./gates.ts";
import type { AgentStep, Library } from "./library.ts";
import { type AgentOutcome, REVIEW_JSON_SCHEMA, type Runner } from "./orchestrator.ts";

/**
 * What the runner needs from the sidecar: the Claude CLI and the session registry (`register` adds a step's session
 * where `permission.respond` and `session.interrupt` find it), and the notifications of `main.ts`.
 */
export type SessionHost = ClaudeHost & {
  /** The user's own Codex CLI, when it's installed (M9-04): steps that name `agent: codex` run on it. */
  codex?: () => CodexHost | null;
  /** The user's own Antigravity CLI, when it's installed (M9-05): steps that name `agent: agy` run on it. */
  agy?: () => AgyHost | null;
  event(sessionId: string, event: AgentEvent, task: TaskTag): void;
  permission(sessionId: string, request: Omit<PermissionRequest, "sessionId" | "task">, task: TaskTag): void;
  /** A step's session changed its fleet status (M8-02). */
  status?(item: FleetItem): void;
};

const MAX_NEW_FILE_CHARS = 20_000;

/**
 * Where a run's changes are measured from: a commit of the tree as it was (`git stash create` records uncommitted
 * changes without touching anything), or HEAD when it was clean, and the files that were already untracked.
 */
export function startBase(root: string): { base: string | null; untrackedAtStart: string[] } {
  if (!repoOf(root)) return { base: null, untrackedAtStart: [] };
  const stash = git(["stash", "create"], root).stdout.trim();
  const head = git(["rev-parse", "-q", "--verify", "HEAD"], root).stdout.trim();
  return { base: stash || head || null, untrackedAtStart: untracked(root) };
}

/** Files git doesn't track and doesn't ignore, relative to `root`. */
export function untracked(root: string): string[] {
  return git(["--no-optional-locks", "ls-files", "-z", "--others", "--exclude-standard"], root)
    .stdout.split("\0")
    .filter(Boolean);
}

/** The paths a task changed since its base: tracked files that differ, and files created since. */
export function changedPaths(root: string, base: string | null, untrackedAtStart: string[]): string[] {
  if (!repoOf(root)) return [];
  const tracked = base
    ? git(["--no-optional-locks", "diff", "--name-only", "--no-renames", base, "--", "."], root).stdout.split("\n")
    : [];
  const before = new Set(untrackedAtStart);
  const added = untracked(root).filter((f) => !before.has(f));
  return [...new Set([...tracked, ...added])].filter((f) => f && !f.startsWith(".agentchainer/"));
}

/** The task's changes since its base: tracked files' diff, plus files created since, shown as new. */
export function taskDiff(root: string, base: string | null, untrackedAtStart: string[]): string {
  if (!repoOf(root)) return "";
  const tracked = base
    ? git(["--no-optional-locks", "diff", "--no-color", "--no-ext-diff", base, "--", "."], root).stdout
    : "";
  const before = new Set(untrackedAtStart);
  const added = untracked(root)
    .filter((f) => !before.has(f) && !f.startsWith(".agentchainer/"))
    .map((f) => {
      let text: string;
      try {
        text = readFileSync(path.join(root, ...f.split("/")), "utf8");
      } catch {
        text = "";
      }
      const capped = text.length > MAX_NEW_FILE_CHARS ? `${text.slice(0, MAX_NEW_FILE_CHARS)}\n… (truncated)` : text;
      return `diff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${capped
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n")}`;
    });
  return [tracked.trim(), ...added].filter(Boolean).join("\n");
}

/** The files changed since the run's base, with line counts, for the evidence (M3-09). */
export function fileStats(root: string, base: string | null, untrackedAtStart: string[]): FileChange[] {
  if (!repoOf(root)) return [];
  const out: FileChange[] = [];
  if (base) {
    const statuses = new Map<string, string>();
    for (const line of git(
      ["--no-optional-locks", "diff", "--name-status", "--relative", base, "--", "."],
      root,
    ).stdout.split("\n")) {
      const [code, file] = line.split("\t");
      if (code && file) statuses.set(file, code);
    }
    for (const line of git(
      ["--no-optional-locks", "diff", "--numstat", "--relative", base, "--", "."],
      root,
    ).stdout.split("\n")) {
      const [added, removed, file] = line.split("\t");
      if (!file || file.startsWith(".agentchainer/")) continue;
      const code = statuses.get(file) ?? "M";
      out.push({
        path: file,
        status: code.startsWith("D") ? "deleted" : code.startsWith("A") ? "new" : "modified",
        added: added === "-" ? null : Number(added),
        removed: removed === "-" ? null : Number(removed),
      });
    }
  }
  const before = new Set(untrackedAtStart);
  for (const file of untracked(root)) {
    if (before.has(file) || file.startsWith(".agentchainer/")) continue;
    let lines: number | null = 0;
    try {
      const text = readFileSync(path.join(root, ...file.split("/")));
      lines = text.includes(0)
        ? null
        : text
            .toString("utf8")
            .split("\n")
            .filter((l, i, all) => l || i < all.length - 1).length;
    } catch {
      lines = null;
    }
    out.push({ path: file, status: "new", added: lines, removed: 0 });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** What a tool call touches, as the approval dialog shows it. */
function targetOf(d: Described, tool: string, root: string): string {
  if (d.kind === "command") return d.command;
  if (d.kind === "edit") return displayPath(d.path, root);
  if (d.kind === "read" || d.kind === "web") return displayPath(d.target, root);
  if (d.kind === "mcp") return `${d.server}/${d.tool}`;
  return tool;
}

/** Where the runner reports what the run's records keep: approvals and guard blocks (M3-09 security notes). */
export type RunRecorder = { approval(record: ApprovalRecord): void; guardBlock(block: GuardBlock): void };

/** A multi-folder task's other folder (M8-01): its name, its code folder, and where its changes count from. */
export type OtherFolder = { name: string; dir: string; base: string | null; untracked: string[] };

/** Runs a task's steps as real Claude sessions and its gates as the project's commands. */
export function sessionRunner(
  root: string,
  task: Task,
  library: Library,
  host: SessionHost,
  recorder: RunRecorder,
  others: OtherFolder[] = [],
): Runner {
  const run = task.run;
  if (!run) throw new Error("The task has no run.");
  /** Write steps' sessions, kept open for their fix rounds. */
  const live = new Map<string, StepSession>();
  /** Every session still open, to stop or close them. */
  const open = new Set<StepSession>();
  /** The agents steps run on (ADR-0012): Claude, and the user's own Codex or Antigravity CLI when a step names it. */
  const backends: Partial<Record<StepAgent, StepBackend>> = { claude: claudeBackend(host) };
  const backendFor = (step: AgentStep): StepBackend => {
    // The step's own agent, else the task's for its role, else Claude (ADR-0012 §5).
    const agent = agentFor(step, run.agents);
    if (agent === "codex" && !backends.codex) {
      const codex = host.codex?.();
      if (!codex) throw new Error(t("tasks.runner.codexMissing"));
      backends.codex = codexBackend(codex);
    }
    if (agent === "agy" && !backends.agy) {
      const agy = host.agy?.();
      if (!agy) throw new Error(t("tasks.runner.agyMissing"));
      backends.agy = agyBackend(agy);
    }
    const backend = backends[agent];
    if (!backend) throw new Error(t("tasks.runner.agentNotYet", { agent }));
    return backend;
  };
  /** The tag each session's events carry now: it follows the timeline entry (a step, then its fixes). */
  /** By session, not id: an agy step only learns its conversation's id once its first turn starts (M9-05). */
  const tags = new Map<StepSession, TaskTag>();
  let gatesAbort: AbortController | null = null;
  /** Sessions in a turn now, newest last, with whether each is a write step's: where the person's message goes. */
  const inTurn: { session: StepSession; write: boolean }[] = [];
  /** Tool calls in progress, to tell what a guard block was. */
  const started = new Map<string, { tool: string; input: Record<string, unknown> }>();

  const openSession = async (step: AgentStep, budgetUsd: number, resume?: string): Promise<StepSession> => {
    const role = library.roles[step.role];
    if (!role) throw new Error(`No role ${step.role} in the library.`);
    const model = role.model !== "inherit" ? role.model : run.model;
    const options: StepOptions = {
      cwd: root,
      // The other folders' worktrees, so a step reaches them and the guard allows them (M8-01).
      ...(others.length ? { additionalDirectories: others.map((o) => o.dir) } : {}),
      ...(model ? { model } : {}),
      // Read steps only have read tools, which need no approval; write steps ask in the profile picked at Run.
      permissionMode: step.access === "write" ? run.permissionMode : "default",
      // A task with no budget gives its write step no cap at all (UX-13).
      ...(Number.isFinite(budgetUsd) ? { maxBudgetUsd: budgetUsd } : {}),
      readOnly: step.access === "read",
      appendSystemPrompt: role.prompt,
      maxTurns: step.limits.maxTurns,
      ...(step.output === "review" ? { outputFormat: { type: "json_schema", schema: REVIEW_JSON_SCHEMA } } : {}),
      ...(resume ? { resume } : {}),
    };
    // Set once the backend has opened it: a backend may emit while it opens (Codex's `session.started`), before the
    // step is tagged, and those events have no tag to go out with.
    let opened: StepSession | undefined;
    const idOf = () => opened?.id ?? "";
    const session: StepSession = await backendFor(step)(options, {
      emit: (event) => {
        const tag = opened ? tags.get(opened) : undefined;
        if (event.type === "tool.started")
          started.set(event.toolUseId, { tool: event.name, input: (event.input ?? {}) as Record<string, unknown> });
        if (event.type === "tool.completed") {
          const call = started.get(event.toolUseId);
          started.delete(event.toolUseId);
          const at = event.output.indexOf(GUARD_PREFIX);
          if (call && tag && event.isError && at !== -1) {
            recorder.guardBlock({
              stepId: tag.stepId,
              tool: call.tool,
              target: targetOf(describeRequest(call.tool, call.input, root), call.tool, root),
              reason:
                event.output
                  .slice(at + GUARD_PREFIX.length)
                  .split("\n")[0]
                  ?.trim() ?? "",
              at: new Date().toISOString(),
            });
          }
        }
        if (tag) host.event(idOf(), event, tag);
      },
      answered: (request, answer) => {
        const tag = opened ? tags.get(opened) : undefined;
        if (!tag) return;
        const described = describeRequest(request.toolName, request.input, root);
        recorder.approval({
          stepId: tag.stepId,
          label: tag.label,
          tool: request.toolName,
          target: targetOf(described, request.toolName, root),
          risk: described.risk.level,
          reasons: described.risk.reasons,
          allowed: answer.allow,
          always: answer.always === true,
          at: new Date().toISOString(),
        });
      },
      askPermission: (request) => {
        const tag = opened ? tags.get(opened) : undefined;
        if (tag) host.permission(idOf(), request, tag);
      },
      statusChanged: (item) => host.status?.(item),
      onEnd: () => {
        if (!opened) return;
        open.delete(opened);
        if (live.get(step.id) === opened) live.delete(step.id);
      },
    });
    opened = session;
    open.add(session);
    return session;
  };

  const turn = async (step: AgentStep, session: StepSession, prompt: string, write = false): Promise<AgentOutcome> => {
    const entry = { session, write };
    inTurn.push(entry);
    try {
      const r = await session.turn(prompt);
      return {
        sessionId: session.id,
        ok: r.subtype === "success" && !r.isError,
        subtype: r.subtype,
        text: r.text,
        ...(r.structured !== undefined ? { structured: r.structured } : {}),
        costUsd: r.costUsd,
        agent: agentFor(step, run.agents),
        ...(r.model ? { model: r.model } : {}),
        ...(r.costKind ? { costKind: r.costKind } : {}),
        ...(r.tokens ? { tokens: r.tokens } : {}),
      };
    } catch {
      return {
        sessionId: session.id,
        ok: false,
        subtype: "ended",
        text: "",
        costUsd: 0,
        agent: agentFor(step, run.agents),
      };
    } finally {
      inTurn.splice(inTurn.indexOf(entry), 1);
    }
  };

  return {
    async start(step, prompt, budgetUsd, tag) {
      const session = await openSession(step, budgetUsd);
      tags.set(session, { ...tag, cwd: root });
      session.tag = { ...tag, cwd: root };
      if (step.access === "write") live.set(step.id, session);
      const out = await turn(step, session, prompt, step.access === "write");
      if (step.access === "read") void session.close();
      return out;
    },
    async followUp(step, sessionId, prompt, budgetUsd, tag) {
      let session = live.get(step.id);
      if (!session || session.id !== sessionId) {
        // After a restart: continue the step's stored session.
        session = await openSession(step, budgetUsd, sessionId);
        live.set(step.id, session);
      }
      tags.set(session, { ...tag, cwd: root });
      session.tag = { ...tag, cwd: root };
      return turn(step, session, prompt, true);
    },
    agentOf: (step) => agentFor(step, run.agents),
    async gates(kinds, round) {
      // Each folder runs its own commands (M8-01); a gate counts as run when any folder has it.
      const folders = [{ name: undefined, dir: root }, ...others];
      const plans = folders.map((f) => ({ ...f, commands: resolveGates(f.dir, detectWorkspace(f.dir), kinds) }));
      const notRun = kinds.filter((k) => !plans.some((p) => p.commands.some((c) => c.kind === k)));
      gatesAbort = new AbortController();
      try {
        const runs = [];
        for (const p of plans) {
          if (!p.commands.length) continue;
          const done = await runGates(p.dir, p.commands, round, gatesAbort.signal);
          // The folder's name leads its package, so every gate's key and log line tells the folders apart.
          const name = p.name;
          runs.push(
            ...(name
              ? done.map((r) => ({ ...r, folder: name, package: r.package === "." ? name : `${name}:${r.package}` }))
              : done),
          );
        }
        return { runs, notRun };
      } finally {
        gatesAbort = null;
      }
    },
    diff: () =>
      [
        taskDiff(root, run.base, run.untrackedAtStart),
        ...others.map((o) => `# In the folder ${o.name}\n${taskDiff(o.dir, o.base, o.untracked)}`),
      ].join("\n"),
    message(text) {
      // A write step's session first: parallel read steps run beside it only in planning.
      const target = [...inTurn].reverse().find((e) => e.write) ?? inTurn.at(-1);
      return target ? target.session.inject(text) : false;
    },
    stop() {
      gatesAbort?.abort();
      for (const s of open) void s.close();
    },
    async close() {
      await Promise.all([...open].map((s) => s.close()));
    },
  };
}
