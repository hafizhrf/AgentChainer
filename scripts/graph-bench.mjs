// Exit criterion M4-E2: pan and zoom hold 60 fps with 200 nodes. Runs the debug app in its graph bench (no model calls,
// no workspace): the session graph with a synthetic 200-node scene is panned, then zoomed, through its viewport on every
// frame for 4 s each while the WebView's animation frame intervals are recorded. That runs twice: fitted to the window
// (the most nodes on screen), then close up at zoom 1 (nodes with their text).
//
// Usage (after a debug build): node scripts/graph-bench.mjs [--binary target/debug/agentchainer] [--timeout 60]
// Passes when all four phases run at ≥ 55 fps with ≤ 5% dropped frames (frames over 1.5 × the display's interval).
// Keep the window in front while it runs: a hidden or covered WebView throttles its animation frames. A second with
// nothing moving is measured first; when even that is below 55 fps, the run doesn't count (exit code 2).
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
    `${name.padEnd(14)} ${ok(s) ? "ok  " : "SLOW"} ${s.fps} fps · p50 ${s.p50Ms} ms · p95 ${s.p95Ms} ms · p99 ${s.p99Ms} ms · max ${s.maxMs} ms · dropped ${s.slowPct}%`;
  console.log(`${report.nodes} nodes, ${report.viewport.width}×${report.viewport.height} @${report.viewport.dpr}x`);
  console.log(line("idle", report.idle));
  if (!ok(report.idle)) {
    console.error(
      "NOT COUNTED: the WebView was throttled with nothing moving. Keep the window in front and run again.",
    );
    process.exit(2);
  }
  console.log(line("pan", report.pan));
  console.log(line("zoom", report.zoom));
  console.log(line("close-up pan", report.closeUp.pan));
  console.log(line("close-up zoom", report.closeUp.zoom));
  const phases = [report.pan, report.zoom, report.closeUp.pan, report.closeUp.zoom];
  const pass = report.nodes >= 200 && phases.every(ok);
  console.log(pass ? "OK: 200 nodes hold 60 fps" : "FAIL: below 60 fps");
  process.exit(pass ? 0 : 1);
});
