// Spike S8 (M9-02): drive the user's own Codex CLI through `codex app-server` (JSON-RPC over stdio), the way a Codex
// step backend would. Real model calls on the user's own Codex login (ChatGPT plan usage or their API key); the app
// never signs in for them (ADR-0002). Everything happens in a scratch git repo under --cwd.
//
// Usage: node packages/sidecar/scripts/spike-codex.ts --cwd <empty scratch dir> [--record raw.jsonl] [--model <id>]
//        [--effort low]. Pass --model: the user's own config may name a model their login can't use, and a step
//        backend sets its model rather than inheriting it.
//
// Phases:
//   A  write: policy "untrusted" (asks for everything), workspace-write sandbox. File changes are accepted, a force
//      push is declined as the guard would; it records which commands asked, what a file-change item carries, and
//      the token usage.
//   B  resume: a new process resumes the thread by id and keeps working on the same file.
//   C  read-only: a thread in the read-only sandbox is asked to write; the file must not appear.
// The raw frames can go to --record; they hold local paths, so they're never committed (make a fixture instead).
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { type Cli, resolveCli } from "../src/deploy/cli.ts";

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    record: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
  },
});
if (!values.cwd) {
  console.error("--cwd is required");
  process.exit(2);
}
const found = resolveCli("codex");
if (!found) {
  console.error("codex not found on PATH");
  process.exit(2);
}
const codex: Cli = found;
const version = execFileSync(codex.bin, [...codex.prefix, "--version"], { encoding: "utf8" }).trim();
const repo = join(values.cwd, `s8-${Date.now()}`);
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "spike@example.invalid");
git("config", "user.name", "spike");
writeFileSync(join(repo, "README.md"), "# s8\n");
git("add", ".");
git("commit", "-qm", "init");

type Frame = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
type Approval = { method: string; command?: string; itemId?: string; decision: string };

const report: Record<string, unknown> = { version, platform: process.platform };
const methodsSeen = new Map<string, number>();
const itemTypes = new Map<string, number>();
const approvals: Approval[] = [];
const samples: Record<string, unknown> = {};

/** One `codex app-server` process with request/response plumbing and a hook for server requests. */
function server(onRequest: (f: Frame) => unknown) {
  const child: ChildProcessWithoutNullStreams = spawn(codex.bin, [...codex.prefix, "app-server"], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let next = 1;
  const pending = new Map<number | string, (f: Frame) => void>();
  const listeners: ((f: Frame) => void)[] = [];
  const write = (f: Frame) => {
    const line = JSON.stringify(f);
    if (values.record) appendFileSync(values.record, `> ${line}\n`);
    child.stdin.write(`${line}\n`);
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (values.record) appendFileSync(values.record, `< ${line}\n`);
    let f: Frame;
    try {
      f = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    if (f.method) methodsSeen.set(f.method, (methodsSeen.get(f.method) ?? 0) + 1);
    if (f.id !== undefined && f.method) {
      // A request from the server: an approval, most likely.
      const result = onRequest(f);
      write({ id: f.id, result } as Frame);
      return;
    }
    if (f.id !== undefined) {
      pending.get(f.id)?.(f);
      pending.delete(f.id);
      return;
    }
    for (const l of listeners) l(f);
  });
  child.stderr.on("data", (d) => {
    if (values.record) appendFileSync(values.record, `! ${String(d)}`);
  });
  return {
    request(method: string, params: unknown): Promise<Frame> {
      const id = next++;
      write({ id, method, params } as Frame);
      return new Promise((resolve) => pending.set(id, resolve));
    },
    notify(method: string, params?: unknown) {
      write({ method, ...(params === undefined ? {} : { params }) } as Frame);
    },
    on(l: (f: Frame) => void) {
      listeners.push(l);
    },
    /** Resolves with the turn/completed notification of `threadId`, or rejects after `ms`. */
    turnDone(ms = 240_000): Promise<Frame> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("turn timed out")), ms);
        listeners.push((f) => {
          if (f.method === "turn/completed") {
            clearTimeout(timer);
            resolve(f);
          }
        });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill(), 5000);
      }),
  };
}

/** The guard's call on a command, reduced to the one case this spike plays out: a force push is denied. */
const guardDenies = (command: string) => /\bgit\s+push\b.*(--force|-f\b)/.test(command);

function decide(f: Frame): unknown {
  const p = f.params ?? {};
  if (f.method === "item/commandExecution/requestApproval") {
    const command = String(p.command ?? "");
    const decision = guardDenies(command) ? "decline" : "accept";
    approvals.push({ method: f.method, command, itemId: String(p.itemId), decision });
    samples.commandApproval ??= p;
    return { decision };
  }
  if (f.method === "item/fileChange/requestApproval") {
    approvals.push({ method: f.method, itemId: String(p.itemId), decision: "accept" });
    samples.fileChangeApproval ??= p;
    return { decision: "accept" };
  }
  // Anything else (permissions, user input, elicitation) is declined and noted.
  approvals.push({ method: String(f.method), decision: "decline" });
  return { decision: "decline" };
}

function watchItems(s: ReturnType<typeof server>) {
  s.on((f) => {
    const item = (f.params?.item ?? null) as Record<string, unknown> | null;
    if ((f.method === "item/started" || f.method === "item/completed") && item) {
      const type = String(item.type);
      if (f.method === "item/completed") itemTypes.set(type, (itemTypes.get(type) ?? 0) + 1);
      if (f.method === "item/completed") samples[`item:${type}`] ??= item;
    }
    if (f.method === "thread/tokenUsage/updated") samples.tokenUsage = f.params;
    if (f.method === "turn/completed") samples.turnCompleted ??= f.params;
  });
}

const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];
const model = values.model ? { model: values.model } : {};
const effort = values.effort ? { effort: values.effort } : {};

async function start(s: ReturnType<typeof server>) {
  const init = await s.request("initialize", {
    clientInfo: { name: "agentchainer-spike", title: "AgentChainer spike S8", version: "0.0.0" },
    capabilities: null,
  });
  s.notify("initialized");
  return init;
}

// ---- Phase A: write, every action asked about ----
const a = server(decide);
watchItems(a);
const init = await start(a);
report.initialize = init.error ?? "ok";
const started = await a.request("thread/start", {
  cwd: repo,
  sandbox: "workspace-write",
  approvalPolicy: "untrusted",
  ...model,
});
const threadId = String((started.result as { thread?: { id?: string } } | undefined)?.thread?.id ?? "");
report.threadStart = started.error ?? { threadId };
const doneA = a.turnDone();
await a.request("turn/start", {
  threadId,
  input: text(
    "Create a file hello.txt that contains exactly the word hi. Then run `git status --short`. " +
      "Then run `git push --force origin main`. Then reply in one short sentence.",
  ),
});
const turnA = await doneA;
report.phaseA = {
  turnStatus: (turnA.params?.turn as { status?: string } | undefined)?.status,
  helloTxt: existsSync(join(repo, "hello.txt")) ? readFileSync(join(repo, "hello.txt"), "utf8").trim() : null,
  approvals: [...approvals],
};
await a.close();

// ---- Phase B: resume the thread in a new process ----
const b = server(decide);
watchItems(b);
await start(b);
const resumed = await b.request("thread/resume", { threadId });
const doneB = b.turnDone();
await b.request("turn/start", {
  threadId,
  ...effort,
  input: text("Append a space and the word there to hello.txt. Reply in one sentence."),
});
const turnB = await doneB;
report.phaseB = {
  resume: resumed.error ?? "ok",
  turnStatus: (turnB.params?.turn as { status?: string } | undefined)?.status,
  helloTxt: existsSync(join(repo, "hello.txt")) ? readFileSync(join(repo, "hello.txt"), "utf8").trim() : null,
};
await b.close();

// ---- Phase C: the read-only sandbox refuses a write ----
const c = server(decide);
watchItems(c);
await start(c);
const ro = await c.request("thread/start", { cwd: repo, sandbox: "read-only", approvalPolicy: "never", ...model });
const roThread = String((ro.result as { thread?: { id?: string } } | undefined)?.thread?.id ?? "");
const doneC = c.turnDone();
await c.request("turn/start", {
  threadId: roThread,
  ...effort,
  input: text("Create a file ro.txt containing x. Reply in one sentence."),
});
const turnC = await doneC;
report.phaseC = {
  turnStatus: (turnC.params?.turn as { status?: string } | undefined)?.status,
  roTxtCreated: existsSync(join(repo, "ro.txt")),
};
await c.close();

report.methodsSeen = Object.fromEntries([...methodsSeen].sort());
report.itemTypes = Object.fromEntries(itemTypes);
report.samples = samples;
console.log(JSON.stringify(report, null, 2));
