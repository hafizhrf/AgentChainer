import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { authStatusProblem, CLI_CONTRACT, missingFlags, versionProblem } from "./cli-contract.ts";

/** The CLI contract the weekly drift job checks (X-05). */

const entry = (cmd: string) => {
  const e = CLI_CONTRACT.find((c) => c.command.join(" ") === cmd);
  assert.ok(e, `no contract entry for ${cmd}`);
  return e;
};

describe("the CLI contract (X-05)", () => {
  it("covers every plugin and MCP command installer.ts runs, with its flags", () => {
    const source = readFileSync(new URL("./installer.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/\["(plugin|mcp)",([^\]]*)\]/g)];
    assert.ok(calls.length >= 10, `found only ${calls.length} CLI calls in installer.ts`);
    for (const [, top = "", rest = ""] of calls) {
      const literals = [...rest.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
      // A bare "--" ends the options (`mcp add … -- <command>`); it's not a flag.
      const flags = literals.filter((l) => l.startsWith("--") && l !== "--");
      const words = literals.filter((l) => !l.startsWith("-"));
      // `["plugin", "marketplace", "list", …]` is one command; `enabled ? "enable" : "disable"` is two.
      const commands = words[0] === "marketplace" ? [[top, ...words]] : words.map((w) => [top, w]);
      for (const command of commands) {
        const e = entry(command.join(" "));
        for (const f of flags) assert.ok(e.flags.includes(f), `${command.join(" ")} uses ${f}, not in the contract`);
      }
    }
  });

  it("finds flags only where --help lists them as options", () => {
    const help = `Usage: claude plugin install|i [options] <plugin>

Options:
  --accept-command <sha256>  Accept the command a previous --json run reported
  -s, --scope <scope>        Installation scope
  -h, --help                 Display help for command`;
    assert.deepEqual(missingFlags(help, entry("plugin install")), ["--json"]);
    assert.deepEqual(missingFlags(`${help}\n  --json  Print one line`, entry("plugin install")), []);
  });

  it("needs at least the minimum CLI version", () => {
    assert.equal(versionProblem("2.1.318 (Claude Code)"), null);
    assert.equal(versionProblem("3.0.0 (Claude Code)"), null);
    assert.match(versionProblem("2.1.200 (Claude Code)") ?? "", /older than/);
    assert.match(versionProblem("") ?? "", /unreadable/);
  });

  it("reads auth status when signed out too", () => {
    assert.equal(authStatusProblem('{"loggedIn": false, "authMethod": "none"}'), null);
    assert.match(authStatusProblem('{"signedIn": true}') ?? "", /loggedIn/);
    assert.match(authStatusProblem("Not logged in") ?? "", /loggedIn/);
  });
});
