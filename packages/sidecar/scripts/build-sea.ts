// Builds the sidecar as a single executable (Node SEA) for the current platform (spike S1, M0-15).
// The executable holds only our code. The Claude Agent SDK is NOT inside: it is downloaded and verified on first run
// (ADR-0003, M0-03). Tauri ships the output as `bundle.externalBin`.
//
// Output: apps/desktop/src-tauri/binaries/agentchainer-sidecar-<target-triple>[.exe]
// Usage:  node scripts/build-sea.ts [--force]   (skips work when the output is newer than every input)
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { inject } from "postject";

const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
const t0 = performance.now();
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(pkgDir, "..", "..");
const distDir = join(pkgDir, "dist");

// Rust target triples Tauri uses to pick the right `externalBin` for each platform.
const TRIPLES: Record<string, string> = {
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`Unsupported build platform ${process.platform}-${process.arch}`);
const exe = process.platform === "win32" ? ".exe" : "";
const out = join(repoDir, "apps", "desktop", "src-tauri", "binaries", `agentchainer-sidecar-${triple}${exe}`);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const inputs = [
  ...walk(join(pkgDir, "src")).filter((f) => !f.endsWith(".test.ts")),
  ...walk(join(repoDir, "packages", "protocol", "src")),
  join(pkgDir, "package.json"),
  process.execPath,
];
if (!values.force && existsSync(out) && statSync(out).mtimeMs > Math.max(...inputs.map((f) => statSync(f).mtimeMs))) {
  console.log(`sidecar executable up to date: ${out}`);
  process.exit(0);
}

// 1. One CommonJS file with our code. The SDK stays external; sdk-loader.ts imports it at runtime.
mkdirSync(distDir, { recursive: true });
const bundle = join(distDir, "sidecar.cjs");
await build({
  entryPoints: [join(pkgDir, "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile: bundle,
  external: ["@anthropic-ai/claude-agent-sdk"],
  legalComments: "none",
  logLevel: "warning",
});

// 2. SEA preparation blob, made by the same Node binary we inject into (the blob format is version-specific).
const blob = join(distDir, "sea-prep.blob");
const seaConfig = join(distDir, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "ignore" });

// 3. A copy of this Node binary. Official macOS Node binaries are universal (x86_64 + arm64), so the SEA fuse appears
//    twice and postject refuses; keep only this machine's architecture.
mkdirSync(dirname(out), { recursive: true });
if (process.platform === "darwin") {
  const archs = execFileSync("lipo", ["-archs", process.execPath], { encoding: "utf8" }).trim().split(/\s+/);
  if (archs.length > 1) {
    execFileSync("lipo", ["-thin", process.arch === "arm64" ? "arm64" : "x86_64", "-output", out, process.execPath]);
  } else {
    copyFileSync(process.execPath, out);
  }
  chmodSync(out, 0o755);
  execFileSync("codesign", ["--remove-signature", out]);
} else {
  copyFileSync(process.execPath, out);
  chmodSync(out, 0o755);
}

// 4. Inject the blob. macOS also needs a (here ad hoc) signature to run; real signing happens at release (R1-03).
await inject(out, "NODE_SEA_BLOB", readFileSync(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", out]);

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
console.log(
  `sidecar executable: ${out}\n  bundle ${mb(statSync(bundle).size)} · executable ${mb(statSync(out).size)} · node ${process.version} · ${((performance.now() - t0) / 1000).toFixed(1)} s`,
);
