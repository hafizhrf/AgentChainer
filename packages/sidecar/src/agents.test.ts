import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { isAutoAgent as isAuto, withAutoWording as withAuto } from "@agentchainer/protocol";
import { deleteAgent, listAgents, renderAgent, saveAgent } from "./agents.ts";
import { listRuns, rollback } from "./bootstrap/apply.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ac-agents-"));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text: string) => {
  const file = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (root: string, rel: string) => readFileSync(path.join(root, ...rel.split("/")), "utf8");
/** A config folder no test writes to: project saves never touch it. */
const CFG = path.join(tmpdir(), "ac-agents-unused-config");

const reviewer = [
  "---",
  "name: reviewer",
  "description: Reviews diffs. Use proactively after edits.",
  "tools: Read, Grep",
  "color: blue",
  "---",
  "",
  "You review code.",
  "",
].join("\n");

describe("the agent library (M4-06)", () => {
  it("lists the project's agents, then the user's, marking task roles and unreadable files", () => {
    const root = tmp();
    const config = tmp();
    put(root, ".claude/agents/reviewer.md", reviewer);
    put(root, ".claude/agents/ac-implementer.md", "---\nname: ac-implementer\ndescription: Implements.\n---\nGo.\n");
    put(root, ".claude/agents/broken.md", "no front matter");
    put(config, "agents/mine.md", "---\nname: mine\ndescription: Mine.\nmodel: haiku\n---\nHi.\n");
    const agents = listAgents(root, config);
    assert.deepEqual(
      agents.map((a) => [a.name, a.scope, a.file, a.auto, a.role, a.error !== undefined]),
      [
        ["ac-implementer", "project", ".claude/agents/ac-implementer.md", false, true, false],
        ["broken", "project", ".claude/agents/broken.md", false, false, true],
        ["reviewer", "project", ".claude/agents/reviewer.md", true, false, false],
        ["mine", "user", "~/.claude/agents/mine.md", false, false, false],
      ],
    );
    const r = agents.find((a) => a.name === "reviewer");
    assert.deepEqual([r?.tools, r?.prompt], ["Read, Grep", "You review code."]);
  });

  it("switches between manual and auto by rewriting the description's wording", () => {
    assert.equal(withAuto("Reviews diffs", true), "Reviews diffs. Use proactively.");
    assert.equal(withAuto("Reviews diffs. Use proactively after edits.", false), "Reviews diffs.");
    assert.equal(withAuto("MUST BE USED for every migration.", false), "for every migration.");
    assert.equal(withAuto("Reviews diffs.", false), "Reviews diffs.", "already manual: unchanged");
    assert.ok(isAuto(withAuto("x", true)));
  });

  it("writes YAML that keeps fields the form doesn't show, and quotes what needs it", () => {
    const text = renderAgent(
      { name: "reviewer", description: "Reviews: diffs", prompt: "Hi", auto: false, model: "haiku" },
      { name: "old", color: "blue", description: "old" },
    );
    assert.equal(text, '---\nname: reviewer\ndescription: "Reviews: diffs"\nmodel: haiku\ncolor: blue\n---\n\nHi\n');
  });

  it("creates, renames and deletes project agents as runs that History can roll back", () => {
    const root = tmp();
    const input = { name: "planner", description: "Plans work", prompt: "You plan.", auto: true };
    // Runs are listed by time, so each change gets its own.
    const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 9, 0, s));
    const created = saveAgent(root, CFG, input, "v1", undefined, at(1)) ?? "";
    assert.match(read(root, ".claude/agents/planner.md"), /description: Plans work\. Use proactively\./);
    assert.throws(() => saveAgent(root, CFG, input, "v1"), /already exists/);

    const renamed = saveAgent(root, CFG, { ...input, name: "architect", auto: false }, "v1", "planner", at(2)) ?? "";
    assert.equal(existsSync(path.join(root, ".claude/agents/planner.md")), false);
    assert.match(read(root, ".claude/agents/architect.md"), /description: Plans work\n/);

    const deleted = deleteAgent(root, CFG, "architect", "project", "v1", at(3)) ?? "";
    assert.equal(existsSync(path.join(root, ".claude/agents/architect.md")), false);
    assert.deepEqual(
      listRuns(root).map((r) => r.actions.map((a) => a.title)),
      [["Delete agent architect"], ["Rename agent architect"], ["Create agent planner"]],
    );
    assert.match(read(root, ".agentchainer/.gitignore"), /backups\//);

    // Undo the delete and the rename: the agent is back as it was created.
    rollback(root, deleted, { cli: null });
    rollback(root, renamed, { cli: null });
    assert.equal(existsSync(path.join(root, ".claude/agents/architect.md")), false);
    assert.match(read(root, ".claude/agents/planner.md"), /Use proactively/);
    assert.deepEqual(
      listRuns(root).map((r) => r.runId),
      [created],
    );
  });

  it("refuses to rename onto an existing agent or edit a missing one", () => {
    const root = tmp();
    put(root, ".claude/agents/reviewer.md", reviewer);
    const input = { name: "reviewer", description: "D", prompt: "P", auto: false };
    saveAgent(root, CFG, { ...input, name: "other" }, "v1");
    assert.throws(() => saveAgent(root, CFG, input, "v1", "other"), /already exists/);
    assert.throws(
      () => saveAgent(root, CFG, { ...input, name: "x" }, "v1", "missing"),
      /no project agent named missing/,
    );
    assert.throws(() => deleteAgent(root, CFG, "missing", "project", "v1"), /no project agent named missing/);
  });
});

describe("agent profiles (M8-04)", () => {
  const input = { name: "explainer", description: "Explains code", prompt: "You explain.", auto: false };

  it("saves, renames and deletes a user agent in the CLI's config folder, with no run", () => {
    const root = tmp();
    const cfg = tmp();
    assert.equal(saveAgent(root, cfg, { ...input, scope: "user", tools: "Read, Grep" }, "v1"), undefined);
    assert.match(read(cfg, "agents/explainer.md"), /tools: Read, Grep/);
    assert.throws(() => saveAgent(root, cfg, { ...input, scope: "user" }, "v1"), /already exists/);
    saveAgent(root, cfg, { ...input, name: "guide", scope: "user" }, "v1", "explainer");
    assert.equal(existsSync(path.join(cfg, "agents", "explainer.md")), false);
    const listed = listAgents(root, cfg).find((a) => a.name === "guide");
    assert.equal(listed?.scope, "user");
    assert.equal(deleteAgent(root, cfg, "guide", "user", "v1"), undefined);
    assert.equal(existsSync(path.join(cfg, "agents", "guide.md")), false);
    assert.throws(() => deleteAgent(root, cfg, "guide", "user", "v1"), /no user agent named guide/);
    assert.deepEqual(listRuns(root), [], "nothing in the workspace's History");
  });

  it("refuses an agent with problems, in either scope, before writing anything", () => {
    const root = tmp();
    const cfg = tmp();
    assert.throws(
      () => saveAgent(root, cfg, { ...input, tools: "Read, Teleport", model: "gpt-4" }, "v1"),
      /Model: gpt-4 isn't .*Tools: Teleport isn't a known tool/,
    );
    assert.throws(() => saveAgent(root, cfg, { ...input, scope: "user", tools: "Read, Read" }, "v1"), /listed twice/);
    assert.equal(existsSync(path.join(root, ".claude")), false);
    assert.equal(existsSync(path.join(cfg, "agents")), false);
  });
});
