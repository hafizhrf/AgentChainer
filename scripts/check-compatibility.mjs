// X-08: docs/COMPATIBILITY.md must state the CLI minimum the code enforces (MIN_CLAUDE_VERSION in
// packages/sidecar/src/claude.ts) and the SDK version the app downloads (packages/sidecar/src/sdk-pin.json). CI runs
// this, so bumping either one means updating the page.
//
// Usage: node scripts/check-compatibility.mjs
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const doc = read("docs/COMPATIBILITY.md");
const minCli = /export const MIN_CLAUDE_VERSION = "([^"]+)"/.exec(read("packages/sidecar/src/claude.ts"))?.[1];
const sdk = JSON.parse(read("packages/sidecar/src/sdk-pin.json")).version;

const problems = [];
if (!minCli) problems.push("MIN_CLAUDE_VERSION not found in packages/sidecar/src/claude.ts");
else if (!doc.includes(`Minimum: **${minCli}**`)) problems.push(`the CLI minimum isn't "Minimum: **${minCli}**"`);
if (!doc.includes(`Pinned: **${sdk}**`)) problems.push(`the SDK pin isn't "Pinned: **${sdk}**"`);

if (problems.length) {
  console.error(`FAIL: docs/COMPATIBILITY.md is out of date:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`OK: docs/COMPATIBILITY.md matches CLI ${minCli}+ and SDK ${sdk}`);
