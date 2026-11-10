// Spike S8, agy half (M9-02): run the user's own Antigravity CLI (`agy`) headless, the way an agy step backend would
// (ADR-0012 §3). Real model calls on the user's own agy login; the app never signs in for them (ADR-0002). Everything
// happens in a scratch git repo under --cwd. The per-run allowlist goes through `--settings` (session only, never
// saved); the user's own settings file is never read or written, only its modification time is compared.
//
// Usage: node packages/sidecar/scripts/spike-agy.ts --cwd <empty scratch dir> [--agy <path>] [--model <id>]
//        [--record raw.jsonl]
//
// Phases:
//   A  write, no commands: `--mode accept-edits --sandbox` with `toolPermission: request-review`. It asks for an edit
//      and a command: the edit runs, the command is soft-denied and listed in `denied_actions`.
//   B  resume: `--conversation <id>` continues the same conversation on the same file.
//   C  read-only: a per-run deny rule on every write; the file must not appear.
//   D  what per-run command rules do: under `toolPermission: proceed-in-sandbox`, is a command the run denies by rule
//      still run? (In 1.5.4 it is: per-run command rules don't hold, so a backend can't rely on them.)
//
// The stream is one JSON object per line, keyed by its event: {"event":"step_update","step_update":{...}}.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { onPath } from "../src/bootstrap/tools.ts";

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    agy: { type: "string" },
    model: { type: "string", default: "gemini-3.8-flash-low" },
    record: { type: "string" },
  },
});
if (!values.cwd) {
  console.error("--cwd is required");
  process.exit(2);
}
const installed = join(process.env.LOCALAPPDATA ?? "", "agy", "bin", "agy.exe");
const agy = values.agy ?? onPath("agy") ?? (existsSync(installed) ? installed : null);
if (!agy) {
  console.error("agy not found (pass --agy <path>)");
  process.exit(2);
}
const version = execFileSync(agy, ["--version"], { encoding: "utf8" }).trim();
const repo = join(values.cwd, `s8-agy-${Date.now()}`);
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "spike@example.invalid");
git("config", "user.name", "spike");
writeFileSync(join(repo, "README.md"), "# s8\n");
git("add", ".");
git("commit", "-qm", "init");

// The user's own settings: only whether the runs changed them (modification time), never their contents.
const userSettings = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
const mtime = () => (existsSync(userSettings) ? statSync(userSettings).mtimeMs : null);
const before = mtime();

type Event = Record<string, unknown>;
type Run = { code: number | null; events: Event[]; stderr: string; ms: number };

/** One headless agy run: its stream-json events, stderr and exit code. */
function run(args: string[], label: string): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(agy as string, args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.on("close", (code) => {
      if (values.record) appendFileSync(values.record, `### ${label}\n${out}\n### stderr\n${err}\n`);
      const events = out
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .flatMap((l) => {
          try {
            const raw = JSON.parse(l) as Event;
            const kind = String(raw.event ?? raw.type ?? "");
            const body = (raw[kind] ?? {}) as Event;
            return [{ ...body, type: kind }];
          } catch {
            return [];
          }
        });
      resolve({ code, events, stderr: err, ms: Date.now() - started });
    });
  });
}

const settings = (permissions: Record<string, string[]>, toolPermission = "request-review") =>
  JSON.stringify({ toolPermission, permissions });
const common = ["--output-format", "stream-json", "--model", values.model as string, "--print-timeout", "300s"];

/** The tool steps of a run: name, parameters and error, from `step_update` events that finished. */
function tools(r: Run) {
  return r.events
    .filter((e) => e.type === "step_update" && e.step_type === "tool" && (e.state === "DONE" || e.state === "ERROR"))
    .map((e) => {
      const info = (e.tool_info ?? {}) as {
        name?: string;
        parameters?: unknown;
        error?: { type?: string; message?: string };
      };
      return { name: info.name ?? e.tool_name, state: e.state, parameters: info.parameters, error: info.error ?? null };
    });
}
const result = (r: Run) => r.events.find((e) => e.type === "result") as Event | undefined;
const typesOf = (r: Run) => [...new Set(r.events.map((e) => `${e.type}${e.step_type ? `:${e.step_type}` : ""}`))];

const report: Record<string, unknown> = { version, platform: process.platform, model: values.model };

// ---- A: write with an allowlist ----
const a = await run(
  [
    "-p",
    "Create a file hello.txt that contains exactly the word hi. Then run `git status --short`. " +
      "Then reply in one short sentence.",
    ...common,
    "--mode",
    "accept-edits",
    "--sandbox",
    "--settings",
    settings({}),
  ],
  "A",
);
const conversation = String(
  result(a)?.conversation_id ?? a.events.find((e) => e.conversation_id)?.conversation_id ?? "",
);
report.phaseA = {
  exit: a.code,
  seconds: Math.round(a.ms / 1000),
  status: result(a)?.status,
  deniedActions: result(a)?.denied_actions,
  usage: result(a)?.usage,
  helloTxt: existsSync(join(repo, "hello.txt")) ? readFileSync(join(repo, "hello.txt"), "utf8").trim() : null,
  tools: tools(a),
  eventTypes: typesOf(a),
  init: a.events.find((e) => e.type === "init"),
  stderr: a.stderr.trim().slice(0, 1500),
};

// ---- B: resume the conversation ----
const b = await run(
  [
    "-p",
    "Append a space and the word there to hello.txt. Reply in one sentence.",
    ...common,
    "--conversation",
    conversation,
    "--mode",
    "accept-edits",
    "--sandbox",
    "--settings",
    settings({}),
  ],
  "B",
);
report.phaseB = {
  conversation,
  exit: b.code,
  status: result(b)?.status,
  sameConversation: result(b)?.conversation_id === conversation,
  helloTxt: existsSync(join(repo, "hello.txt")) ? readFileSync(join(repo, "hello.txt"), "utf8").trim() : null,
  stderr: b.stderr.trim().slice(0, 800),
};

// ---- C: read-only through a deny rule ----
const c = await run(
  [
    "-p",
    "Create a file ro.txt containing x. Reply in one sentence.",
    ...common,
    "--sandbox",
    "--settings",
    settings({ deny: ["write_file(*)"] }),
  ],
  "C",
);
report.phaseC = {
  exit: c.code,
  status: result(c)?.status,
  roTxtCreated: existsSync(join(repo, "ro.txt")),
  tools: tools(c),
  stderr: c.stderr.trim().slice(0, 800),
};

// ---- D: per-run command rules under proceed-in-sandbox ----
const d = await run(
  [
    "-p",
    "Run the command git log -1 --oneline and reply with its output only.",
    ...common,
    "--sandbox",
    "--settings",
    settings({ deny: ["command(git log)"] }, "proceed-in-sandbox"),
  ],
  "D",
);
report.phaseD = {
  exit: d.code,
  status: result(d)?.status,
  deniedByRuleButRan: tools(d).some((t) => t.name === "run_command" && t.state === "DONE"),
  tools: tools(d),
};

report.userSettingsUnchanged = mtime() === before;
console.log(JSON.stringify(report, null, 2));
