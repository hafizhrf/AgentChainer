// X-05: checks that a `claude` CLI still has every command and flag AgentChainer runs (src/cli-contract.ts), that its
// version is at least the minimum, and that `auth status --json` still parses. No model calls and no login needed:
// it reads `--help` output. The weekly drift job runs it against the newest CLI.
//
// M9: with `--codex <path>`, it also checks the Codex CLI: the commands the app runs, and `codex app-server`'s protocol
// (its generated JSON Schema) against the methods, values and fields the Codex backend uses (backends/contracts.ts).
// With `--agy <path>`, the Antigravity CLI's flags and subcommands; agy has no package CI can install without running
// an install script, so that one is checked by hand.
//
// Usage: node packages/sidecar/scripts/cli-contract.ts [--claude <path>] [--codex <path>] [--agy <path>] [--skip-claude]
//   a `.js` path (the npm package's `bin/codex.js`) runs with this Node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { AGY_CONTRACT, CODEX_COMMANDS, CODEX_CONTRACT, codexContractProblems } from "../src/backends/contracts.ts";
import { findClaude } from "../src/claude.ts";
import { authStatusProblem, CLI_CONTRACT, missingFlags, versionProblem } from "../src/cli-contract.ts";

const { values } = parseArgs({
  options: {
    claude: { type: "string" },
    codex: { type: "string" },
    agy: { type: "string" },
    "skip-claude": { type: "boolean", default: false },
  },
});

const problems: string[] = [];
const runner = (bin: string) => (args: string[]) =>
  bin.endsWith(".js")
    ? spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 60_000 })
    : spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
let checked = 0;

if (!values["skip-claude"]) {
  const claude = values.claude ?? findClaude();
  if (!claude) {
    console.error("FAIL: no `claude` CLI found (pass --claude <path>)");
    process.exit(1);
  }
  const run = runner(claude);
  const version = run(["--version"]);
  console.log(`claude ${version.stdout.trim()}`);
  const v = versionProblem(version.stdout);
  if (v) problems.push(v);

  // Exits 1 when signed out but still prints JSON. Only whether it parses is shown: it also carries account details.
  const auth = authStatusProblem(run(["auth", "status", "--json"]).stdout);
  console.log(`${auth ? "FAIL" : "ok  "} auth status --json parses`);
  if (auth) problems.push(auth);

  for (const entry of CLI_CONTRACT) {
    const name = entry.command.join(" ");
    const help = run([...entry.command, "--help"]);
    const missing = help.status === 0 ? missingFlags(help.stdout, entry) : null;
    if (missing === null)
      problems.push(`\`claude ${name} --help\` failed (exit ${help.status}): ${help.stderr.trim()}`);
    else if (missing.length) problems.push(`\`claude ${name}\` lost ${missing.join(", ")} (${entry.why})`);
    console.log(`${missing?.length === 0 ? "ok  " : "FAIL"} ${name} ${entry.flags.join(" ")}`);
  }
  checked++;
}

if (values.codex) {
  const run = runner(values.codex);
  const version = run(["--version"]);
  console.log(`\n${version.stdout.trim() || `codex --version failed (exit ${version.status})`}`);
  if (version.status !== 0) problems.push(`\`codex --version\` failed (exit ${version.status})`);
  for (const c of CODEX_COMMANDS) {
    const help = run([...c.command, "--help"]);
    console.log(`${help.status === 0 ? "ok  " : "FAIL"} codex ${c.command.join(" ")}`);
    if (help.status !== 0)
      problems.push(`\`codex ${c.command.join(" ")} --help\` failed (exit ${help.status}) (${c.why})`);
  }
  const out = mkdtempSync(path.join(tmpdir(), "ac-codex-schema-"));
  try {
    const gen = run(["app-server", "generate-json-schema", "--out", out]);
    if (gen.status !== 0) {
      problems.push(`\`codex app-server generate-json-schema\` failed (exit ${gen.status}): ${gen.stderr.trim()}`);
    } else {
      const found = codexContractProblems(out);
      const counted =
        CODEX_CONTRACT.clientRequests.length +
        CODEX_CONTRACT.clientNotifications.length +
        CODEX_CONTRACT.serverNotifications.length +
        CODEX_CONTRACT.serverRequests.length;
      console.log(
        `${found.length ? "FAIL" : "ok  "} app-server protocol: ${counted} methods, ` +
          `${Object.keys(CODEX_CONTRACT.definitions).length} definitions`,
      );
      problems.push(...found.map((p) => `codex app-server: ${p}`));
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  checked++;
}

if (values.agy) {
  const run = runner(values.agy);
  const version = run(["--version"]);
  console.log(`\nagy ${version.stdout.trim() || `--version failed (exit ${version.status})`}`);
  if (version.status !== 0) problems.push(`\`agy --version\` failed (exit ${version.status})`);
  // agy prints its help to stderr or stdout depending on the build; both are read.
  const help = run(["--help"]);
  const text = `${help.stdout}\n${help.stderr}`;
  const missing = missingFlags(text, { command: [], flags: AGY_CONTRACT.flags, why: AGY_CONTRACT.why });
  const gone = [
    ...missing,
    ...AGY_CONTRACT.subcommands.filter((s) => !new RegExp(`^\\s+${s}\\s`, "m").test(text)),
    ...AGY_CONTRACT.values.filter((v) => !text.includes(v)),
  ];
  console.log(
    `${gone.length ? "FAIL" : "ok  "} agy ${AGY_CONTRACT.flags.join(" ")}; ${AGY_CONTRACT.subcommands.join(" ")}`,
  );
  if (gone.length) problems.push(`\`agy\` lost ${gone.join(", ")} (${AGY_CONTRACT.why})`);
  checked++;
}

if (!checked) {
  console.error("FAIL: nothing to check (--skip-claude with neither --codex nor --agy)");
  process.exit(1);
}
if (problems.length) {
  console.error(`\nFAIL: ${problems.length} contract problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nOK: ${checked} CLI contract(s) hold`);
