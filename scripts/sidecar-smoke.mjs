// Smoke test for the packaged sidecar (spike S1): starts the single executable with an empty app data dir, then
// checks `system.hello`, the first-run SDK download + integrity check (`sdk.prepare` → "download") and the cached
// second start (`sdk.prepare` → "cache"). Runs in CI on macOS, Windows and Ubuntu; no Claude login needed.
//
// Usage: node scripts/sidecar-smoke.mjs [path to sidecar executable]
//        (default: the one build:sea wrote to apps/desktop/src-tauri/binaries/)
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PROTOCOL_VERSION } from "../packages/protocol/src/index.ts";

const binDir = resolve("apps/desktop/src-tauri/binaries");
const bin =
  process.argv[2] ?? join(binDir, readdirSync(binDir).find((f) => f.startsWith("agentchainer-sidecar-")) ?? "");
const dataDir = mkdtempSync(join(tmpdir(), "ac-sidecar-smoke-"));

/** Spawns the sidecar, sends the methods in order, and returns each result with its time since spawn. */
function run(methods) {
  return new Promise((done, fail) => {
    const t0 = performance.now();
    const child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, AGENTCHAINER_DATA_DIR: dataDir },
    });
    const results = [];
    const next = () => {
      const method = methods[results.length];
      if (!method) return child.stdin.end();
      const params = method === "system.hello" ? { protocolVersion: PROTOCOL_VERSION } : {};
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: results.length + 1, method, params })}\n`);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.error) {
        // Stop the sidecar, or its open pipes keep this script alive.
        child.kill();
        return fail(new Error(`${methods[results.length]}: ${frame.error.message}`));
      }
      results.push({ method: methods[results.length], ms: Math.round(performance.now() - t0), result: frame.result });
      next();
    });
    child.on("error", fail);
    child.on("exit", () =>
      results.length === methods.length ? done(results) : fail(new Error("sidecar exited early")),
    );
    next();
  });
}

// A hung sidecar fails the check instead of the whole CI job.
setTimeout(() => {
  console.error("FAIL: no answer within 5 minutes");
  process.exit(1);
}, 300_000).unref();

try {
  console.log(`sidecar: ${bin}`);
  const first = await run(["system.hello", "sdk.prepare"]);
  const second = await run(["system.hello", "sdk.prepare"]);
  for (const [label, results] of [
    ["first start", first],
    ["second start", second],
  ]) {
    console.log(
      `${label}: ${results.map((r) => `${r.method} ${r.ms} ms ${JSON.stringify(r.result).slice(0, 80)}`).join(" | ")}`,
    );
  }
  const ok =
    first[0]?.result.protocolVersion === PROTOCOL_VERSION &&
    first[1]?.result.source === "download" &&
    second[1]?.result.source === "cache";
  console.log(
    ok ? "OK: packaged sidecar starts, downloads + verifies the SDK, then reuses it" : "FAIL: unexpected results",
  );
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
// Exit now: a sidecar that didn't stop (or its children) must not keep this script alive.
process.exit();
