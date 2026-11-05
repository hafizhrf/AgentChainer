// X-06: runs the end-to-end tests against a debug build through WebDriver, on Linux and Windows, then X-12's
// accessibility audits (a11y.e2e.mjs). macOS has no WebDriver for its WebView: use docs/guides/MANUAL_CHECKS.md there.
//
// Usage: node scripts/e2e/run.mjs --binary target/debug/agentchainer [--artifacts e2e-artifacts]
// - Linux: tauri-driver (cargo install tauri-driver --version 2.1.0 --locked) with WebKitWebDriver (apt:
//   webkit2gtk-driver), and a display (xvfb-run -a).
// - Windows: msedgedriver matching the WebView2 runtime, in the folder EDGEWEBDRIVER names (GitHub's Windows runners
//   have it). The app starts here with WebView2's debugging port open and msedgedriver attaches to it.
//
// A debug build is required: it takes its settings from AGENTCHAINER_CONFIG_DIR and passes
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS on, which release builds ignore. The settings (seeded with one recent
// workspace), Linux's data and logs, and the workspace itself (a git copy of fixtures/sample-app) are all temporary.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { binary: { type: "string" }, artifacts: { type: "string", default: "e2e-artifacts" } },
});
if (process.platform === "darwin") {
  console.error("macOS has no WebDriver for WKWebView. Run the checks in docs/guides/MANUAL_CHECKS.md by hand.");
  process.exit(1);
}
if (!values.binary) {
  console.error("Usage: node scripts/e2e/run.mjs --binary target/debug/agentchainer");
  process.exit(1);
}
const repo = path.resolve(import.meta.dirname, "..", "..");
const binary = path.resolve(values.binary);
const artifacts = path.resolve(values.artifacts);
mkdirSync(artifacts, { recursive: true });

// The app's own folders, all temporary.
const home = mkdtempSync(path.join(tmpdir(), "ac-e2e-"));
const dirs =
  process.platform === "win32"
    ? // Only the settings move on Windows: WebView2 and msedgedriver keep their data under LOCALAPPDATA.
      { APPDATA: path.join(home, "roaming") }
    : {
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
      };
const configDir = path.join(
  process.platform === "win32" ? dirs.APPDATA : dirs.XDG_CONFIG_HOME,
  "io.github.hafizhrf.agentchainer",
);
const logDir = path.join(
  process.platform === "win32" ? (process.env.LOCALAPPDATA ?? home) : dirs.XDG_DATA_HOME,
  "io.github.hafizhrf.agentchainer",
  "logs",
);

// The workspace: a git repository copied from the fixture.
// The long form of the path: Windows runners' temp folder is an 8.3 short name (RUNNER~1), which the app shows as is.
const workspace = path.join(realpathSync.native(home), "sample-app");
cpSync(path.join(repo, "fixtures", "sample-app"), workspace, { recursive: true });
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], { cwd: workspace });
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "fixture");

mkdirSync(configDir, { recursive: true });
const settingsFile = path.join(configDir, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ recentWorkspaces: [workspace] }, null, 2));

// A debug build reads its settings from AGENTCHAINER_CONFIG_DIR (Windows takes its config folder from the system).
const env = { ...process.env, ...dirs, AGENTCHAINER_CONFIG_DIR: configDir };
const windows = process.platform === "win32";

// Linux: tauri-driver starts the app through WebKitWebDriver. Windows: the app starts here with WebView2's debugging
// port open, and msedgedriver attaches to it (debuggerAddress); launched by msedgedriver itself, a Tauri app's
// DevToolsActivePort file isn't where msedgedriver looks.
const DEBUG_PORT = 9222;
const started = windows
  ? spawn(binary, [], {
      env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${DEBUG_PORT}` },
      stdio: ["ignore", "inherit", "inherit"],
    })
  : null;
const driverBin = windows ? path.join(process.env.EDGEWEBDRIVER ?? "", "msedgedriver.exe") : "tauri-driver";
const driver = spawn(driverBin, windows ? ["--port=4444"] : [], { env, stdio: ["ignore", "inherit", "inherit"] });
driver.on("error", (err) => {
  console.error(
    `couldn't start ${driverBin}: ${err.message}. ${windows ? "Set EDGEWEBDRIVER to msedgedriver's folder." : "Install it with: cargo install tauri-driver"}`,
  );
  process.exit(1);
});

let code = 1;
try {
  await waitForDriver();
  if (windows) await waitForDebugPort();
  // One file at a time, in this order: the X-06 flows expect the app as it starts, and on Windows both files drive the
  // same running instance. (node --test sorts the files it's given, so each gets its own run.)
  code = 0;
  for (const file of ["app.e2e.mjs", "a11y.e2e.mjs"]) {
    const exit = await new Promise((resolve) => {
      const tests = spawn(process.execPath, ["--test", "--test-reporter=spec", path.join(import.meta.dirname, file)], {
        env: {
          ...env,
          AC_E2E_BINARY: binary,
          AC_E2E_WORKSPACE: workspace,
          AC_E2E_SETTINGS: settingsFile,
          AC_E2E_ARTIFACTS: artifacts,
          ...(windows ? { AC_E2E_DEBUGGER: `127.0.0.1:${DEBUG_PORT}` } : {}),
        },
        stdio: "inherit",
      });
      tests.on("exit", (c) => resolve(c ?? 1));
    });
    code ||= exit;
  }
} finally {
  driver.kill();
  started?.kill();
  // The app log, for a failed run's artifacts.
  if (code !== 0 && existsSync(logDir)) cpSync(logDir, path.join(artifacts, "logs"), { recursive: true });
}
process.exit(code);

async function waitForDriver() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:4444/status");
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the WebDriver server didn't start listening on 127.0.0.1:4444");
}

async function waitForDebugPort() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      // the WebView isn't up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the app's WebView2 didn't open its debugging port ${DEBUG_PORT} within 120 s`);
}
