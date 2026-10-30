import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fenceLanguage, type LanguageInfo } from "./monaco-lang.ts";

const languages: LanguageInfo[] = [
  { id: "typescript", aliases: ["TypeScript", "ts"], extensions: [".ts", ".tsx"] },
  { id: "shell", aliases: ["Shell", "sh"], extensions: [".sh", ".bash"] },
  { id: "python", aliases: ["Python", "py"], extensions: [".py"] },
  { id: "yaml", aliases: ["YAML"], extensions: [".yaml", ".yml"] },
  { id: "go", aliases: ["Go"], extensions: [".go"] },
  { id: "ini", extensions: [".ini"] },
];

describe("fenceLanguage", () => {
  it("maps the fence names models write to Monaco's ids", () => {
    assert.equal(fenceLanguage("ts", languages), "typescript");
    assert.equal(fenceLanguage("tsx", languages), "typescript");
    assert.equal(fenceLanguage("bash", languages), "shell");
    assert.equal(fenceLanguage("console", languages), "shell");
    assert.equal(fenceLanguage("yml", languages), "yaml");
    assert.equal(fenceLanguage("toml", languages), "ini");
  });

  it("finds ids, aliases and extensions, ignoring case and extra info", () => {
    assert.equal(fenceLanguage("Go", languages), "go");
    assert.equal(fenceLanguage("Python", languages), "python");
    assert.equal(fenceLanguage("python title=main.py", languages), "python");
  });

  it("falls back to plain text", () => {
    assert.equal(fenceLanguage("", languages), "plaintext");
    assert.equal(fenceLanguage("brainfuck", languages), "plaintext");
    assert.equal(fenceLanguage("jsx", languages), "plaintext", "an alias whose target Monaco lacks");
  });
});
