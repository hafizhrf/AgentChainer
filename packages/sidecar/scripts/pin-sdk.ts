// Writes src/sdk-pin.json from pnpm-lock.yaml: the exact Agent SDK version, its npm tarball URL and integrity hash.
// The packaged app downloads and verifies exactly this tarball on first run (ADR-0003, M0-03).
// Run after bumping the SDK: node scripts/pin-sdk.ts   (src/sdk-pin.test.ts fails while the pin is stale)
import { readFileSync, writeFileSync } from "node:fs";
import { pinFromLockfile } from "../src/sdk-pin.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};
const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
const pin = pinFromLockfile(
  lock,
  "@anthropic-ai/claude-agent-sdk",
  pkg.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "",
);
writeFileSync(new URL("../src/sdk-pin.json", import.meta.url), `${JSON.stringify(pin, null, 2)}\n`);
console.log(`pinned ${pin.name}@${pin.version} (${pin.integrity.slice(0, 20)}…)`);
