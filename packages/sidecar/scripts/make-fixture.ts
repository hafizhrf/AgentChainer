// Turns a raw SDK recording (AGENTCHAINER_RECORD_SDK / spike-host --record) into a fixture that is safe to commit.
// Fails if any trace of the local home path or username survives.
//
// Usage: node scripts/make-fixture.ts <raw.jsonl> <out.jsonl> --cwd <workspace used while recording>
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { leaks, localIdentity, sanitizeForFixture } from "../src/fixtures.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { cwd: { type: "string" } } });
const [input, output] = positionals;
if (!input || !output || !values.cwd) {
  console.error("usage: node scripts/make-fixture.ts <raw.jsonl> <out.jsonl> --cwd <dir>");
  process.exit(2);
}

const id = localIdentity(values.cwd);
const lines = readFileSync(input, "utf8").split("\n").filter(Boolean);
const kept = lines.map((line) => sanitizeForFixture(JSON.parse(line), id)).filter((m) => m !== null);
const text = `${kept.map((m) => JSON.stringify(m)).join("\n")}\n`;

const found = leaks(text, id);
if (found.length) {
  console.error(`FAIL: fixture still contains identity strings (${found.length} kinds); not written.`);
  process.exit(1);
}
writeFileSync(output, text);
console.log(`kept ${kept.length}/${lines.length} messages, ${text.length} bytes → ${output}`);
