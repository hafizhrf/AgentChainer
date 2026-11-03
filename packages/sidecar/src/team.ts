import type { AgentEvent, Effort, PermissionRequest, SessionOpened } from "@agentchainer/protocol";
import { z } from "zod";
import { type Profile, profileOptions } from "./profiles.ts";
import type { AgentSdkModule } from "./sdk-loader.ts";
import { APP_TOOLS, Session, type TurnResult } from "./session.ts";

/**
 * A Team chat (M8-03, docs/design/supervisor.md): a supervisor session that hands work to worker sessions through the
 * app's in-process MCP server. Workers share the supervisor's folders, read-only unless the supervisor asks for
 * `write`; their tool calls are asked about in their own tabs as usual. One cap covers the supervisor and its workers.
 */

/** Live workers at once; a closed worker frees its place. */
export const MAX_WORKERS = 4;
/** Below this much left of the cap, no worker starts (as for a task's steps). */
export const MIN_WORKER_BUDGET_USD = 0.05;

/** Added to a worker's system prompt. */
export const WORKER_PROMPT =
  "You are a worker session for a supervisor agent, which gave you the assignment in the user message. It can't see " +
  "your work, only your final answer: finish the assignment, then end with a concise report of what you found or " +
  "changed, with file paths.";

/** The supervisor's MCP server instructions: how its tools fit together. */
export const TEAM_INSTRUCTIONS =
  "These tools run worker sessions in the same folders as you. Workers start with no memory of this chat, so give " +
  "each a self-contained prompt. Use `assign` to run workers in parallel: their reports reach you as messages that " +
  "start with [From worker …] once you're idle, or earlier through `read_inbox`. Use `handoff` when you need the " +
  'answer before going on. `access: "read"` (the default) allows Read, Grep and Glob only; ask for "write" only ' +
  `when the worker must change files, and the person approves its changes. At most ${MAX_WORKERS} workers are open ` +
  "at once; `close_worker` frees a place. The person shares one budget across you and your workers.";

export type Access = "read" | "write";

/** What the Team needs of a session; `Session` has it, and the tests fake it. */
export type Member = {
  readonly id: string;
  readonly idle: boolean;
  readonly costUsd: number;
  send(text: string): string;
  inject(text: string): boolean;
  close(): Promise<void>;
};

/** `profile`: an agent profile the worker runs as (M8-04). */
export type WorkerSpec = { name: string; access: Access; maxBudgetUsd: number; profile?: Profile };

/** How a Team opens workers and reaches its supervisor's transcript. */
export type TeamHost = {
  /** Opens a worker session, whose turn ends and end go to `on`. */
  open(spec: WorkerSpec, on: { turnEnded(result: TurnResult): void; ended(): void }): Member;
  /** An event on the supervisor's transcript. */
  emit(event: AgentEvent): void;
};

export type InboxEntry = { workerId: string; name: string; text: string; isError: boolean; costUsd: number };

export type WorkerInfo = {
  workerId: string;
  name: string;
  access: Access;
  status: "working" | "idle" | "ended";
  costUsd: number;
  lastReport?: string;
};

export type Handoff = { workerId: string; text: string; isError: boolean; costUsd: number };

type Worker = {
  member: Member;
  name: string;
  access: Access;
  ended: boolean;
  lastReport?: string;
  /** `handoff` calls waiting for this worker's next turn to end, oldest first. */
  waiters: ((result: Handoff) => void)[];
};

/** A refusal the model reads as the tool's error. */
export class TeamError extends Error {}

export class Team {
  private supervisor: Member | null = null;
  private readonly workers = new Map<string, Worker>();
  private inbox: InboxEntry[] = [];
  private stopped = false;

  readonly capUsd: number;
  private readonly host: TeamHost;
  /** Loads an agent profile by name (M8-04); throws when there's none, or it has problems. */
  private readonly findProfile: (name: string) => Profile;

  constructor(
    capUsd: number,
    host: TeamHost,
    findProfile: (name: string) => Profile = (name) => {
      throw new Error(`There is no agent profile named ${name}.`);
    },
  ) {
    this.capUsd = capUsd;
    this.host = host;
    this.findProfile = findProfile;
  }

  /** The supervisor's session exists only once the Team's tools do, so it's attached after. */
  attach(supervisor: Member): void {
    this.supervisor = supervisor;
  }

  /** The supervisor and every worker, closed ones included. */
  get spentUsd(): number {
    let spent = this.supervisor?.costUsd ?? 0;
    for (const w of this.workers.values()) spent += w.member.costUsd;
    return spent;
  }

  /** Starts a worker (or reuses an idle one) on `prompt`. Resolves at once, or with its answer when `wait`. */
  async assign(
    args: { name: string; prompt: string; access?: Access; budgetUsd?: number; worker?: string; profile?: string },
    wait: boolean,
  ): Promise<{ workerId: string } | Handoff> {
    if (this.stopped) throw new TeamError("The team's budget is spent, so no more work can be handed out.");
    let w: Worker;
    if (args.worker) {
      w = this.live(args.worker);
      if (!w.member.idle) throw new TeamError(`Worker ${args.worker} is busy; use send_message to add to its turn.`);
    } else {
      const open = [...this.workers.values()].filter((x) => !x.ended).length;
      if (open >= MAX_WORKERS) {
        throw new TeamError(`${MAX_WORKERS} workers are open already; close one with close_worker first.`);
      }
      const left = this.capUsd - this.spentUsd;
      if (left < MIN_WORKER_BUDGET_USD) throw new TeamError("Too little of the team's budget is left for a worker.");
      const access = args.access ?? "read";
      let profile: Profile | undefined;
      if (args.profile) {
        try {
          profile = this.findProfile(args.profile);
        } catch (err) {
          throw new TeamError(err instanceof Error ? err.message : String(err));
        }
      }
      const maxBudgetUsd = args.budgetUsd ? Math.min(args.budgetUsd, left) : left;
      const name = args.name.trim() || "worker";
      // Set before `open` returns, since its handlers may only run later but must find it.
      let worker: Worker | undefined;
      const member = this.host.open(
        { name, access, maxBudgetUsd, ...(profile ? { profile } : {}) },
        {
          turnEnded: (r) => worker && this.workerTurnEnded(worker, r),
          ended: () => worker && this.workerEnded(worker),
        },
      );
      worker = { member, name, access, ended: false, waiters: [] };
      w = worker;
      this.workers.set(member.id, w);
    }
    const answer = wait ? new Promise<Handoff>((resolve) => w.waiters.push(resolve)) : null;
    w.member.send(args.prompt);
    return answer ? await answer : { workerId: w.member.id };
  }

  /** Adds `text` to the worker's running turn, or starts a turn whose report goes to the inbox. */
  message(workerId: string, text: string): { delivered: "into_turn" | "new_turn" } {
    if (this.stopped) throw new TeamError("The team's budget is spent.");
    const w = this.live(workerId);
    if (w.member.inject(text)) return { delivered: "into_turn" };
    w.member.send(text);
    return { delivered: "new_turn" };
  }

  /** The reports not yet delivered; they won't be delivered again. */
  readInbox(): InboxEntry[] {
    return this.inbox.splice(0);
  }

  list(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => ({
      workerId: w.member.id,
      name: w.name,
      access: w.access,
      status: w.ended ? "ended" : w.member.idle ? "idle" : "working",
      costUsd: w.member.costUsd,
      ...(w.lastReport !== undefined ? { lastReport: w.lastReport } : {}),
    }));
  }

  async closeWorker(workerId: string): Promise<void> {
    await this.live(workerId).member.close();
  }

  /** The supervisor's turn ended: the cap is checked, and waiting reports go out. */
  supervisorTurnEnded(): void {
    this.checkBudget();
    this.deliver();
  }

  /** The supervisor ended: so do its workers. */
  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].filter((w) => !w.ended).map((w) => w.member.close()));
  }

  private live(workerId: string): Worker {
    const w = this.workers.get(workerId);
    if (!w) throw new TeamError(`No worker ${workerId}; list_workers shows them.`);
    if (w.ended) throw new TeamError(`Worker ${workerId} has ended.`);
    return w;
  }

  private workerTurnEnded(w: Worker, r: TurnResult): void {
    const text = r.isError ? `The worker's turn stopped: ${r.subtype}.` : r.text;
    w.lastReport = text;
    const report = { workerId: w.member.id, text, isError: r.isError, costUsd: r.costUsd };
    const waiter = w.waiters.shift();
    if (waiter) waiter(report);
    else this.inbox.push({ ...report, name: w.name });
    this.checkBudget();
    this.deliver();
  }

  private workerEnded(w: Worker): void {
    w.ended = true;
    for (const waiter of w.waiters.splice(0)) {
      waiter({ workerId: w.member.id, text: "The worker's session ended first.", isError: true, costUsd: 0 });
    }
  }

  /** Once the supervisor is idle, every waiting report goes to it in one message. */
  private deliver(): void {
    const s = this.supervisor;
    if (this.stopped || !s?.idle || this.inbox.length === 0) return;
    const entries = this.inbox.splice(0);
    for (const e of entries) {
      this.host.emit({ type: "worker.message", workerId: e.workerId, name: e.name, text: e.text, isError: e.isError });
    }
    s.send(entries.map((e) => `[From worker "${e.name}" (${e.workerId})]\n${e.text}`).join("\n\n"));
  }

  private checkBudget(): void {
    const spentUsd = this.spentUsd;
    const reached = spentUsd >= this.capUsd;
    if (reached && !this.stopped) {
      this.stopped = true;
      void this.close();
    }
    this.host.emit({ type: "team.budget", spentUsd, capUsd: this.capUsd, stopped: this.stopped });
  }
}

/** An MCP tool's result, as the SDK's `tool()` handlers return it. */
type CallToolResult = Awaited<ReturnType<Parameters<AgentSdkModule["tool"]>[3]>>;

const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refused = (err: unknown): CallToolResult => ({
  content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});
const run = async (f: () => unknown): Promise<CallToolResult> => {
  try {
    return ok(await f());
  } catch (err) {
    return refused(err);
  }
};

const assignShape = {
  name: z.string().max(60).describe("A short name for the worker, shown on its tab, e.g. 'api-tests'."),
  prompt: z.string().min(1).describe("The assignment, self-contained: the worker can't see this chat."),
  access: z.enum(["read", "write"]).optional().describe('"read" (default): Read, Grep and Glob only.'),
  budgetUsd: z.number().positive().optional().describe("A cap for this worker, within the team's budget."),
  worker: z.string().optional().describe("An idle worker's id to give this to, instead of starting a new one."),
  profile: z
    .string()
    .optional()
    .describe("An agent profile for a new worker: its instructions, model and tools (listed in the instructions)."),
};

/** The supervisor's instructions, with the agent profiles a worker can run as (M8-04). */
export function teamInstructions(profiles: { name: string; description: string }[]): string {
  if (profiles.length === 0) return TEAM_INSTRUCTIONS;
  const list = profiles.map((p) => `- ${p.name}: ${p.description.split("\n")[0]}`).join("\n");
  return `${TEAM_INSTRUCTIONS}\n\nAgent profiles a worker can run as (\`profile\`), each with its own instructions and tools:\n${list}`;
}

/** The supervisor's tools, as the app's in-process MCP server (`mcp__agentchainer__*`). */
export function teamTools(sdk: AgentSdkModule, team: Team, profiles: { name: string; description: string }[] = []) {
  return sdk.createSdkMcpServer({
    name: APP_TOOLS,
    instructions: teamInstructions(profiles),
    alwaysLoad: true,
    tools: [
      sdk.tool(
        "assign",
        "Start a worker on an assignment and go on at once; its report arrives later as a message.",
        assignShape,
        (args) => run(() => team.assign(args, false)),
      ),
      sdk.tool(
        "handoff",
        "Start a worker on an assignment and wait for its report, returned as this tool's result.",
        assignShape,
        (args) => run(() => team.assign(args, true)),
      ),
      sdk.tool(
        "send_message",
        "Send a worker more instructions: added to its running turn, or starting a new one that reports back.",
        { worker: z.string(), text: z.string().min(1) },
        ({ worker, text }) => run(() => team.message(worker, text)),
      ),
      sdk.tool("read_inbox", "Workers' reports not delivered yet. Each is returned once.", {}, () =>
        run(() => team.readInbox()),
      ),
      sdk.tool("list_workers", "Every worker with its status, access, cost and last report.", {}, () =>
        run(() => team.list()),
      ),
      sdk.tool(
        "close_worker",
        "Close a worker you no longer need, freeing its place.",
        { worker: z.string() },
        ({ worker }) =>
          run(async () => {
            await team.closeWorker(worker);
            return { closed: worker };
          }),
      ),
    ],
  });
}

/** What a worker session takes from its supervisor's start. */
export type WorkerBase = {
  cwd: string;
  claudePath: string;
  model?: string;
  effort?: Effort;
  additionalDirectories?: string[];
};

/** Where the sidecar keeps its sessions and tells the UI about them; `main.ts` wires it. */
export type WorkerWiring = {
  register(session: Session): void;
  unregister(session: Session): void;
  opened(info: SessionOpened): void;
  event(sessionId: string, event: AgentEvent): void;
  permission(sessionId: string, request: Omit<PermissionRequest, "sessionId">): void;
  status(item: Session["fleetItem"]): void;
};

/** Opens workers as real sessions, each with its tab (`session.opened` comes before any of its events). */
export function sessionWorkers(
  sdk: AgentSdkModule,
  base: WorkerBase,
  parentId: () => string,
  wire: WorkerWiring,
): TeamHost["open"] {
  return (spec, on) => {
    const readOnly = spec.access === "read";
    // A profile's instructions come first, then how to report to the supervisor (M8-04).
    const own = spec.profile ? profileOptions(spec.profile, { readOnly }) : null;
    const worker: Session = new Session(
      sdk,
      {
        ...base,
        ...(own?.model ? { model: own.model } : {}),
        ...(own?.tools ? { tools: own.tools } : {}),
        ...(own?.disallowedTools ? { disallowedTools: own.disallowedTools } : {}),
        readOnly,
        appendSystemPrompt: own ? `${own.appendSystemPrompt}\n\n${WORKER_PROMPT}` : WORKER_PROMPT,
        maxBudgetUsd: spec.maxBudgetUsd,
      },
      {
        emit: (event) => wire.event(worker.id, event),
        askPermission: (request) => wire.permission(worker.id, request),
        statusChanged: (item) => wire.status(item),
        turnEnded: (r) => on.turnEnded(r),
        onEnd: () => {
          wire.unregister(worker);
          on.ended();
        },
      },
    );
    worker.parentId = parentId();
    wire.register(worker);
    wire.opened({
      sessionId: worker.id,
      parentId: parentId(),
      cwd: base.cwd,
      name: spec.name,
      access: spec.access,
      ...(spec.profile ? { profile: spec.profile.name } : {}),
    });
    return {
      id: worker.id,
      get idle() {
        return worker.idle;
      },
      get costUsd() {
        return worker.costUsd;
      },
      // The supervisor's words show in the worker's tab as the message that started its turn.
      send: (text) => {
        const messageId = worker.send(text);
        wire.event(worker.id, { type: "user.message", messageId, text });
        return messageId;
      },
      inject: (text) => worker.inject(text),
      close: () => worker.close(),
    };
  };
}
