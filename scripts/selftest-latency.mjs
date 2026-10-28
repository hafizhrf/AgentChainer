// Spike S2: runs the debug app in self-test mode (one real turn, no clicks) and measures how long each streamed text
// delta takes from the sidecar to the UI, plus CPU and memory of the app's process tree while it streams.
// Makes a real model call with your own `claude` login; keep the default haiku model.
//
// Usage: node scripts/selftest-latency.mjs --cwd <empty scratch dir> [--binary target/debug/agentchainer]
//        [--model haiku] [--prompt "..."] [--timeout 180]
// macOS/Linux only (uses `ps`). The WebView's own processes are not children of the app on macOS, so their CPU is
// not included.
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    binary: { type: "string", default: "target/debug/agentchainer" },
    cwd: { type: "string" },
    model: { type: "string", default: "haiku" },
    prompt: {
      type: "string",
      default: "Write a 300-word story about a lighthouse keeper. Plain text only, no headings, no tools.",
    },
    timeout: { type: "string", default: "180" },
  },
});
if (!values.cwd) {
  console.error("--cwd is required (use an empty scratch folder)");
  process.exit(2);
}

const env = {
  ...process.env,
  AGENTCHAINER_METRICS: "1",
  AGENTCHAINER_SELFTEST: JSON.stringify({ cwd: resolve(values.cwd), model: values.model, prompt: values.prompt }),
};
const app = spawn(resolve(values.binary), [], { env, stdio: ["ignore", "ignore", "pipe"] });
const samples = [];
let report = null;

createInterface({ input: app.stderr }).on("line", (line) => {
  const at = line.indexOf("ui: ");
  if (at < 0) return;
  try {
    report = JSON.parse(line.slice(at + 4)).selftest ?? report;
  } catch {
    // not a self-test line
  }
});

const sampler = setInterval(sampleTree, 250);
const deadline = setTimeout(() => {
  console.error(`FAIL: no self-test report within ${values.timeout} s`);
  app.kill();
  process.exit(1);
}, Number(values.timeout) * 1000);

app.on("exit", (code) => {
  clearInterval(sampler);
  clearTimeout(deadline);
  summarize(code);
});

function sampleTree() {
  let out;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss=,comm="], { encoding: "utf8" });
  } catch {
    return;
  }
  const rows = out
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, cpu, rss, ...comm] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), rssKb: Number(rss), comm: comm.join(" ") };
    });
  const tree = new Set([app.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (!tree.has(r.pid) && tree.has(r.ppid)) {
        tree.add(r.pid);
        grew = true;
      }
    }
  }
  const sum = (pick) =>
    rows
      .filter((r) => tree.has(r.pid) && pick(r))
      .reduce((acc, r) => ({ cpu: acc.cpu + r.cpu, rssMb: acc.rssMb + r.rssKb / 1024 }), { cpu: 0, rssMb: 0 });
  samples.push({
    app: sum((r) => r.pid === app.pid),
    sidecar: sum((r) => r.pid !== app.pid && /node$/.test(r.comm)),
    claude: sum((r) => /claude/.test(r.comm)),
  });
}

function summarize(code) {
  if (!report) {
    console.error(`FAIL: app exited (code ${code}) without a self-test report`);
    process.exit(1);
  }
  const stat = (key, field) => {
    const xs = samples.map((s) => s[key][field]);
    const avg = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    return { avg: Math.round(avg * 10) / 10, max: Math.round(Math.max(0, ...xs) * 10) / 10 };
  };
  console.log(JSON.stringify({ report, samples: samples.length }, null, 1));
  for (const key of ["app", "sidecar", "claude"]) {
    const cpu = stat(key, "cpu");
    const mem = stat(key, "rssMb");
    console.log(
      `${key.padEnd(8)} CPU avg ${cpu.avg}% max ${cpu.max}%  ·  RSS avg ${mem.avg} MB max ${mem.max} MB (ps pcpu is a decaying average)`,
    );
  }
  const ok = report.deltaLatencyMs.count > 0 && report.subtype === "success";
  console.log(ok ? "OK: self-test completed" : "FAIL: no deltas measured or the turn failed");
  process.exit(ok ? 0 : 1);
}
