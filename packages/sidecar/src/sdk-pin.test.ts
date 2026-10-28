import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import pin from "./sdk-pin.json" with { type: "json" };
import { pinFromLockfile } from "./sdk-pin.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("sdk-pin.json", () => {
  it("matches package.json and pnpm-lock.yaml (run scripts/pin-sdk.ts after bumping the SDK)", () => {
    const pkg = JSON.parse(read("../package.json")) as { dependencies: Record<string, string> };
    const version = pkg.dependencies["@anthropic-ai/claude-agent-sdk"] ?? "";
    assert.deepEqual(pin, pinFromLockfile(read("../../../pnpm-lock.yaml"), "@anthropic-ai/claude-agent-sdk", version));
  });

  it("rejects version ranges, so the download stays reproducible", () => {
    assert.throws(() => pinFromLockfile("", "x", "^1.0.0"), /exact version/);
  });
});
