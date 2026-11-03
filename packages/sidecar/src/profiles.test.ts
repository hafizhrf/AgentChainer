import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { agentProblems } from "@agentchainer/protocol";
import { agentTemplates } from "./agent-templates.ts";
import { CHAT_TOOLS, loadProfile, type Profile, profileOptions, profileSummaries } from "./profiles.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "ac-profiles-"));
  dirs.push(d);
  return d;
};
const agentFile = (dir: string, name: string, fields: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\n${fields}\n---\n\nYou are ${name}.\n`);
};

const profile = (tools: string[] | null, model?: string): Profile => ({
  name: "p",
  description: "d",
  scope: "project",
  prompt: "You are p.",
  tools,
  ...(model ? { model } : {}),
});

describe("agent profiles at run time (M8-04)", () => {
  it("finds a profile in the project before the user's, and refuses one with problems", () => {
    const root = tmp();
    const cfg = tmp();
    agentFile(path.join(root, ".claude", "agents"), "explainer", "description: Project one\ntools: Read, Grep");
    agentFile(path.join(cfg, "agents"), "explainer", "description: User one");
    agentFile(path.join(cfg, "agents"), "helper", "description: Helps\nmodel: haiku");
    agentFile(path.join(cfg, "agents"), "broken", "description: Bad\ntools: Read, Teleport");
    assert.deepEqual(loadProfile(root, cfg, "explainer"), {
      name: "explainer",
      description: "Project one",
      scope: "project",
      prompt: "You are explainer.",
      tools: ["Read", "Grep"],
    });
    assert.deepEqual(loadProfile(root, cfg, "helper").model, "haiku");
    assert.equal(loadProfile(root, cfg, "helper").tools, null, "no list: every tool");
    assert.throws(() => loadProfile(root, cfg, "broken"), /needs fixing first: Tools: Teleport/);
    assert.throws(() => loadProfile(root, cfg, "nobody"), /no agent profile named nobody/);
    assert.deepEqual(
      profileSummaries(root, cfg).map((p) => p.name),
      ["explainer", "helper"],
    );
  });

  it("narrows a session to the profile's tools, and blocks MCP unless it names a server", () => {
    assert.deepEqual(profileOptions(profile(["Read", "Bash"], "haiku")), {
      appendSystemPrompt: "You are p.",
      model: "haiku",
      tools: ["Read", "Bash"],
      disallowedTools: ["mcp__*"],
    });
    assert.deepEqual(profileOptions(profile(["Read", "mcp__github__*"])), {
      appendSystemPrompt: "You are p.",
      tools: ["Read"],
    });
    assert.deepEqual(profileOptions(profile(null)), { appendSystemPrompt: "You are p." }, "no list: unchanged");
  });

  it("keeps a chat's question and plan tools, and a Team chat's MCP tools", () => {
    const o = profileOptions(profile(["Read"]), { extraTools: CHAT_TOOLS, keepMcp: true });
    assert.deepEqual(o.tools, ["Read", ...CHAT_TOOLS]);
    assert.equal(o.disallowedTools, undefined);
  });

  it("gives a read-only worker only the profile's read tools, or all of them", () => {
    assert.deepEqual(profileOptions(profile(["Read", "Edit", "Bash"]), { readOnly: true }).tools, ["Read"]);
    assert.deepEqual(profileOptions(profile(["Bash"]), { readOnly: true }).tools, ["Read", "Grep", "Glob"]);
    assert.deepEqual(profileOptions(profile(null), { readOnly: true }).tools, ["Read", "Grep", "Glob"]);
  });
});

describe("agent templates (M8-04)", () => {
  it("offers the 6 shipped roles, then 4 starters, each one saveable as it is", () => {
    const templates = agentTemplates();
    assert.deepEqual(
      templates.map((t) => t.id),
      [
        ...templates.filter((t) => t.source === "role").map((t) => `role:${t.name}`),
        "starter:researcher",
        "starter:test-writer",
        "starter:docs-writer",
        "starter:explainer",
      ],
    );
    assert.equal(templates.filter((t) => t.source === "role").length, 6);
    for (const t of templates) assert.deepEqual(agentProblems(t), [], t.id);
  });
});
