import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelName } from "./modelName.ts";

describe("modelName (UX-18)", () => {
  it("shortens the CLI's model ids", () => {
    assert.equal(modelName("claude-haiku-5-5"), "Haiku 5.5");
    assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
    assert.equal(modelName("claude-fable-5-1"), "Fable 5.1");
    assert.equal(modelName("claude-sonnet-4-6-20260101"), "Sonnet 4.6");
    assert.equal(modelName("claude-opus-5"), "Opus 5");
    assert.equal(modelName("claude-opus-5-5[1m]"), "Opus 5.5");
  });

  it("reads the older naming and the aliases", () => {
    assert.equal(modelName("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
    assert.equal(modelName("haiku"), "Haiku");
  });

  it("leaves anything else as it is", () => {
    assert.equal(modelName("gpt-5-codex"), "gpt-5-codex");
    assert.equal(modelName(undefined), undefined);
    assert.equal(modelName(""), undefined);
  });
});
