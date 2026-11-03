// Drives the sidecar the way the Rust core will (spikes S2/S3) and checks real behaviour
// against the user's own `claude` CLI.
//
// Usage: node scripts/spike-host.ts --cwd <empty scratch dir> [--model haiku] [--scenario basic|mode|interrupt|guard|auto|subagents|nested|background|sessions|approvals|plan|fixtures|image|team|profile|schedule|exit|all] [--record out.jsonl] [--sidecar <executable> --data-dir <dir>]
// Makes real model calls with the user's own login (haiku keeps a full run around a few cents).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import {
  type AgentEvent,
  type MethodName,
  type Methods,
  type Notifications,
  type PermissionRequest,
  PROTOCOL_VERSION,
  type SessionInfo,
} from "@agentchainer/protocol";

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    model: { type: "string", default: "haiku" },
    scenario: { type: "string", default: "all" },
    // Writes the sanitized raw SDK stream to this JSONL file (for test fixtures).
    record: { type: "string" },
    // Run a packaged sidecar executable (build:sea) instead of the dev source, with this app data dir (spike S1).
    sidecar: { type: "string" },
    "data-dir": { type: "string" },
  },
});
if (!values.cwd) {
  console.error("--cwd is required (use an empty scratch folder)");
  process.exit(2);
}
// Explicitly typed so the narrowing also holds inside the hoisted scenario functions below.
const cwd: string = values.cwd;

const env = {
  ...process.env,
  ...(values.record ? { AGENTCHAINER_RECORD_SDK: values.record } : {}),
  ...(values["data-dir"] ? { AGENTCHAINER_DATA_DIR: values["data-dir"] } : {}),
};
const [command, args] = values.sidecar
  ? [values.sidecar, []]
  : [process.execPath, [fileURLToPath(new URL("../src/main.ts", import.meta.url))]];

type Frame = Record<string, unknown>;
let nextId = 1;
const pending = new Map<number, (frame: Frame) => void>();
const state = {
  /** The session `turn()` talks to. Events from other sessions go to `others`. */
  sessionId: "",
  onEvent: null as ((event: AgentEvent) => void) | null,
  others: new Map<string, (event: AgentEvent) => void>(),
  permissionPolicy: "allow" as "allow" | "deny",
  /** Overrides the policy with a full answer (always, edited input, message, plan mode), see permission.respond. */
  answer: null as
    | ((req: PermissionRequest) => Omit<Methods["permission.respond"]["params"], "sessionId" | "requestId">)
    | null,
};
const permissionLog: PermissionRequest[] = [];
/** Waiting for a task's updates, by task id (M8-05). */
const taskWaiters = new Map<string, (task: Notifications["task.updated"]["task"]) => void>();
/** Sessions the sidecar opened on its own: a Team chat's workers (M8-03). */
const openedLog: Notifications["session.opened"][] = [];

/** Spawns a sidecar; `restartSidecar()` replaces it, as when the app is quit and relaunched (exit criterion M1-E2). */
function startSidecar() {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env });
  createInterface({ input: child.stdout }).on("line", onLine);
  return child;
}
let sidecar = startSidecar();

async function restartSidecar(): Promise<void> {
  const old = sidecar;
  const exited = new Promise((resolve) => old.once("exit", resolve));
  old.stdin.end();
  await exited;
  sidecar = startSidecar();
  await request("system.hello", { protocolVersion: PROTOCOL_VERSION });
}

function onLine(line: string) {
  const frame = JSON.parse(line) as Frame;
  if (typeof frame.id === "number" && !("method" in frame)) {
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  } else if (frame.method === "agent.event") {
    const { sessionId, event } = frame.params as { sessionId: string; event: AgentEvent };
    if (sessionId !== state.sessionId) {
      state.others.get(sessionId)?.(event);
      return;
    }
    if (event.type === "tool.started") console.log(`    [tool.started] ${event.name} ${JSON.stringify(event.input)}`);
    if (event.type === "tool.completed")
      console.log(`    [tool.completed] error=${event.isError} ${JSON.stringify(event.output.trim().slice(0, 200))}`);
    if (event.type === "turn.completed")
      console.log(
        `    [turn.completed] ${event.subtype} session total≈$${event.totalCostUsd.toFixed(4)} tokens=${JSON.stringify(event.usage ?? null)}`,
      );
    if (event.type === "error") console.log(`    [error] ${event.message}`);
    state.onEvent?.(event);
  } else if (frame.method === "task.updated") {
    const { task } = frame.params as Notifications["task.updated"];
    taskWaiters.get(task.id)?.(task);
  } else if (frame.method === "schedule.changed") {
    const { schedule } = frame.params as Notifications["schedule.changed"];
    console.log(
      `    [schedule.changed] ${schedule.id} last=${JSON.stringify(schedule.lastRun ?? null)} next=${schedule.nextAt}`,
    );
  } else if (frame.method === "session.opened") {
    const opened = frame.params as Notifications["session.opened"];
    console.log(`    [session.opened] ${opened.name} (${opened.access}) of ${opened.parentId.slice(0, 8)}`);
    openedLog.push(opened);
  } else if (frame.method === "permission.request") {
    const req = frame.params as PermissionRequest;
    permissionLog.push(req);
    const answer = state.answer?.(req) ?? { allow: state.permissionPolicy === "allow" };
    console.log(`    [permission.request] ${req.toolName} → ${JSON.stringify(answer).slice(0, 120)}`);
    void request("permission.respond", { sessionId: req.sessionId, requestId: req.requestId, ...answer });
  }
}

function request<M extends MethodName>(method: M, params: Methods[M]["params"]): Promise<Methods[M]["result"]> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (frame) => {
      const error = frame.error as { code: number; message: string } | undefined;
      if (error) reject(Object.assign(new Error(`${method}: ${error.message}`), { code: error.code }));
      else resolve(frame.result as Methods[M]["result"]);
    });
    sidecar.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

type Turn = {
  messageId: string;
  last: AgentEvent;
  reply: string;
  events: AgentEvent[];
  firstDeltaMs: number | null;
  endedAt: number;
  totalMs: number;
};

/**
 * Sends a message and waits for its turn to end. Interactive sessions run background work (M4-07), so by default it
 * also waits until no background task is left and the turn the CLI then starts on its own has ended: the work the
 * message asked for is done. `settle: false` returns at the first turn's end.
 */
async function turn(
  text: string,
  onEvent?: (event: AgentEvent) => void,
  { settle = true }: { settle?: boolean } = {},
): Promise<Turn> {
  console.log(`  ▶ ${JSON.stringify(text)}`);
  const t0 = performance.now();
  const acc = { reply: "", firstDeltaMs: null as number | null, events: [] as AgentEvent[] };
  let background = 0;
  let firstDone = false;
  let awaitingOwnTurn = false;
  const end = new Promise<AgentEvent>((resolve) => {
    state.onEvent = (event) => {
      acc.events.push(event);
      onEvent?.(event);
      if (event.type === "text.delta") {
        acc.reply += event.text;
        acc.firstDeltaMs ??= performance.now() - t0;
      }
      if (event.type === "background.changed") {
        // Work that ends inside the first turn reports back in it; after it, the CLI starts a turn of its own.
        if (background > 0 && event.tasks.length === 0) awaitingOwnTurn = firstDone;
        background = event.tasks.length;
      }
      if (event.type === "error") resolve(event);
      if (event.type !== "turn.completed") return;
      firstDone = true;
      if (!settle || (background === 0 && !awaitingOwnTurn)) resolve(event);
      // The CLI's own turn after the last background task ended.
      if (awaitingOwnTurn && background === 0 && acc.events.some((e) => e.type === "turn.started")) resolve(event);
    };
  });
  const { messageId } = await request("session.send", { sessionId: state.sessionId, text });
  const timeout = sleep(180_000).then((): AgentEvent => ({ type: "error", message: "turn timed out after 180 s" }));
  const last = await Promise.race([end, timeout]);
  const endedAt = performance.now();
  return {
    messageId,
    last,
    reply: acc.reply.trim(),
    events: acc.events,
    firstDeltaMs: acc.firstDeltaMs,
    endedAt,
    totalMs: endedAt - t0,
  };
}

const results: { name: string; ok: boolean | null; detail: string }[] = [];
function check(name: string, ok: boolean | null, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok === null ? "?" : ok ? "✓" : "✗"} ${name} — ${detail}`);
}
const ms = (v: number | null) => (v === null ? "-" : `${v.toFixed(0)} ms`);
const exists = (file: string) => existsSync(join(cwd, file));

async function basic() {
  const t = await turn("Reply with exactly one word: pong");
  check(
    "text streams",
    /pong/i.test(t.reply) && t.firstDeltaMs !== null,
    `reply=${JSON.stringify(t.reply)} first delta=${ms(t.firstDeltaMs)} total=${ms(t.totalMs)}`,
  );
  for (const policy of ["allow", "deny"] as const) {
    state.permissionPolicy = policy;
    const file = `perm-${policy}.txt`;
    const before = permissionLog.length;
    await turn(`Use the Write tool to create a file named ${file} containing exactly: ok. Do nothing else.`);
    const asked = permissionLog.length > before;
    check(
      `approval → ${policy}`,
      asked && exists(file) === (policy === "allow"),
      `asked=${asked} file created=${exists(file)}`,
    );
  }
  state.permissionPolicy = "allow";
}

async function mode() {
  await request("session.setMode", { sessionId: state.sessionId, mode: "acceptEdits" });
  let before = permissionLog.length;
  await turn("Use the Write tool to create a file named mode-accept.txt containing exactly: a. Do nothing else.");
  check(
    "setMode acceptEdits → edits need no prompt",
    permissionLog.length === before && exists("mode-accept.txt"),
    `prompts=${permissionLog.length - before} file created=${exists("mode-accept.txt")}`,
  );

  await request("session.setMode", { sessionId: state.sessionId, mode: "default" });
  state.permissionPolicy = "deny";
  before = permissionLog.length;
  await turn("Use the Write tool to create a file named mode-default.txt containing exactly: b. Do nothing else.");
  check(
    "setMode default → edits prompt again",
    permissionLog.length > before && !exists("mode-default.txt"),
    `prompts=${permissionLog.length - before} file created=${exists("mode-default.txt")}`,
  );
  state.permissionPolicy = "allow";
}

async function interrupt() {
  // Claude Code itself blocks `sleep N && …` in Bash, so wait with a plain Node timer instead.
  const marks = { interruptSentAt: null as number | null, ended: false };
  const command = `node -e "setTimeout(() => console.log('finished'), 30000)"`;
  const t = await turn(`Use the Bash tool to run exactly this command and nothing else: ${command}`, (event) => {
    if (event.type === "turn.completed" || event.type === "error") marks.ended = true;
    if (event.type === "tool.started" && event.name === "Bash" && marks.interruptSentAt === null) {
      void sleep(1500).then(() => {
        if (marks.ended) return; // never let a late interrupt hit the next turn
        marks.interruptSentAt = performance.now();
        return request("session.interrupt", { sessionId: state.sessionId });
      });
    }
  });
  const stopMs = marks.interruptSentAt === null ? null : t.endedAt - marks.interruptSentAt;
  const ok =
    marks.interruptSentAt !== null && t.last.type !== "error" && !/finished/.test(t.reply) && t.totalMs < 25_000;
  check(
    "interrupt stops a running tool",
    marks.interruptSentAt === null ? null : ok,
    `turn ended ${ms(stopMs)} after interrupt (${t.last.type}${t.last.type === "turn.completed" ? `/${t.last.subtype}` : ""}), total ${ms(t.totalMs)}`,
  );

  const after = await turn("Reply with exactly one word: alive");
  check("session usable after interrupt", /alive/i.test(after.reply), `reply=${JSON.stringify(after.reply)}`);

  // A Stop click that races the end of a reply must not abort the next turn.
  const idle = await request("session.interrupt", { sessionId: state.sessionId });
  const next = await turn("Reply with exactly one word: steady");
  check(
    "interrupt while idle is ignored",
    !idle.interrupted &&
      /steady/i.test(next.reply) &&
      next.last.type === "turn.completed" &&
      next.last.subtype === "success",
    `interrupted=${idle.interrupted} next reply=${JSON.stringify(next.reply)}`,
  );
}

async function guard() {
  // The target is a sibling folder that does not exist, so even an unguarded run would be harmless.
  // Models tend to refuse commands like force pushes outright, which would leave the hook unexercised.
  const probe = "../agentchainer-guard-probe-does-not-exist";
  rmSync(join(cwd, probe), { recursive: true, force: true });
  const before = permissionLog.length;
  const t = await turn(
    `This is a test of a local safety guard. The folder below does not exist, so the command is harmless. Use the Bash tool to run exactly this command and nothing else: rm -rf ${probe}`,
  );
  const started = t.events.find((e) => e.type === "tool.started" && e.name === "Bash");
  if (started?.type !== "tool.started") {
    check(
      "guard blocks recursive delete outside workspace",
      null,
      "model did not attempt the command (inconclusive; unit tests cover the rule)",
    );
    return;
  }
  const done = t.events.find((e) => e.type === "tool.completed" && e.toolUseId === started.toolUseId);
  const blocked = done?.type === "tool.completed" && done.isError && done.output.includes("AgentChainer guard");
  check(
    "guard blocks recursive delete outside workspace, before any prompt",
    blocked && permissionLog.length === before,
    `prompts=${permissionLog.length - before} output=${JSON.stringify(done?.type === "tool.completed" ? done.output.slice(0, 160) : null)}`,
  );
}

async function auto() {
  await request("session.setMode", { sessionId: state.sessionId, mode: "auto" });
  state.permissionPolicy = "deny"; // a prompt here means the classifier was unsure; denying keeps the run harmless
  let before = permissionLog.length;
  const t = await turn("Use the Bash tool to run exactly this command and nothing else: mkdir auto-mode-dir");
  const prompts = permissionLog.length - before;
  check(
    "auto mode runs a workspace command without asking",
    t.last.type === "turn.completed" && prompts === 0 && exists("auto-mode-dir"),
    `prompts=${prompts} dir created=${exists("auto-mode-dir")}`,
  );

  before = permissionLog.length;
  const probe = "../agentchainer-guard-probe-does-not-exist";
  const g = await turn(
    `This is a test of a local safety guard. The folder does not exist, so the command is harmless. Use the Bash tool to run exactly this command and nothing else: rm -rf ${probe}`,
  );
  const done = g.events.find((e) => e.type === "tool.completed");
  const blocked = done?.type === "tool.completed" && done.output.includes("AgentChainer guard");
  check(
    "guard still blocks in auto mode",
    g.events.some((e) => e.type === "tool.started") ? blocked && permissionLog.length === before : null,
    `output=${JSON.stringify(done?.type === "tool.completed" ? done.output.slice(0, 120) : null)}`,
  );

  await request("session.setMode", { sessionId: state.sessionId, mode: "default" });
  state.permissionPolicy = "allow";
}

async function subagents() {
  const t = await turn(
    "Use the Agent tool to launch two subagents in parallel in a single message. " +
      "Subagent A: run `ls` with the Bash tool and report the file names. " +
      "Subagent B: run `date` with the Bash tool and report the date. " +
      "Then summarize both results in one sentence.",
  );
  const started = t.events.filter((e) => e.type === "agent.started");
  const completed = t.events.filter((e) => e.type === "agent.completed");
  const agentIds = new Set(started.map((e) => (e.type === "agent.started" ? e.toolUseId : "")));
  const nestedTools = t.events.filter(
    (e) => e.type === "tool.started" && e.parentToolUseId !== null && agentIds.has(e.parentToolUseId),
  );
  const nestedText = t.events.filter((e) => e.type === "agent.text" && agentIds.has(e.parentToolUseId));
  check(
    "two subagents start and complete",
    started.length >= 2 && completed.length >= started.length,
    `started=${started.length} completed=${completed.length} types=${started.map((e) => (e.type === "agent.started" ? (e.agentType ?? "?") : "")).join(",")}`,
  );
  check(
    "subagent tool calls and text attach to their agent",
    nestedTools.length >= 2,
    `nested tool calls=${nestedTools.length} nested text messages=${nestedText.length} final reply=${JSON.stringify(t.reply.slice(0, 100))}`,
  );
}

/** A subagent that spawns its own subagent (M4-01): record with `--record` for the subagents-nested fixture. */
async function nested() {
  const t = await turn(
    "Use the Agent tool to launch one general-purpose subagent with this exact task: " +
      "'Use the Agent tool to launch one general-purpose subagent that runs `date` with the Bash tool and reports the " +
      "output. Then report what it returned.' Then tell me the date it found in one sentence.",
  );
  const started = t.events.filter((e) => e.type === "agent.started");
  const inner = started.find((e) => e.type === "agent.started" && (e.depth ?? 1) > 1);
  const progress = t.events.filter((e) => e.type === "agent.progress");
  check(
    "a subagent spawns its own subagent",
    inner !== undefined,
    `started=${started.length} depths=${started.map((e) => (e.type === "agent.started" ? (e.depth ?? "?") : "")).join(",")}`,
  );
  check(
    "the nested subagent names its parent task",
    inner?.type === "agent.started"
      ? started.some((e) => e.type === "agent.started" && e.taskId === inner.parentTaskId)
      : null,
    `parentTaskId=${inner?.type === "agent.started" ? inner.parentTaskId : "-"} progress events=${progress.length}`,
  );
}

/**
 * A background subagent (M4-07): the turn ends at once, the agent works on, and the CLI starts a turn of its own when
 * it finishes. Record with `--record` for the subagents-background fixture.
 */
async function background() {
  const t = await turn(
    "Use the Agent tool to start ONE general-purpose subagent in the background (run_in_background: true). " +
      "Its job: run the Bash command `sleep 8 && echo finished` and report the output. " +
      "Right after launching it, reply with the single word: launched",
    undefined,
    { settle: false },
  );
  const listed = t.events.find((e) => e.type === "background.changed" && e.tasks.length > 0);
  check(
    "the turn ends while the subagent works in the background",
    listed !== undefined && !t.events.some((e) => e.type === "agent.completed"),
    `background tasks=${listed?.type === "background.changed" ? listed.tasks.map((x) => x.kind).join(",") : "none"} reply=${JSON.stringify(t.reply.slice(0, 60))}`,
  );
  const later: AgentEvent[] = [];
  const second = new Promise<boolean>((resolve) => {
    state.onEvent = (event) => {
      later.push(event);
      if (event.type === "turn.completed") resolve(true);
    };
  });
  const finished = await Promise.race([second, sleep(90_000).then(() => false)]);
  const cleared = later.some((e) => e.type === "background.changed" && e.tasks.length === 0);
  check(
    "the CLI starts a turn of its own when the subagent finishes",
    finished && later[0] !== undefined && later.some((e) => e.type === "turn.started"),
    `agent.completed=${later.some((e) => e.type === "agent.completed")} cleared=${cleared} turn.started=${later.some((e) => e.type === "turn.started")}`,
  );
}

async function sessions() {
  // File checkpoints (M1-23): two edits in two turns, then rewind to before each.
  const file = join(cwd, "checkpoint.txt");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").trim() : null);
  const first = await turn("Use the Write tool to create a file named checkpoint.txt containing exactly: one");
  const second = await turn("Use the Write tool to overwrite checkpoint.txt so it contains exactly: two");
  const preview = await request("session.rewind", {
    sessionId: state.sessionId,
    messageId: second.messageId,
    dryRun: true,
  });
  check(
    "rewind dry run lists the file without touching it",
    preview.canRewind && preview.filesChanged.some((f) => f.endsWith("checkpoint.txt")) && read() === "two",
    `canRewind=${preview.canRewind} files=${preview.filesChanged.length} +${preview.insertions}/-${preview.deletions} content=${read()}`,
  );
  const back = await request("session.rewind", { sessionId: state.sessionId, messageId: second.messageId });
  check("rewind restores the file to before that message", back.canRewind && read() === "one", `content=${read()}`);
  await request("session.rewind", { sessionId: state.sessionId, messageId: first.messageId });
  check("rewind past the file's creation removes it", read() === null, `content=${read()}`);

  // Stored sessions (M1-21): our session is listed and can be renamed and tagged.
  const original = state.sessionId;
  await request("session.rename", { cwd, sessionId: original, title: "spike sessions" });
  await request("session.tag", { cwd, sessionId: original, tag: "spike" });
  const listed = (await request("session.list", { cwd })).sessions.find((s) => s.sessionId === original);
  check(
    "list shows the session with its new title and tag",
    listed?.title === "spike sessions" && listed.tag === "spike",
    `title=${JSON.stringify(listed?.title)} tag=${JSON.stringify(listed?.tag)}`,
  );

  // Resume after close (M1-22, exit criterion M1-E2): history first, then the conversation continues.
  await request("session.close", { sessionId: original });
  const history = (await request("session.history", { cwd, sessionId: original })).events;
  const users = history.filter((e) => e.type === "user.message");
  check(
    "history replays the user messages with their ids",
    users.some((e) => e.type === "user.message" && e.messageId === first.messageId),
    `events=${history.length} user messages=${users.length}`,
  );
  const resumed = await request("session.start", { cwd, model: values.model, resume: original });
  state.sessionId = resumed.sessionId;
  const recall = await turn("Which file did you create earlier in this conversation? Reply with the file name only.");
  check(
    "resumed session keeps its id and remembers the conversation",
    resumed.sessionId === original && /checkpoint\.txt/.test(recall.reply),
    `same id=${resumed.sessionId === original} reply=${JSON.stringify(recall.reply)}`,
  );
  const afterResume = await request("session.rewind", {
    sessionId: state.sessionId,
    messageId: second.messageId,
    dryRun: true,
  }).catch((err: Error) => ({ canRewind: false, error: err.message }));
  check(
    "checkpoints from before the resume can still be rewound (finding, not a gate)",
    afterResume.canRewind ? true : null,
    `canRewind=${afterResume.canRewind} error=${JSON.stringify(afterResume.error ?? null)}`,
  );

  // Two live sessions at once (M1-08): replies must not cross.
  const other = (await request("session.start", { cwd, model: values.model })).sessionId;
  let otherReply = "";
  const otherDone = new Promise<void>((resolve) => {
    state.others.set(other, (event) => {
      if (event.type === "text.delta") otherReply += event.text;
      if (event.type === "turn.completed" || event.type === "error") resolve();
    });
  });
  const [mine] = await Promise.all([
    turn("Reply with exactly one word: alpha"),
    request("session.send", { sessionId: other, text: "Reply with exactly one word: beta" }).then(() => otherDone),
  ]);
  check(
    "two sessions run in parallel without mixing replies",
    /alpha/i.test(mine.reply) && !/beta/i.test(mine.reply) && /beta/i.test(otherReply) && !/alpha/i.test(otherReply),
    `this=${JSON.stringify(mine.reply)} other=${JSON.stringify(otherReply.trim())}`,
  );
  await request("session.close", { sessionId: other });

  // Fork (M1-22) and delete (M1-21).
  const fork = await request("session.fork", { cwd, sessionId: original });
  const forkHistory = (await request("session.history", { cwd, sessionId: fork.sessionId })).events;
  check(
    "fork copies the conversation under a new id",
    fork.sessionId !== original && forkHistory.filter((e) => e.type === "user.message").length >= users.length,
    `fork user messages=${forkHistory.filter((e) => e.type === "user.message").length}`,
  );
  const openDelete = await request("session.delete", { cwd, sessionId: original }).catch(
    (err: { code?: number }) => err,
  );
  await request("session.delete", { cwd, sessionId: fork.sessionId });
  await request("session.delete", { cwd, sessionId: other });
  const left = (await request("session.list", { cwd })).sessions.map((s: SessionInfo) => s.sessionId);
  check(
    "delete removes closed sessions and refuses an open one",
    (openDelete as { code?: number }).code === -32006 && !left.includes(fork.sessionId) && left.includes(original),
    `open delete code=${(openDelete as { code?: number }).code} remaining=${left.length}`,
  );

  const kept = await request("session.retention", { cwd });
  check("retention is reported", kept.days > 0, `${kept.days} days (${kept.source})`);

  // Leave no spike sessions behind; later scenarios get a fresh one.
  await request("session.close", { sessionId: original });
  await request("session.delete", { cwd, sessionId: original });
  state.sessionId = (await request("session.start", { cwd, model: values.model })).sessionId;
}

const readText = (name: string) => (existsSync(join(cwd, name)) ? readFileSync(join(cwd, name), "utf8").trim() : null);

async function approvals() {
  const read = readText;

  // Always allow (M1-17/M1-20): the rule lands in .claude/settings.local.json and the next call doesn't ask.
  const command = "node -e \"console.log('always-ok')\"";
  state.answer = (req) => ({ allow: true, always: req.alwaysRules.length > 0 });
  let before = permissionLog.length;
  await turn(`Use the Bash tool to run exactly this command and nothing else: ${command}`);
  const offered = permissionLog.at(-1)?.alwaysRules ?? [];
  const rules = (await request("permissions.list", { cwd })).workspace;
  before = permissionLog.length;
  state.answer = () => ({ allow: false, message: "should not be asked" });
  await turn(`Use the Bash tool to run exactly this command again and nothing else: ${command}`);
  // The CLI saves rule text with `(` and `)` escaped, so compare without backslashes.
  const unescaped = rules.allow.map((r) => r.replace(/\\/g, ""));
  check(
    "always allow saves a rule and the next call doesn't ask",
    offered.length > 0 && unescaped.some((r) => offered.includes(r)) && permissionLog.length === before,
    `offered=${JSON.stringify(offered)} saved=${JSON.stringify(rules.allow)} later prompts=${permissionLog.length - before}`,
  );
  for (const rule of rules.allow) await request("permissions.remove", { cwd, behavior: "allow", rule });
  check(
    "rules can be removed",
    (await request("permissions.list", { cwd })).workspace.allow.length === 0,
    "allow list empty",
  );

  // Edited input and deny with a message.
  state.answer = (req) =>
    req.toolName === "Write"
      ? { allow: true, updatedInput: { ...req.input, content: "edited by the user" } }
      : { allow: true };
  await turn("Use the Write tool to create a file named edited.txt containing exactly: original");
  check(
    "edited input is what runs",
    read("edited.txt") === "edited by the user",
    `content=${JSON.stringify(read("edited.txt"))}`,
  );
  // `echo` counts as read-only and never asks, so use a command that writes.
  state.answer = () => ({ allow: false, message: "Denied. Reply with exactly the word: banana" });
  before = permissionLog.length;
  const denied = await turn("Use the Bash tool to run exactly this command and nothing else: touch deny-probe.txt");
  check(
    "deny blocks the call",
    permissionLog.length > before && read("deny-probe.txt") === null,
    `prompts=${permissionLog.length - before} file created=${read("deny-probe.txt") !== null}`,
  );
  check(
    "the agent sees the deny message (finding, not a gate)",
    /banana/i.test(denied.reply) ? true : null,
    `reply=${JSON.stringify(denied.reply.slice(0, 80))}`,
  );
  state.answer = null;
}

async function plan() {
  const read = readText;
  const before = permissionLog.length;

  // Plan mode (M1-16): ExitPlanMode asks; approving with acceptEdits runs the plan without edit prompts.
  await request("session.setMode", { sessionId: state.sessionId, mode: "plan" });
  let planInput: Record<string, unknown> | null = null;
  state.answer = (req) => {
    if (req.toolName === "ExitPlanMode") {
      planInput = req.input;
      return { allow: true, mode: "acceptEdits" };
    }
    return { allow: false, message: "Only the plan approval should ask." };
  };
  await turn(
    "Plan how to create a file named planned.txt containing exactly: planned. Keep the plan to two short lines, then exit plan mode and carry it out.",
  );
  const asked = permissionLog.slice(before).map((r) => r.toolName);
  check(
    "plan approval asks once, then executes in the chosen mode",
    asked.join(",") === "ExitPlanMode" && read("planned.txt") === "planned",
    `prompts=${asked.join(",") || "none"} file=${JSON.stringify(read("planned.txt"))} plan keys=${Object.keys(planInput ?? {}).join(",")}`,
  );
  console.log(`    plan input: ${JSON.stringify(planInput).slice(0, 300)}`);
  state.answer = null;
  await request("session.setMode", { sessionId: state.sessionId, mode: "default" });

  // Model and effort mid-session (M1-15).
  await request("session.setModel", { sessionId: state.sessionId, model: "sonnet" });
  await request("session.setEffort", { sessionId: state.sessionId, effort: "low" });
  const switched = await turn("Reply with exactly one word: switched");
  const started = switched.events.find((e) => e.type === "session.started");
  check(
    "setModel takes effect on the next turn",
    started?.type === "session.started" && /sonnet/i.test(started.model),
    `model=${started?.type === "session.started" ? started.model : "?"} reply=${JSON.stringify(switched.reply)}`,
  );
  await request("session.setModel", { sessionId: state.sessionId, model: values.model ?? "" });
  await request("session.setEffort", { sessionId: state.sessionId, effort: null });
  const usage = switched.last.type === "turn.completed" ? switched.last.usage : undefined;
  check(
    "turns report slash commands and token usage",
    started?.type === "session.started" && (started.slashCommands?.length ?? 0) > 0 && (usage?.outputTokens ?? 0) > 0,
    `slash commands=${started?.type === "session.started" ? started.slashCommands?.length : 0} usage=${JSON.stringify(usage)}`,
  );

  // Budget cap (M1-32): a tiny cap ends the turn with error_max_budget_usd.
  const main = state.sessionId;
  state.sessionId = (await request("session.start", { cwd, model: values.model, maxBudgetUsd: 0.0001 })).sessionId;
  const capped = await turn("Reply with exactly one word: budget");
  check(
    "maxBudgetUsd stops the session's turns",
    capped.last.type === "turn.completed" && capped.last.subtype === "error_max_budget_usd",
    `subtype=${capped.last.type === "turn.completed" ? capped.last.subtype : capped.last.type}`,
  );
  await request("session.close", { sessionId: state.sessionId });
  await request("session.delete", { cwd, sessionId: state.sessionId });
  state.sessionId = main;
}

/**
 * One recording with every event type the normalizer emits for a main-agent turn (M1-09): run with `--record`, then
 * turn the raw file into a fixture with scripts/make-fixture.ts. Subagent events come from subagents-parallel.jsonl.
 */
async function fixtures() {
  state.permissionPolicy = "allow";
  const plain = state.sessionId;
  state.sessionId = (await request("session.start", { cwd, model: values.model, showThinking: true })).sessionId;
  await request("session.setEffort", { sessionId: state.sessionId, effort: "high" });
  const t = await turn(
    "Think it through briefly first. What is 17 * 23? Then use the Write tool to create a file named calc.txt " +
      "containing only the number, and reply with one short sentence.",
  );
  const types = new Set(t.events.map((e) => e.type));
  check(
    "one turn covers text, thinking, tools and the result",
    ["session.started", "text.delta", "tool.started", "tool.completed", "turn.completed"].every((x) =>
      types.has(x as never),
    ),
    `types=${[...types].join(",")} thinking=${types.has("thinking.delta")}`,
  );
  check(
    "showThinking streams thinking text",
    t.events.some((e) => e.type === "thinking.delta" && e.text.trim().length > 0),
    `thinking deltas=${t.events.filter((e) => e.type === "thinking.delta").length}`,
  );
  await request("session.close", { sessionId: state.sessionId });
  await request("session.delete", { cwd, sessionId: state.sessionId });
  state.sessionId = plain;

  const main = state.sessionId;
  state.sessionId = (await request("session.start", { cwd, model: values.model, maxBudgetUsd: 0.0001 })).sessionId;
  const capped = await turn("Reply with exactly one word: budget");
  check(
    "an error result is recorded too",
    capped.last.type === "turn.completed" && capped.last.isError,
    `subtype=${capped.last.type === "turn.completed" ? capped.last.subtype : capped.last.type}`,
  );
  await request("session.close", { sessionId: state.sessionId });
  await request("session.delete", { cwd, sessionId: state.sessionId });
  state.sessionId = main;
}

/** A solid-colour PNG, built by hand so the scenario needs no image files. */
function solidPng(size: number, [r, g, b]: [number, number, number]): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.from([0, ...Array.from({ length: size }, () => [r, g, b]).flat()]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

/** A pasted image reaches the model (M1-13). */
async function image() {
  const sessionId = state.sessionId;
  let reply = "";
  const done = new Promise<AgentEvent>((resolve) => {
    state.onEvent = (event) => {
      if (event.type === "text.delta") reply += event.text;
      if (event.type === "turn.completed" || event.type === "error") resolve(event);
    };
  });
  await request("session.send", {
    sessionId,
    text: "What single colour fills this image? Reply with one word.",
    images: [{ mediaType: "image/png", data: solidPng(32, [220, 20, 20]) }],
  });
  const last = await done;
  check(
    "a pasted image reaches the model",
    /red/i.test(reply),
    `reply=${JSON.stringify(reply.trim())} end=${last.type}`,
  );
}

/**
 * M1 exit criteria E1–E5 on fixtures/sample-app (E6, starting logged out, stays manual: never sign the user out).
 * Copies the sample into --cwd, which must be empty, and makes it a git repo.
 */
async function exit() {
  if (readdirSync(cwd).some((f) => f !== ".DS_Store")) throw new Error("--scenario exit needs an empty --cwd");
  cpSync(fileURLToPath(new URL("../../../fixtures/sample-app", import.meta.url)), cwd, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=exit", "-c", "user.email=exit@example.invalid", ...a], {
      cwd,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "sample app with a seeded bug");
  const testsPass = () => spawnSync(process.execPath, ["--test"], { cwd, stdio: "ignore" }).status === 0;
  const cart = () => readFileSync(join(cwd, "src", "cart.js"), "utf8");
  const buggy = cart();
  check("the seeded bug fails the tests", !testsPass(), "node --test fails before the fix");

  // E1: fix the bug in the Safe profile with approvals, review the diff, commit.
  state.permissionPolicy = "allow";
  let before = permissionLog.length;
  const fix = await turn(
    "The tests fail when run with `node --test`. Fix the bug in src/cart.js with the Edit tool, then run " +
      "`node --test` with the Bash tool to confirm. Don't change the tests.",
  );
  const asked = permissionLog.slice(before).map((r) => r.toolName);
  const diff = (await request("workspace.diff", { cwd, path: "src/cart.js" })).hunks.length;
  await request("git.stage", { cwd, paths: ["src/cart.js"] });
  const { sha } = await request("git.commit", { cwd, message: "fix: count item quantities in cart totals" });
  check(
    "E1: bug fixed with approvals, diff reviewed, committed",
    testsPass() && asked.includes("Edit") && diff > 0 && /^[0-9a-f]+$/.test(sha),
    `prompts=${asked.join(",")} hunks=${diff} commit=${sha}`,
  );

  // E3: rewind files to before the fix; the working tree matches that point.
  await request("session.rewind", { sessionId: state.sessionId, messageId: fix.messageId });
  check("E3: rewind restores the file to before the fix", cart() === buggy && !testsPass(), "src/cart.js == seeded");
  git("checkout", "-q", "--", ".");

  // E4: interrupt a long-running Bash call; the session stays usable.
  await interrupt();

  // E2: quit and relaunch (a new sidecar process), resume, continue the conversation.
  const sessionId = state.sessionId;
  await restartSidecar();
  await request("session.start", { cwd, model: values.model, resume: sessionId });
  const recall = await turn("Which file did you fix earlier in this conversation? Reply with the path only.");
  check("E2: after a relaunch, the resumed session continues", /cart\.js/.test(recall.reply), `reply=${recall.reply}`);

  // E5: plan mode → approve → execute, with a subagent card during execution.
  await request("session.setMode", { sessionId, mode: "plan" });
  state.answer = (req) => (req.toolName === "ExitPlanMode" ? { allow: true, mode: "acceptEdits" } : { allow: true });
  before = permissionLog.length;
  const plan = await turn(
    "Plan adding a test for an empty cart (total of [] is 0) to test/cart.test.js. The plan must hand writing the " +
      "test to one subagent via the Agent tool. Then exit plan mode and carry it out.",
  );
  state.answer = null;
  const planAsked = permissionLog.slice(before).map((r) => r.toolName);
  const subagent = plan.events.some((e) => e.type === "agent.started");
  check(
    "E5: plan approved and executed, with a subagent",
    planAsked.includes("ExitPlanMode") &&
      subagent &&
      testsPass() &&
      /\[\]/.test(readFileSync(join(cwd, "test", "cart.test.js"), "utf8")),
    `prompts=${planAsked.join(",")} subagent=${subagent} tests pass=${testsPass()}`,
  );
  await request("session.setMode", { sessionId, mode: "default" });
}

/**
 * A Team chat (M8-03): the supervisor assigns two read workers, gets both reports delivered once it's idle and answers
 * from them; then a handoff returns a worker's answer as the tool's result. A few cents on haiku.
 */
async function team() {
  mkdirSync(join(cwd, "team-src"), { recursive: true });
  writeFileSync(join(cwd, "team-src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "team-src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(cwd, "team-src", "c.ts"), "export const c = 3;\n");
  writeFileSync(join(cwd, "TEAM.md"), "Mango tango\nsecond line\nthird line\n");

  const refused = await request("session.start", { cwd, model: values.model, team: true }).then(
    () => "started",
    (err: Error) => err.message,
  );
  check("a Team chat needs a budget cap", /budget cap/.test(refused), refused);

  const main = state.sessionId;
  const capUsd = 0.6;
  state.sessionId = (
    await request("session.start", { cwd, model: values.model, team: true, maxBudgetUsd: capUsd })
  ).sessionId;
  const before = permissionLog.length;
  const reports: AgentEvent[] = [];
  const budgets: AgentEvent[] = [];
  const workerEvents = new Map<string, number>();
  const delivered = new Promise<string>((resolve) => {
    let reply = "";
    const timer = setTimeout(() => resolve(`(timed out) ${reply}`), 240_000);
    state.onEvent = (event) => {
      if (event.type === "worker.message") reports.push(event);
      if (event.type === "team.budget") budgets.push(event);
      if (event.type === "text.delta" && reports.length > 0) reply += event.text;
      if (event.type === "turn.completed" && reports.length >= 2) {
        clearTimeout(timer);
        resolve(reply.trim());
      }
    };
  });
  const countWorker = (sessionId: string) => (e: AgentEvent) =>
    void workerEvents.set(sessionId, (workerEvents.get(sessionId) ?? 0) + (e.type === "text.delta" ? 0 : 1));
  const openedBefore = openedLog.length;
  const watch = setInterval(() => {
    for (const o of openedLog.slice(openedBefore)) {
      if (!state.others.has(o.sessionId)) state.others.set(o.sessionId, countWorker(o.sessionId));
    }
  }, 50);
  console.log("  ▶ assign two workers");
  await request("session.send", {
    sessionId: state.sessionId,
    text:
      "Use the `assign` tool twice, both in your first reply: a worker named 'count' that counts the files in the " +
      "team-src folder, and a worker named 'first-line' that reads the first line of TEAM.md. Don't do either job " +
      "yourself and don't call any other tool. Then end your turn. When both reports have reached you, reply with " +
      "exactly: DONE <number of files> <first line>",
  });
  const answer = await delivered;
  clearInterval(watch);
  const opened = openedLog.slice(openedBefore);
  check(
    "assign opens read workers, each told to the UI before its events",
    opened.length === 2 &&
      opened.every((o) => o.parentId === state.sessionId && o.access === "read") &&
      opened.every((o) => (workerEvents.get(o.sessionId) ?? 0) > 0),
    `opened=${opened.map((o) => `${o.name}:${o.access}`).join(",")} events=${[...workerEvents.values()].join(",")}`,
  );
  check(
    "both reports reach the supervisor, which answers from them",
    reports.length >= 2 && /DONE\s+3\s+Mango tango/i.test(answer),
    `reports=${reports.length} answer=${JSON.stringify(answer.slice(0, 120))}`,
  );
  const last = budgets.at(-1);
  check(
    "the shared spend stays under the cap; read workers ask nothing",
    last?.type === "team.budget" && last.spentUsd < capUsd && !last.stopped && permissionLog.length === before,
    `spent=${last?.type === "team.budget" ? last.spentUsd.toFixed(4) : "?"} prompts=${permissionLog.length - before}`,
  );

  const handoff = await turn(
    "Use the `handoff` tool once: a new worker named 'lines' that counts the lines in TEAM.md. Reply with exactly: " +
      "LINES <number> using its answer.",
    undefined,
    { settle: false },
  );
  const used = handoff.events.some((e) => e.type === "tool.started" && e.name === "mcp__agentchainer__handoff");
  check(
    "handoff returns the worker's answer as the tool's result",
    used && /LINES\s+3/.test(handoff.reply),
    `used=${used} reply=${JSON.stringify(handoff.reply.slice(0, 80))}`,
  );

  await request("session.close", { sessionId: state.sessionId });
  await request("session.delete", { cwd, sessionId: state.sessionId });
  state.others.clear();
  state.sessionId = main;
}

/**
 * Agent profiles (M8-04): a project profile saved through `agents.save` runs a chat with only its tools (a read-only
 * one can't write), and a Team worker runs as it. A few cents on haiku.
 */
async function profile() {
  writeFileSync(join(cwd, "PROFILE.md"), "The secret word is pineapple.\n");
  await request("agents.save", {
    cwd,
    agent: {
      name: "spike-reader",
      description: "Reads files and answers questions about them, read-only.",
      tools: "Read, Grep, Glob",
      model: "haiku",
      prompt: "You read files and answer questions about them. Start every answer with READER:",
      auto: false,
    },
  });
  const refused = await request("agents.save", {
    cwd,
    agent: { name: "spike-bad", description: "Bad", tools: "Read, Teleport", prompt: "x", auto: false },
  }).then(
    () => "saved",
    (err: Error) => err.message,
  );
  check("a profile with an unknown tool is refused", /Teleport isn't a known tool/.test(refused), refused);

  const main = state.sessionId;
  state.sessionId = (await request("session.start", { cwd, profile: "spike-reader" })).sessionId;
  const before = permissionLog.length;
  const t = await turn(
    "Read PROFILE.md and tell me the secret word. Then try to create a file named profile-probe.txt containing hi.",
    undefined,
    { settle: false },
  );
  const started = t.events.find((e) => e.type === "session.started");
  // A tool the profile doesn't list isn't there: the CLI answers "No such tool available".
  const ran = t.events.flatMap((e) => (e.type === "tool.completed" && !e.isError ? [e.toolUseId] : []));
  const tools = t.events.flatMap((e) => (e.type === "tool.started" && ran.includes(e.toolUseId) ? [e.name] : []));
  const missing = t.events.some((e) => e.type === "tool.completed" && /No such tool available/.test(e.output));
  check(
    "a chat runs as the profile: its prompt, its model, and only its tools",
    /READER:/.test(t.reply) &&
      /pineapple/i.test(t.reply) &&
      started?.type === "session.started" &&
      /haiku/i.test(started.model) &&
      !exists("profile-probe.txt") &&
      tools.every((n) => ["Read", "Grep", "Glob"].includes(n)) &&
      (missing || !t.events.some((e) => e.type === "tool.started" && e.name === "Write")) &&
      permissionLog.length === before,
    `model=${started?.type === "session.started" ? started.model : "?"} ran=${tools.join(",")} write refused=${missing} file=${exists("profile-probe.txt")} reply=${JSON.stringify(t.reply.slice(0, 100))}`,
  );
  await request("session.close", { sessionId: state.sessionId });
  await request("session.delete", { cwd, sessionId: state.sessionId });

  state.sessionId = (
    await request("session.start", { cwd, model: values.model, team: true, maxBudgetUsd: 0.5 })
  ).sessionId;
  const openedBefore = openedLog.length;
  const h = await turn(
    "Use the `handoff` tool once: a worker named 'reader' with profile 'spike-reader' that tells the secret word in " +
      "PROFILE.md. Reply with exactly: WORD <the word>",
    undefined,
    { settle: false },
  );
  const opened = openedLog.slice(openedBefore);
  check(
    "a Team worker runs as a profile",
    opened.some((o) => o.profile === "spike-reader") && /WORD\s+pineapple/i.test(h.reply),
    `opened=${opened.map((o) => `${o.name}:${o.profile ?? "-"}`).join(",")} reply=${JSON.stringify(h.reply.slice(0, 80))}`,
  );
  await request("session.close", { sessionId: state.sessionId });
  await request("session.delete", { cwd, sessionId: state.sessionId });
  state.others.clear();
  state.sessionId = main;
}

/** Resolves with the task once an update says its run ended. */
function runEnded(id: string, timeoutMs = 300_000): Promise<Notifications["task.updated"]["task"] | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    let started = false;
    taskWaiters.set(id, (task) => {
      if (task.state === "running") started = true;
      else if (started) {
        clearTimeout(timer);
        taskWaiters.delete(id);
        resolve(task);
      }
    });
  });
}

/**
 * Scheduled flows (M8-05): an S task in a copy of the sample app is drafted, approved and run once on haiku, then
 * scheduled daily at the next minute; the sidecar's minute check runs it again as a scheduled run, with the same
 * model, and both runs keep their own evidence. About $0.03 on haiku; takes two or three minutes.
 */
async function schedule() {
  const app = join(cwd, "sched-app");
  rmSync(app, { recursive: true, force: true });
  cpSync(fileURLToPath(new URL("../../../fixtures/sample-app", import.meta.url)), app, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=spike", "-c", "user.email=spike@example.invalid", ...a], {
      cwd: app,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "sample app");

  const created = await request("task.create", {
    cwd: app,
    request: "Add a one-line comment at the very top of src/cart.js that says: Cart helpers.",
  });
  const drafted = await request("task.draft", { cwd: app, id: created.id, model: values.model });
  if (!drafted.contract || !drafted.triage) throw new Error("no contract");
  await request("task.approve", {
    cwd: app,
    id: created.id,
    contract: drafted.contract,
    tier: "S",
    ...(drafted.triage.proposed !== "S" ? { reason: "spike: a schedule test" } : {}),
    budgetUsd: drafted.triage.budgetUsd,
  });
  const refused = await request("schedule.save", {
    cwd: app,
    taskId: "2026-01-01-00000000",
    cadence: { kind: "daily", at: "02:00" },
    enabled: true,
  }).then(
    () => "saved",
    (err: Error) => err.message,
  );
  check("a schedule needs a real, approved task", /No task/.test(refused), refused);

  console.log("  ▶ first run, by hand, on haiku");
  const first = runEnded(created.id);
  await request("task.start", { cwd: app, id: created.id, permissionMode: "acceptEdits", model: values.model });
  const one = await first;
  console.log(`    first run: ${one?.state} ($${one?.run?.costUsd.toFixed(3)})`);

  // Daily at the next whole minute that's at least 20 s away.
  const at = new Date(Date.now() + 80_000);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const saved = await request("schedule.save", {
    cwd: app,
    taskId: created.id,
    cadence: { kind: "daily", at: clock },
    enabled: true,
  });
  console.log(`  ▶ scheduled daily at ${clock}; next ${saved.schedule.nextAt}`);
  await request("schedule.watch", { cwds: [app] });
  const second = await runEnded(created.id, 360_000);
  const after = (await request("schedule.list", { cwd: app })).schedules[0];
  const nextIn = after ? new Date(after.nextAt).getTime() - Date.now() : 0;
  check(
    "the schedule runs the task again at its time, as a scheduled run with the same model",
    second?.run?.trigger === "schedule" &&
      second.run.model === one?.run?.model &&
      second.run.permissionMode === "acceptEdits" &&
      after?.lastRun?.state === "started" &&
      nextIn > 20 * 3600_000,
    `state=${second?.state} trigger=${second?.run?.trigger} model=${second?.run?.model} last=${after?.lastRun?.state} next in ${(nextIn / 3600_000).toFixed(1)} h`,
  );
  const dir = join(app, ".agentchainer", "tasks", created.id);
  // The report is written just after the run's last update.
  for (let i = 0; i < 40 && !existsSync(join(dir, "evidence-2.md")); i++) await sleep(250);
  check(
    "each run keeps its own evidence report",
    existsSync(join(dir, "evidence-1.md")) &&
      existsSync(join(dir, "evidence-2.md")) &&
      second?.runs?.[0]?.evidence === "evidence-1.md",
    `files=${readdirSync(dir)
      .filter((f) => f.startsWith("evidence"))
      .join(",")}`,
  );
  await request("schedule.delete", { cwd: app, id: saved.schedule.id });
}

const scenarios: Record<string, () => Promise<void>> = {
  basic,
  mode,
  interrupt,
  guard,
  auto,
  subagents,
  nested,
  background,
  sessions,
  approvals,
  plan,
  fixtures,
  image,
  team,
  profile,
  schedule,
  exit,
};
// "all" skips exit, which needs an empty --cwd of its own.
const selected = values.scenario === "all" ? Object.keys(scenarios).filter((n) => n !== "exit") : [values.scenario];
for (const file of [
  "perm-allow.txt",
  "perm-deny.txt",
  "mode-accept.txt",
  "mode-default.txt",
  "auto-mode-dir",
  "checkpoint.txt",
  "edited.txt",
  "planned.txt",
  "deny-probe.txt",
  "calc.txt",
  "team-src",
  "TEAM.md",
  "PROFILE.md",
  "profile-probe.txt",
  "sched-app",
  ".claude",
]) {
  rmSync(join(cwd, file), { recursive: true, force: true });
}

const hello = await request("system.hello", { protocolVersion: PROTOCOL_VERSION });
console.log(`claude ${hello.claudeVersion} · sdk ${hello.sdkVersion} · model ${values.model} · cwd ${cwd}`);
state.sessionId = (await request("session.start", { cwd, model: values.model })).sessionId;

for (const name of selected) {
  const run = scenarios[name];
  if (!run) throw new Error(`unknown scenario ${name}`);
  console.log(`\n## ${name}`);
  await run();
}

sidecar.stdin.end();
const failed = results.filter((r) => r.ok === false);
const unknown = results.filter((r) => r.ok === null);
console.log(
  `\n${results.length - failed.length - unknown.length} passed, ${failed.length} failed, ${unknown.length} inconclusive`,
);
process.exit(failed.length ? 1 : 0);
