// Performance budgets (X-07, docs/PERFORMANCE.md): launches the debug app in its startup bench (no model calls, no
// workspace) and measures
//   - startup: from the process starting to Home being ready (window, UI, sidecar handshake and the readiness check);
//   - idle memory: the resident memory of the app's process tree (the app, the sidecar, the WebView's processes) after
//     it sat idle on Home.
// Each is checked against scripts/perf-budgets.json. Stream latency needs a model call, so it's measured per release
// with scripts/selftest-latency.mjs instead.
//
// Usage (after a debug build): node scripts/perf-budgets.mjs [--binary target/debug/agentchainer] [--idle 20]
//                              [--json out.json] [--warn-only]
// Exits 1 when a budget is exceeded (0 with --warn-only, which CI uses to track numbers without failing a PR).
// On macOS the WebView's processes aren't children of the app, so idle memory there counts the app and the sidecar
// only (verify per macOS release).
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    binary: { type: "string", default: `target/debug/agentchainer${process.platform === "win32" ? ".exe" : ""}` },
    idle: { type: "string", default: "20" },
    timeout: { type: "string", default: "90" },
    json: { type: "string" },
    "warn-only": { type: "boolean", default: false },
  },
});

const budgets = JSON.parse(readFileSync(new URL("./perf-budgets.json", import.meta.url), "utf8"));
const idleSeconds = Number(values.idle);

/** Every process with its parent and resident memory in bytes, from the OS's own tools. */
function processes() {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(out).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      bytes: Number(p.WorkingSetSize),
      name: p.Name,
    }));
  }
  // `args`, not `comm`: Linux cuts `comm` to 15 characters ("agentchainer-si…"). The name is the program's file name.
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .map(([pid, ppid, rss, program = ""]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      bytes: Number(rss) * 1024,
      name: program.split("/").pop(),
    }));
}

/** The tree under `root`, grouped as the app, the sidecar, the WebView, and anything else. */
function treeMemory(root) {
  const all = processes();
  const kids = new Map();
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const tree = [];
  const walk = (pid) => {
    for (const k of kids.get(pid) ?? []) {
      tree.push(k);
      walk(k.pid);
    }
  };
  const self = all.find((p) => p.pid === root);
  if (self) tree.push(self);
  walk(root);
  const group = (p) =>
    p.pid === root
      ? "app"
      : // The packaged sidecar has its own name; a debug build runs it with Node.
        /sidecar|^node(\.exe)?$/i.test(p.name)
        ? "sidecar"
        : /webview|webkit|edge/i.test(p.name)
          ? "webview"
          : "other";
  const mb = (n) => Math.round(n / 1024 / 1024);
  const parts = {};
  for (const p of tree) parts[group(p)] = (parts[group(p)] ?? 0) + p.bytes;
  return {
    totalMb: mb(tree.reduce((s, p) => s + p.bytes, 0)),
    processes: tree.length,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, mb(v)])),
    others: tree.filter((p) => group(p) === "other").map((p) => `${p.name} ${mb(p.bytes)} MB`),
  };
}

const env = {
  ...process.env,
  AGENTCHAINER_SELFTEST: JSON.stringify({ bench: "startup", idleSeconds }),
};
const started = performance.now();
const app = spawn(resolve(values.binary), [], { env, stdio: ["ignore", "ignore", "pipe"] });
let startup = null;
let reportedAt = 0;
/** The app's log up to the report, each line with the time since launch: where a slow start went. */
const log = [];

createInterface({ input: app.stderr }).on("line", (line) => {
  if (!startup && log.length < 200)
    log.push(`${String(Math.round(performance.now() - started)).padStart(6)} ms  ${line}`);
  const at = line.indexOf("ui: ");
  if (at < 0 || startup) return;
  try {
    startup = JSON.parse(line.slice(at + 4)).selftest?.startup ?? null;
    if (startup) reportedAt = performance.now();
  } catch {
    // not a report line
  }
});

const deadline = Date.now() + Number(values.timeout) * 1000;
while (!startup && Date.now() < deadline && app.exitCode === null) await sleep(100);
if (!startup) {
  console.error(`FAIL: no startup report within ${values.timeout} s (exit code ${app.exitCode})`);
  console.error(log.join("\n"));
  app.kill();
  process.exit(1);
}
const startupMs = Math.round(reportedAt - started);
await sleep(idleSeconds * 1000);
const memory = treeMemory(app.pid);
app.kill();

const result = {
  platform: process.platform,
  startupMs,
  uiReadyMs: startup.uiReadyMs,
  readinessPassed: startup.ready,
  idleSeconds,
  idleMemoryMb: memory.totalMb,
  idleMemoryParts: memory.parts,
  processes: memory.processes,
  budgets: budgets[process.platform] ?? budgets.default,
};
const b = result.budgets;
const checks = [
  ["startup", startupMs, b.startupMs, "ms"],
  ["idle memory", memory.totalMb, b.idleMemoryMb, "MB"],
];
console.log(`${process.platform}: ${memory.processes} processes`);
for (const [name, value, max, unit] of checks) {
  console.log(`${name.padEnd(12)} ${value <= max ? "ok  " : "OVER"} ${value} ${unit} (budget ${max} ${unit})`);
}
console.log(`idle memory by process: ${JSON.stringify(memory.parts)}`);
if (memory.others.length) console.log(`other processes: ${memory.others.join(", ")}`);
if (startupMs > b.startupMs) console.log(`the app's log until it was ready:\n${log.join("\n")}`);
if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
const over = checks.filter(([, value, max]) => value > max);
if (over.length && !values["warn-only"]) process.exit(1);
