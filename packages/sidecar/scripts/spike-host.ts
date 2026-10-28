// Drives the sidecar the way the Rust core will (spikes S2/S3) and checks real behaviour
// against the user's own `claude` CLI.
//
// Usage: node scripts/spike-host.ts --cwd <empty scratch dir> [--model haiku] [--scenario basic|mode|interrupt|guard|auto|subagents|sessions|approvals|plan|all] [--record out.jsonl] [--sidecar <executable> --data-dir <dir>]
// Makes real model calls with the user's own login (haiku keeps a full run around a few cents).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type AgentEvent,
  type MethodName,
  type Methods,
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
const sidecar = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env });

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

createInterface({ input: sidecar.stdout }).on("line", (line) => {
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
  } else if (frame.method === "permission.request") {
    const req = frame.params as PermissionRequest;
    permissionLog.push(req);
    const answer = state.answer?.(req) ?? { allow: state.permissionPolicy === "allow" };
    console.log(`    [permission.request] ${req.toolName} → ${JSON.stringify(answer).slice(0, 120)}`);
    void request("permission.respond", { sessionId: req.sessionId, requestId: req.requestId, ...answer });
  }
});

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

async function turn(text: string, onEvent?: (event: AgentEvent) => void): Promise<Turn> {
  console.log(`  ▶ ${JSON.stringify(text)}`);
  const t0 = performance.now();
  const acc = { reply: "", firstDeltaMs: null as number | null, events: [] as AgentEvent[] };
  const end = new Promise<AgentEvent>((resolve) => {
    state.onEvent = (event) => {
      acc.events.push(event);
      onEvent?.(event);
      if (event.type === "text.delta") {
        acc.reply += event.text;
        acc.firstDeltaMs ??= performance.now() - t0;
      }
      if (event.type === "turn.completed" || event.type === "error") resolve(event);
    };
  });
  const { messageId } = await request("session.send", { sessionId: state.sessionId, text });
  const timeout = sleep(90_000).then((): AgentEvent => ({ type: "error", message: "turn timed out after 90 s" }));
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
  const rules = await request("permissions.list", { cwd });
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
  check("rules can be removed", (await request("permissions.list", { cwd })).allow.length === 0, "allow list empty");

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

const scenarios: Record<string, () => Promise<void>> = {
  basic,
  mode,
  interrupt,
  guard,
  auto,
  subagents,
  sessions,
  approvals,
  plan,
};
const selected = values.scenario === "all" ? Object.keys(scenarios) : [values.scenario];
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
