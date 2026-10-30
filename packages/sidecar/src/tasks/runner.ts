import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent, PermissionRequest, Task, TaskTag } from "@agentchainer/protocol";
import { detectWorkspace } from "../detect/detect.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { Session } from "../session.ts";
import { git, repoOf } from "../workspace.ts";
import { resolveGates, runGates } from "./gates.ts";
import type { AgentStep, Library } from "./library.ts";
import { type AgentOutcome, REVIEW_JSON_SCHEMA, type Runner } from "./orchestrator.ts";

/** What the runner needs from the sidecar: the SDK, and the session registry and notifications of `main.ts`. */
export type SessionHost = {
  sdk: AgentSdkModule;
  claudePath: string;
  /** Adds a step's session where `permission.respond` and `session.interrupt` find it. */
  register(session: Session): void;
  unregister(sessionId: string): void;
  event(sessionId: string, event: AgentEvent, task: TaskTag): void;
  permission(sessionId: string, request: Omit<PermissionRequest, "sessionId" | "task">, task: TaskTag): void;
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

function untracked(root: string): string[] {
  return git(["--no-optional-locks", "ls-files", "-z", "--others", "--exclude-standard"], root)
    .stdout.split("\0")
    .filter(Boolean);
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

/** Runs a task's steps as real Claude sessions and its gates as the project's commands. */
export function sessionRunner(root: string, task: Task, library: Library, host: SessionHost): Runner {
  const run = task.run;
  if (!run) throw new Error("The task has no run.");
  /** Write steps' sessions, kept open for their fix rounds. */
  const live = new Map<string, Session>();
  /** Every session still open, to stop or close them. */
  const open = new Set<Session>();
  /** The tag each session's events carry now: it follows the timeline entry (a step, then its fixes). */
  const tags = new Map<string, TaskTag>();
  let gatesAbort: AbortController | null = null;

  const openSession = (step: AgentStep, budgetUsd: number, resume?: string): Session => {
    const role = library.roles[step.role];
    if (!role) throw new Error(`No role ${step.role} in the library.`);
    const model = role.model !== "inherit" ? role.model : run.model;
    const session: Session = new Session(
      host.sdk,
      {
        cwd: root,
        claudePath: host.claudePath,
        ...(model ? { model } : {}),
        // Read steps only have read tools, which need no approval; write steps ask in the profile picked at Run.
        permissionMode: step.access === "write" ? run.permissionMode : "default",
        maxBudgetUsd: budgetUsd,
        readOnly: step.access === "read",
        appendSystemPrompt: role.prompt,
        maxTurns: step.limits.maxTurns,
        ...(step.output === "review" ? { outputFormat: { type: "json_schema", schema: REVIEW_JSON_SCHEMA } } : {}),
        ...(resume ? { resume } : {}),
      },
      {
        emit: (event) => {
          const tag = tags.get(session.id);
          if (tag) host.event(session.id, event, tag);
        },
        askPermission: (request) => {
          const tag = tags.get(session.id);
          if (tag) host.permission(session.id, request, tag);
        },
        onEnd: () => {
          open.delete(session);
          host.unregister(session.id);
          if (live.get(step.id) === session) live.delete(step.id);
        },
      },
    );
    open.add(session);
    host.register(session);
    return session;
  };

  const turn = async (session: Session, prompt: string): Promise<AgentOutcome> => {
    try {
      const r = await session.turn(prompt);
      return {
        sessionId: session.id,
        ok: r.subtype === "success" && !r.isError,
        subtype: r.subtype,
        text: r.text,
        ...(r.structured !== undefined ? { structured: r.structured } : {}),
        costUsd: r.costUsd,
      };
    } catch {
      return { sessionId: session.id, ok: false, subtype: "ended", text: "", costUsd: 0 };
    }
  };

  return {
    async start(step, prompt, budgetUsd, tag) {
      const session = openSession(step, budgetUsd);
      tags.set(session.id, { ...tag, cwd: root });
      if (step.access === "write") live.set(step.id, session);
      const out = await turn(session, prompt);
      if (step.access === "read") session.close();
      return out;
    },
    async followUp(step, sessionId, prompt, budgetUsd, tag) {
      let session = live.get(step.id);
      if (!session || session.id !== sessionId) {
        // After a restart: continue the step's stored session.
        session = openSession(step, budgetUsd, sessionId);
        live.set(step.id, session);
      }
      tags.set(session.id, { ...tag, cwd: root });
      return turn(session, prompt);
    },
    async gates(kinds, round) {
      const commands = resolveGates(root, detectWorkspace(root), kinds);
      const notRun = kinds.filter((k) => !commands.some((c) => c.kind === k));
      gatesAbort = new AbortController();
      try {
        return { runs: await runGates(root, commands, round, gatesAbort.signal), notRun };
      } finally {
        gatesAbort = null;
      }
    },
    diff: () => taskDiff(root, run.base, run.untrackedAtStart),
    stop() {
      gatesAbort?.abort();
      for (const s of open) s.close();
    },
    close() {
      for (const s of open) s.close();
    },
  };
}
