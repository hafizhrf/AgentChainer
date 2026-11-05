// X-06: runs the end-to-end tests against a debug build through tauri-driver (WebDriver), on Linux and Windows. macOS has
// no WebDriver for its WebView: use docs/guides/MANUAL_CHECKS.md there.
//
// Usage: node scripts/e2e/run.mjs --binary target/debug/agentchainer [--artifacts e2e-artifacts]
// Linux needs WebKitWebDriver (apt: webkit2gtk-driver) and a display (xvfb-run); Windows needs msedgedriver, found on
// PATH or in EDGEWEBDRIVER (GitHub's Windows runners have it). Both need tauri-driver (cargo install tauri-driver).
//
// Everything the app writes goes to temporary folders: its settings (seeded with one recent workspace), data, logs, and
// the workspace itself, a git copy of fixtures/sample-app. Nothing of yours is read or changed.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const workspace = path.join(home, "sample-app");
cpSync(path.join(repo, "fixtures", "sample-app"), workspace, { recursive: true });
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args], { cwd: workspace });
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "fixture");

mkdirSync(configDir, { recursive: true });
const settingsFile = path.join(configDir, "settings.json");
writeFileSync(settingsFile, JSON.stringify({ recentWorkspaces: [workspace] }, null, 2));

const env = { ...process.env, ...dirs };
const nativeDriver =
  process.platform === "win32" && process.env.EDGEWEBDRIVER
    ? ["--native-driver", path.join(process.env.EDGEWEBDRIVER, "msedgedriver.exe")]
    : [];
const driver = spawn("tauri-driver", nativeDriver, { env, stdio: ["ignore", "inherit", "inherit"] });
driver.on("error", (err) => {
  console.error(`couldn't start tauri-driver: ${err.message}. Install it with: cargo install tauri-driver`);
  process.exit(1);
});

let code = 1;
try {
  await waitForDriver();
  code = await new Promise((resolve) => {
    const tests = spawn(
      process.execPath,
      ["--test", "--test-reporter=spec", path.join(import.meta.dirname, "app.e2e.mjs")],
      {
        env: {
          ...env,
          AC_E2E_BINARY: binary,
          AC_E2E_WORKSPACE: workspace,
          AC_E2E_SETTINGS: settingsFile,
          AC_E2E_ARTIFACTS: artifacts,
        },
        stdio: "inherit",
      },
    );
    tests.on("exit", (c) => resolve(c ?? 1));
  });
} finally {
  driver.kill();
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
  throw new Error("tauri-driver didn't start listening on 127.0.0.1:4444");
}
