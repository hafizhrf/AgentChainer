// PostToolUse hook (checklist M0-12): formats the file Claude just edited so agent changes match the repo style.
// It never blocks the agent, and it only formats and sorts imports: applying lint fixes mid-edit is unsafe (an
// edit that declares a `let` before the edit that reassigns it got turned into a `const`). Lint is `pnpm lint` and CI.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";

const BIOME_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".css", ".yml", ".yaml"]);

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw || "{}");
const file = payload.tool_input?.file_path;
const root = process.env.CLAUDE_PROJECT_DIR ?? payload.cwd ?? process.cwd();

if (typeof file === "string") {
  const ext = extname(file);
  try {
    if (BIOME_EXTENSIONS.has(ext)) {
      execFileSync(
        "pnpm",
        ["exec", "biome", "check", "--write", "--linter-enabled=false", "--no-errors-on-unmatched", file],
        {
          cwd: root,
          stdio: "ignore",
        },
      );
    } else if (ext === ".rs") {
      // ~/.cargo/bin is often missing from non-interactive shells.
      const cargoRustfmt = join(homedir(), ".cargo", "bin", "rustfmt");
      const rustfmt = existsSync(cargoRustfmt) ? cargoRustfmt : "rustfmt";
      execFileSync(rustfmt, ["--edition", "2024", file], { cwd: root, stdio: "ignore" });
    }
  } catch {
    // Formatting is best effort; CI enforces the real gate.
  }
}
