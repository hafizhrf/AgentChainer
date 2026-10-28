// Launches the built desktop app, checks that it survives startup, and optionally saves a screenshot.
// Used by CI to show the app shell opens on every OS (checklist M0-07).
//
// Usage: node scripts/smoke-launch.mjs <binary> [--seconds 15] [--screenshot out.png]
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "15" },
    screenshot: { type: "string" },
  },
});

const [binary] = positionals;
if (!binary) {
  console.error("usage: node scripts/smoke-launch.mjs <binary> [--seconds N] [--screenshot file.png]");
  process.exit(2);
}

const child = spawn(resolve(binary), [], { stdio: "inherit" });
let exited = null;
child.on("exit", (code, signal) => (exited = { code, signal }));
child.on("error", (err) => (exited = { error: err.message }));

await sleep(Number(values.seconds) * 1000);

if (exited) {
  console.error(`FAIL: app exited during startup: ${JSON.stringify(exited)}`);
  process.exit(1);
}
console.log(`OK: app still running after ${values.seconds}s`);

if (values.screenshot) {
  try {
    takeScreenshot(resolve(values.screenshot));
    console.log(`Screenshot saved to ${values.screenshot}`);
  } catch (err) {
    // Best effort: a runner may have no capturable display. The launch check above is the gate.
    console.warn(`WARN: screenshot failed: ${err.message}`);
  }
}

child.kill();
await Promise.race([new Promise((r) => child.once("exit", r)), sleep(5000)]);
process.exit(0);

function takeScreenshot(file) {
  if (process.platform === "darwin") {
    execFileSync("screencapture", ["-x", file]);
  } else if (process.platform === "linux") {
    execFileSync("import", ["-window", "root", file]);
  } else if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
      "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
      "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
      "[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
      `$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join("; ");
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  } else {
    throw new Error(`unsupported platform ${process.platform}`);
  }
}
