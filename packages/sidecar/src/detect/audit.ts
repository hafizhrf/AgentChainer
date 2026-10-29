import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding, WorkspaceProfile } from "@agentchainer/protocol";
import { git, repoOf } from "../workspace.ts";

/**
 * Setup audit and readiness report (M2-08/M2-09). Every finding short of `ok` names the fix action the bootstrap
 * plan (M2-11) offers for it; there is no score without actions behind it. Reads files and git state only.
 */

/** Fix actions, by id. The bootstrap plan maps each to catalog items or a generator. */
export const FIXES = {
  "generate-claude-md": "Generate CLAUDE.md",
  "update-claude-md": "Update CLAUDE.md",
  "link-agents-md": "Import AGENTS.md from CLAUDE.md",
  "setup-hooks": "Add format/lint hooks",
  "scaffold-tests": "Scaffold tests",
  "add-linter": "Add a linter",
  "add-formatter": "Add a formatter",
  "generate-ci": "Generate a CI workflow",
  "smoke-test": "Add a smoke test",
  "fix-gitignore": "Ignore env and secret files",
  "untrack-env": "Stop tracking .env",
  "git-init": "Initialize git",
  "add-remote": "Add a git remote (manual)",
} as const;
export type FixAction = keyof typeof FIXES;

/** CLAUDE.md files over this many lines cost context in every session. */
const LONG_CLAUDE_MD = 300;

type Check = Omit<Finding, "fix"> & { fix?: FixAction };

export function auditWorkspace(root: string, profile: WorkspaceProfile): Finding[] {
  const read = (rel: string) => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const exists = (rel: string) => existsSync(path.join(root, rel));
  const list = (rel: string) => {
    try {
      return readdirSync(path.join(root, rel));
    } catch {
      return [];
    }
  };
  const checks: Check[] = [];
  const commands = profile.packages.map((p) => p.commands);
  const firstRun = (kind: "test" | "lint" | "format") => commands.find((c) => c[kind])?.[kind]?.run;

  // Agent context.
  const claudeMdPath = ["CLAUDE.md", ".claude/CLAUDE.md"].find(exists);
  const claudeMd = claudeMdPath ? (read(claudeMdPath) ?? "") : null;
  const agentsMd = exists("AGENTS.md");
  if (claudeMd === null) {
    checks.push({
      id: "claude-md.missing",
      area: "agent",
      status: "missing",
      title: "No CLAUDE.md",
      detail: "Claude starts every session without your commands, architecture or conventions.",
      fix: "generate-claude-md",
    });
  } else {
    const lines = claudeMd.split("\n").length;
    const testRun = firstRun("test");
    const problems = [
      lines > LONG_CLAUDE_MD
        ? `${lines} lines long (it's loaded into every session; aim for under ${LONG_CLAUDE_MD})`
        : null,
      testRun && !claudeMd.includes(testRun) ? `doesn't mention the test command (\`${testRun}\`)` : null,
    ].filter((p): p is string => p !== null);
    checks.push(
      problems.length
        ? {
            id: "claude-md.stale",
            area: "agent",
            status: "warn",
            title: `${claudeMdPath} needs attention`,
            detail: `It ${problems.join(" and ")}.`,
            fix: "update-claude-md",
          }
        : {
            id: "claude-md.ok",
            area: "agent",
            status: "ok",
            title: `${claudeMdPath} present`,
            detail: `${lines} lines.`,
          },
    );
  }
  if (agentsMd && claudeMd !== null && !claudeMd.includes("AGENTS.md")) {
    checks.push({
      id: "agents-md.unlinked",
      area: "agent",
      status: "warn",
      title: "AGENTS.md isn't imported by CLAUDE.md",
      detail: "Claude Code reads CLAUDE.md, not AGENTS.md; the two can drift apart.",
      fix: "link-agents-md",
    });
  }

  const settings = parseJson(read(".claude/settings.json"));
  const hooks = (settings?.hooks ?? {}) as Record<string, unknown>;
  checks.push(
    hooks.PostToolUse
      ? {
          id: "hooks.ok",
          area: "agent",
          status: "ok",
          title: "Edit hooks configured",
          detail: "`.claude/settings.json` has PostToolUse hooks.",
        }
      : {
          id: "hooks.missing",
          area: "agent",
          status: "missing",
          title: "No format/lint hook on edits",
          detail: "Claude's edits aren't formatted or linted until someone runs the tools by hand.",
          fix: "setup-hooks",
        },
  );
  const skills = list(".claude/skills").filter((d) => exists(`.claude/skills/${d}/SKILL.md`));
  const agents = list(".claude/agents").filter((a) => a.endsWith(".md"));
  const mcp = parseJson(read(".mcp.json"));
  const mcpServers = Object.keys((mcp?.mcpServers ?? {}) as object);
  checks.push({
    id: "claude-dir.inventory",
    area: "agent",
    status: "info",
    title: "Project skills, agents and MCP servers",
    detail: `${skills.length} skill(s), ${agents.length} agent(s), ${mcpServers.length} MCP server(s)${
      mcpServers.length ? ` (${mcpServers.join(", ")})` : ""
    }${exists(".mcp.json") && !mcp ? "; .mcp.json isn't valid JSON" : ""}.`,
  });

  // Project quality.
  const testRun = firstRun("test");
  checks.push(
    testRun
      ? { id: "tests.ok", area: "quality", status: "ok", title: "Test command found", detail: `\`${testRun}\`` }
      : {
          id: "tests.missing",
          area: "quality",
          status: "missing",
          title: "No test command",
          detail: "Neither you nor Claude can check a change by running tests.",
          fix: "scaffold-tests",
        },
  );
  const lintRun = firstRun("lint");
  checks.push(
    lintRun
      ? { id: "lint.ok", area: "quality", status: "ok", title: "Lint command found", detail: `\`${lintRun}\`` }
      : {
          id: "lint.missing",
          area: "quality",
          status: "warn",
          title: "No linter",
          detail: "Common mistakes in Claude's edits won't be caught automatically.",
          fix: "add-linter",
        },
  );
  const formatRun = firstRun("format");
  checks.push(
    formatRun
      ? { id: "format.ok", area: "quality", status: "ok", title: "Format command found", detail: `\`${formatRun}\`` }
      : {
          id: "format.missing",
          area: "quality",
          status: "warn",
          title: "No formatter",
          detail: "Edits keep whatever style they were written in, which makes diffs noisy.",
          fix: "add-formatter",
        },
  );
  checks.push(
    profile.ci.length
      ? { id: "ci.ok", area: "quality", status: "ok", title: "CI configured", detail: profile.ci.join(", ") }
      : {
          id: "ci.missing",
          area: "quality",
          status: "missing",
          title: "No CI",
          detail: "Nothing checks a change once it leaves your machine.",
          fix: "generate-ci",
        },
  );
  const smoke = list("scripts").find((n) => /^smoke([-_.][\w.-]*)?\.(sh|ps1|mjs|js|ts|py)$/.test(n));
  checks.push(
    smoke
      ? { id: "smoke.ok", area: "quality", status: "ok", title: "Smoke test present", detail: `scripts/${smoke}` }
      : {
          id: "smoke.missing",
          area: "quality",
          status: "missing",
          title: "No smoke test",
          detail: "There's no quick check that the app still starts after a change.",
          fix: "smoke-test",
        },
  );

  // Hygiene and git.
  const repo = repoOf(root);
  if (!repo) {
    checks.push({
      id: "git.missing",
      area: "git",
      status: "missing",
      title: "Not a git repository",
      detail: "Changes can't be reviewed, reverted or rewound safely.",
      fix: "git-init",
    });
  } else {
    // `--no-index` checks the patterns even when no .env file exists yet.
    const envIgnored = git(["check-ignore", "-q", "--no-index", ".env"], root).status === 0;
    const trackedEnv = git(["ls-files", "--", ".env", "*.env", ".env.*"], root)
      .stdout.split("\n")
      .filter((f) => f && !/\.(example|sample|template)$/.test(f));
    if (trackedEnv.length) {
      checks.push({
        id: "env.tracked",
        area: "hygiene",
        status: "warn",
        title: `${trackedEnv.join(", ")} is committed`,
        detail: "Env files often hold secrets; anything committed stays in the history.",
        fix: "untrack-env",
      });
    }
    checks.push(
      envIgnored
        ? {
            id: "gitignore.ok",
            area: "hygiene",
            status: "ok",
            title: ".env is ignored",
            detail: ".gitignore covers env files.",
          }
        : {
            id: "gitignore.env",
            area: "hygiene",
            status: "missing",
            title: ".env isn't ignored",
            detail: "A secret dropped into .env would be committed with the next `git add .`.",
            fix: "fix-gitignore",
          },
    );
    const remotes = git(["remote"], root).stdout.trim();
    checks.push(
      remotes
        ? {
            id: "remote.ok",
            area: "git",
            status: "ok",
            title: "Git remote set",
            detail: remotes.split("\n").join(", "),
          }
        : {
            id: "remote.missing",
            area: "git",
            status: "info",
            title: "No git remote",
            detail: "Pushing, pull requests and hosted CI need one.",
            fix: "add-remote",
          },
    );
  }
  return checks.map(({ fix, ...c }) => (fix ? { ...c, fix: { action: fix, label: FIXES[fix] } } : c));
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Saves the profile to `.agentchainer/profile.json` (M2-10). It is derived data, so `.agentchainer/.gitignore`
 * keeps it out of git; the bootstrap lockfile that lands next to it later is meant to be committed.
 */
export function saveProfile(root: string, profile: WorkspaceProfile): string {
  const dir = path.join(root, ".agentchainer");
  mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  const current = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!current.split("\n").includes("profile.json")) {
    writeFileSync(ignore, `${current}${current && !current.endsWith("\n") ? "\n" : ""}profile.json\n`);
  }
  const file = path.join(dir, "profile.json");
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  return file;
}
