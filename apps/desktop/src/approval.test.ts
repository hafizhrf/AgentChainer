import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandRisk, describeRequest, displayPath, insideWorkspace } from "./approval.ts";

const level = (command: string) => commandRisk(command).level;

describe("commandRisk", () => {
  it("rates read-only commands low", () => {
    for (const c of ["ls -la", "cat README.md", "git status", "git log --oneline -5", "rg TODO src", "cd src && ls"]) {
      assert.equal(level(c), "low", c);
    }
  });

  it("rates installs, downloads, project code and file changes medium", () => {
    for (const c of [
      "pnpm add zod",
      "pip install requests",
      "npx create-vite",
      "curl https://example.com",
      "git pull",
      "pnpm test",
      "pnpm lint",
      "npm run build",
      "cargo test",
      "echo hi > notes.txt",
      "mv a.ts b.ts",
      "sed -i s/a/b/ file",
      "git commit -m wip",
      "cat .env",
      "some-unknown-tool --flag",
    ]) {
      assert.equal(level(c), "medium", c);
    }
  });

  it("rates deletes, pushes, history rewrites and uploads high", () => {
    for (const c of [
      "rm -rf build",
      "rm -r dist",
      "find . -name '*.log' -delete",
      "git clean -fdx",
      "git push origin main",
      "git reset --hard HEAD~1",
      "git rebase -i main",
      "chmod -R 777 .",
      "pkill node",
      "curl -X POST https://api.example.com -d @data.json",
      "scp file host:/tmp",
      "rsync -a dist/ host:/srv",
      "npm publish",
    ]) {
      assert.equal(level(c), "high", c);
    }
  });

  it("takes the worst part of a compound command, with that part's reason", () => {
    const risk = commandRisk("pnpm build && git push");
    assert.equal(risk.level, "high");
    assert.deepEqual(risk.reasons, ["Publishes commits to a remote"]);
    assert.equal(level("cat log.txt | grep error"), "low");
    assert.equal(level("ls; rm -rf /tmp/x"), "high");
  });

  it("ignores env assignments and program paths, and reads 2>&1 and /dev/null as harmless", () => {
    assert.equal(level("NODE_ENV=test /usr/bin/rm -rf out"), "high");
    assert.equal(level("ls missing 2>&1"), "low");
    assert.equal(level("cat file > /dev/null"), "low");
  });

  it("names a program it has no rule for", () => {
    assert.match(commandRisk("terraform plan").reasons[0] ?? "", /terraform/);
  });
});

describe("workspace paths", () => {
  it("tells inside from outside, relative and absolute, on both slash styles", () => {
    assert.equal(insideWorkspace("/repo/src/a.ts", "/repo"), true);
    assert.equal(insideWorkspace("src/a.ts", "/repo"), true);
    assert.equal(insideWorkspace("/repo-other/a.ts", "/repo"), false);
    assert.equal(insideWorkspace("../secrets.txt", "/repo"), false);
    assert.equal(insideWorkspace("/etc/hosts", "/repo"), false);
    assert.equal(insideWorkspace("C:\\work\\app\\src\\a.ts", "C:\\work\\app"), true);
    assert.equal(displayPath("/repo/src/a.ts", "/repo"), "src/a.ts");
    assert.equal(displayPath("/etc/hosts", "/repo"), "/etc/hosts");
  });
});

describe("describeRequest", () => {
  it("shows a command with Claude's own explanation", () => {
    const d = describeRequest("Bash", { command: "pnpm test", description: "Run the test suite" }, "/repo");
    assert.equal(d.kind, "command");
    assert.equal(d.kind === "command" && d.explanation, "Run the test suite");
    assert.equal(d.risk.level, "medium");
  });

  it("rates edits by where they land", () => {
    assert.equal(describeRequest("Edit", { file_path: "/repo/src/a.ts" }, "/repo").risk.level, "low");
    assert.equal(describeRequest("Write", { file_path: "/repo/.env" }, "/repo").risk.level, "high");
    assert.equal(
      describeRequest("Write", { file_path: "/repo/.github/workflows/ci.yml" }, "/repo").risk.level,
      "medium",
    );
    const outside = describeRequest("Edit", { file_path: "/Users/me/.zshrc" }, "/repo");
    assert.equal(outside.risk.level, "high");
    assert.equal(outside.kind === "edit" && outside.path, "/Users/me/.zshrc");
  });

  it("covers reads, the web and MCP tools, and anything else", () => {
    assert.equal(describeRequest("Read", { file_path: "/repo/a.ts" }, "/repo").risk.level, "low");
    assert.equal(describeRequest("Read", { file_path: "/etc/hosts" }, "/repo").risk.level, "medium");
    assert.equal(describeRequest("WebFetch", { url: "https://x.dev" }, "/repo").kind, "web");
    const mcp = describeRequest("mcp__context7__get-docs", {}, "/repo");
    assert.equal(mcp.kind === "mcp" && mcp.server, "context7");
    assert.equal(describeRequest("Unknown", {}, "/repo").kind, "other");
  });

  it("raises anything Claude Code flags as risky to high", () => {
    const d = describeRequest("Bash", { command: "ls" }, "/repo", true);
    assert.equal(d.risk.level, "high");
    assert.equal(d.risk.reasons[0], "Claude Code marks this one as risky");
  });
});
