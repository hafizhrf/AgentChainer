// X-05: checks that a `claude` CLI still has every command and flag AgentChainer runs (src/cli-contract.ts), that its
// version is at least the minimum, and that `auth status --json` still parses. No model calls and no login needed:
// it reads `--help` output. The weekly drift job runs it against the newest CLI.
//
// Usage: node packages/sidecar/scripts/cli-contract.ts [--claude <path>]
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { findClaude } from "../src/claude.ts";
import { authStatusProblem, CLI_CONTRACT, missingFlags, versionProblem } from "../src/cli-contract.ts";

const { values } = parseArgs({ options: { claude: { type: "string" } } });
const claude = values.claude ?? findClaude();
if (!claude) {
  console.error("FAIL: no `claude` CLI found (pass --claude <path>)");
  process.exit(1);
}

const run = (args: string[]) => spawnSync(claude, args, { encoding: "utf8", timeout: 60_000 });
const problems: string[] = [];

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
  if (missing === null) problems.push(`\`claude ${name} --help\` failed (exit ${help.status}): ${help.stderr.trim()}`);
  else if (missing.length) problems.push(`\`claude ${name}\` lost ${missing.join(", ")} (${entry.why})`);
  console.log(`${missing?.length === 0 ? "ok  " : "FAIL"} ${name} ${entry.flags.join(" ")}`);
}

if (problems.length) {
  console.error(`\nFAIL: ${problems.length} contract problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nOK: ${CLI_CONTRACT.length} commands and their flags, the version and auth status`);
