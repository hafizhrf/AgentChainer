// Exit criterion M4-E2: pan and zoom hold 60 fps with 200 nodes. Runs the debug app in its graph bench (no model calls,
// no workspace): the session graph with a synthetic 200-node scene is panned, then zoomed, through its viewport on every
// frame for 4 s each while the WebView's animation frame intervals are recorded.
//
// Usage (after a debug build): node scripts/graph-bench.mjs [--binary target/debug/agentchainer] [--timeout 60]
// Passes when both phases run at ≥ 55 fps with ≤ 5% dropped frames (frames over 1.5 × the display's interval). Keep
// the window on screen while it runs: a hidden or minimised WebView throttles its animation frames.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    binary: { type: "string", default: `target/debug/agentchainer${process.platform === "win32" ? ".exe" : ""}` },
    timeout: { type: "string", default: "60" },
  },
});

const env = { ...process.env, AGENTCHAINER_SELFTEST: JSON.stringify({ bench: "graph" }) };
const app = spawn(resolve(values.binary), [], { env, stdio: ["ignore", "ignore", "pipe"] });
let report = null;

createInterface({ input: app.stderr }).on("line", (line) => {
  const at = line.indexOf("ui: ");
  if (at < 0) return;
  try {
    report = JSON.parse(line.slice(at + 4)).selftest?.graphBench ?? report;
  } catch {
    // not a bench line
  }
});

const deadline = setTimeout(() => {
  console.error(`FAIL: no bench report within ${values.timeout} s`);
  app.kill();
  process.exit(1);
}, Number(values.timeout) * 1000);

app.on("exit", (code) => {
  clearTimeout(deadline);
  if (!report) {
    console.error(`FAIL: app exited (code ${code}) without a bench report`);
    process.exit(1);
  }
  console.log(JSON.stringify(report, null, 1));
  const ok = (s) => s.fps >= 55 && s.slowPct <= 5;
  const line = (name, s) =>
    `${name.padEnd(5)} ${ok(s) ? "ok  " : "SLOW"} ${s.fps} fps · p50 ${s.p50Ms} ms · p95 ${s.p95Ms} ms · p99 ${s.p99Ms} ms · max ${s.maxMs} ms · dropped ${s.slowPct}%`;
  console.log(`${report.nodes} nodes, ${report.viewport.width}×${report.viewport.height} @${report.viewport.dpr}x`);
  console.log(line("pan", report.pan));
  console.log(line("zoom", report.zoom));
  const pass = report.nodes >= 200 && ok(report.pan) && ok(report.zoom);
  console.log(pass ? "OK: 200 nodes hold 60 fps" : "FAIL: below 60 fps");
  process.exit(pass ? 0 : 1);
});
