import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { missingFlags } from "../cli-contract.ts";
import { AGY_CONTRACT, CODEX_CONTRACT, codexContractProblems } from "./contracts.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A schema folder shaped like `codex app-server generate-json-schema`'s, holding exactly the contract, less `drop`. */
function schemaFolder(drop: { method?: string; word?: string } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ac-codex-schema-"));
  dirs.push(dir);
  const union = (methods: readonly string[]) => ({
    oneOf: methods
      .filter((m) => m !== drop.method)
      .map((m) => ({ type: "object", properties: { method: { type: "string", enum: [m] } } })),
  });
  writeFileSync(path.join(dir, "ClientRequest.json"), JSON.stringify(union(CODEX_CONTRACT.clientRequests)));
  writeFileSync(path.join(dir, "ClientNotification.json"), JSON.stringify(union(CODEX_CONTRACT.clientNotifications)));
  writeFileSync(path.join(dir, "ServerNotification.json"), JSON.stringify(union(CODEX_CONTRACT.serverNotifications)));
  writeFileSync(path.join(dir, "ServerRequest.json"), JSON.stringify(union(CODEX_CONTRACT.serverRequests)));
  // Every definition in one bundle, as the real one has them: values as enums, fields as properties, some by $ref.
  const definitions: Record<string, unknown> = {};
  for (const [name, words] of Object.entries(CODEX_CONTRACT.definitions)) {
    const kept = words.filter((w) => w !== drop.word);
    definitions[name] = {
      oneOf: [
        { type: "string", enum: kept.filter((w) => w.includes("-") || /^[a-z]+$/.test(w)) },
        { $ref: `#/definitions/${name}Fields` },
      ],
    };
    definitions[`${name}Fields`] = { type: "object", properties: Object.fromEntries(kept.map((w) => [w, {}])) };
  }
  writeFileSync(path.join(dir, "bundle.v2.schemas.json"), JSON.stringify({ definitions }));
  return dir;
}

describe("the Codex app-server contract (M9-04, X-05)", () => {
  it("holds for a schema with everything the backend uses", () => {
    assert.deepEqual(codexContractProblems(schemaFolder()), []);
  });

  it("names a method the protocol dropped", () => {
    assert.deepEqual(codexContractProblems(schemaFolder({ method: "turn/steer" })), [
      "ClientRequest.json lost turn/steer",
    ]);
    assert.deepEqual(codexContractProblems(schemaFolder({ method: "item/fileChange/requestApproval" })), [
      "ServerRequest.json lost item/fileChange/requestApproval",
    ]);
  });

  it("names a value or field a definition lost", () => {
    const problems = codexContractProblems(schemaFolder({ word: "cachedInputTokens" }));
    assert.deepEqual(problems, ["TokenUsageBreakdown lost cachedInputTokens"]);
  });

  it("says when the folder isn't a schema at all", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "ac-codex-schema-"));
    dirs.push(empty);
    const problems = codexContractProblems(empty);
    assert.ok(problems.includes("ClientRequest.json is missing or isn't JSON"));
    assert.ok(problems.includes("no definition SandboxMode"));
  });
});

describe("the agy contract (M9-05, X-05)", () => {
  // Lines as `agy --help` 1.5.4 prints them.
  const help = [
    "Usage of agy.exe:",
    "  --add-dir                       Add a directory to the workspace (repeatable) (default [])",
    "  --conversation                  Resume a previous conversation by ID",
    "  --json-schema                   Optional JSON schema string or path to a schema file",
    "  --mode                          Set the agent execution mode for this session (accept-edits, auto, plan)",
    "  --model                         Model for the current CLI session",
    "  --output-format                 Output format for print mode (text, json, stream-json) (default text)",
    "  -p                              Short alias for --print",
    "  --sandbox                       Run in a sandbox with terminal restrictions enabled",
    "  --settings                      Settings for this session only, never saved",
  ].join("\n");

  it("finds every flag the backend passes, and names one that's gone", () => {
    const entry = { command: [], flags: AGY_CONTRACT.flags, why: AGY_CONTRACT.why };
    assert.deepEqual(missingFlags(help, entry), []);
    assert.deepEqual(missingFlags(help.replace(/^ {2}--settings.*$/m, ""), entry), ["--settings"]);
  });
});
