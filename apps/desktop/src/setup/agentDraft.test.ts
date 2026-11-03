import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentDefinition, AgentTemplate } from "@agentchainer/protocol";
import {
  blankDraft,
  cloneDraft,
  draftOf,
  draftProblems,
  freeName,
  inputOf,
  otherTools,
  templateDraft,
  toggleTool,
  withOtherTools,
} from "./agentDraft.ts";

const agent: AgentDefinition = {
  name: "reviewer",
  scope: "user",
  file: "~/.claude/agents/reviewer.md",
  description: "Reviews",
  tools: "Read, Grep",
  model: "haiku",
  prompt: "You review.",
  auto: false,
  role: false,
};

describe("the agent form (M8-04)", () => {
  it("clones under a free name in the same scope, as a new agent", () => {
    assert.equal(freeName("reviewer", []), "reviewer-copy");
    assert.equal(freeName("reviewer", ["reviewer-copy", "reviewer-copy-2"]), "reviewer-copy-3");
    const d = cloneDraft(agent, ["reviewer", "reviewer-copy"]);
    assert.deepEqual(
      [d.name, d.scope, d.previous, d.limited, d.tools],
      ["reviewer-copy-2", "user", undefined, true, "Read, Grep"],
    );
  });

  it("starts from a template: a role's copy never takes the role's name, a starter keeps its own", () => {
    const role: AgentTemplate = {
      id: "role:ac-architect",
      source: "role",
      name: "ac-architect",
      description: "Plans",
      tools: "Read, Grep, Glob",
      model: "opus",
      prompt: "Plan.",
    };
    const starter: AgentTemplate = {
      id: "starter:explainer",
      source: "starter",
      name: "explainer",
      description: "Explains",
      prompt: "Explain.",
    };
    assert.equal(templateDraft(role, "project", []).name, "ac-architect-copy");
    assert.deepEqual(templateDraft(starter, "user", []), {
      ...blankDraft("user"),
      name: "explainer",
      description: "Explains",
      prompt: "Explain.",
    });
    assert.equal(templateDraft(starter, "project", ["explainer"]).name, "explainer-copy");
  });

  it("saves tools only when limited, and flags a limited list with nothing ticked", () => {
    const d = draftOf({ ...agent, scope: "project" });
    assert.equal(inputOf(d).tools, "Read, Grep");
    assert.equal(inputOf({ ...d, limited: false }).tools, undefined, "all tools: no list");
    assert.deepEqual(draftProblems(d, []), []);
    assert.deepEqual(draftProblems({ ...d, tools: "" }, []), ["Tools: pick at least one, or allow all tools."]);
    assert.match(draftProblems({ ...d, tools: "Read, Fly" }, []).join(), /Fly isn't a known tool/);
    assert.match(draftProblems(d, ["reviewer"]).join(), /already exists/);
  });

  it("ticks tools in the picker's order and keeps MCP entries after them", () => {
    let tools = toggleTool("mcp__github__*", "Bash", true);
    tools = toggleTool(tools, "Read", true);
    assert.equal(tools, "Read, Bash, mcp__github__*");
    assert.equal(toggleTool(tools, "Read", false), "Bash, mcp__github__*");
    assert.equal(otherTools(tools), "mcp__github__*");
    assert.equal(withOtherTools(tools, "mcp__db, mcp__fs__read"), "Read, Bash, mcp__db, mcp__fs__read");
  });
});
