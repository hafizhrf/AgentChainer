import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeJson } from "./steps.ts";

const merged = (text: string, value: Record<string, unknown>) => JSON.parse(mergeJson(text, value));

describe("mergeJson", () => {
  it("merges objects key by key and keeps what's there", () => {
    const out = merged('{ "a": { "x": 1 }, "b": 2 }', { a: { y: 3 }, c: 4 });
    assert.deepEqual(out, { a: { x: 1, y: 3 }, b: 2, c: 4 });
  });

  it("adds permission rules to the lists that are there, once each, in order (M2-31)", () => {
    const settings = JSON.stringify({
      permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)"], defaultMode: "default" },
    });
    const out = merged(settings, {
      permissions: { allow: ["Bash(npm test)", "Bash(npm run lint)"], deny: ["Read(./secrets/**)"], ask: ["WebFetch"] },
    });
    assert.deepEqual(out.permissions, {
      allow: ["Bash(npm test)", "Bash(npm run lint)"],
      deny: ["Read(./.env)", "Read(./secrets/**)"],
      ask: ["WebFetch"],
      defaultMode: "default",
    });
  });

  it("replaces other arrays, such as an MCP server's args", () => {
    const out = merged('{ "mcpServers": { "p": { "args": ["-y", "p@1"] } }, "allow": ["a"] }', {
      mcpServers: { p: { args: ["-y", "p@2"] } },
      allow: ["b"],
    });
    assert.deepEqual(out.mcpServers.p.args, ["-y", "p@2"]);
    assert.deepEqual(out.allow, ["b"], "only the settings file's permission lists are merged");
  });

  it("starts from an empty file and refuses what isn't a JSON object", () => {
    assert.deepEqual(merged("", { permissions: { deny: ["Read(./.env)"] } }), {
      permissions: { deny: ["Read(./.env)"] },
    });
    assert.throws(() => mergeJson("{ nope", {}, ".claude/settings.json"), /\.claude\/settings\.json isn't valid JSON/);
    assert.throws(() => mergeJson("[]", {}), /doesn't hold a JSON object/);
  });
});
