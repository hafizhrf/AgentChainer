import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Finding, WorkspaceProfile } from "@agentchainer/protocol";
import { AC_DIR, ensureIgnored } from "../ac-dir.ts";
import { LONG_CLAUDE_MD, lineCount } from "../claude-md-rules.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { git, repoOf } from "../workspace.ts";
import { readWorkspaceText } from "../workspace-files.ts";

/**
 * Setup audit and readiness report (M2-08/M2-09). Every finding short of `ok` names the fix action the bootstrap
 * plan (M2-11) offers for it; there is no score without actions behind it. Reads files and git state only.
 */

/** Fix actions, by id, with the keys of their labels. The bootstrap plan maps each to catalog items or a generator. */
export const FIXES = {
  "generate-claude-md": "detect.audit.fixGenerateClaudeMd",
  "update-claude-md": "detect.audit.fixUpdateClaudeMd",
  "link-agents-md": "detect.audit.fixLinkAgentsMd",
  "setup-hooks": "detect.audit.fixSetupHooks",
  "scaffold-tests": "detect.audit.fixScaffoldTests",
  "add-linter": "detect.audit.fixAddLinter",
  "add-formatter": "detect.audit.fixAddFormatter",
  "generate-ci": "detect.audit.fixGenerateCi",
  "smoke-test": "detect.audit.fixSmokeTest",
  "stop-tests": "detect.audit.fixStopTests",
  "fix-gitignore": "detect.audit.fixGitignore",
  "untrack-env": "detect.audit.fixUntrackEnv",
  "git-init": "detect.audit.fixGitInit",
  "add-remote": "detect.audit.fixAddRemote",
} as const satisfies Record<string, MessageKey>;
export type FixAction = keyof typeof FIXES;

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
  // Not through a link: a cloned repository can point CLAUDE.md anywhere (T-03).
  const claudeMd = claudeMdPath ? readWorkspaceText(root, claudeMdPath) : null;
  const agentsMd = exists("AGENTS.md");
  if (claudeMd === null) {
    checks.push({
      id: "claude-md.missing",
      area: "agent",
      status: "missing",
      title: t("detect.audit.claudeMdMissingTitle"),
      detail: t("detect.audit.claudeMdMissingDetail"),
      fix: "generate-claude-md",
    });
  } else {
    const lines = lineCount(claudeMd);
    const testRun = firstRun("test");
    const long = lines > LONG_CLAUDE_MD;
    const noTest = testRun !== undefined && !claudeMd.includes(testRun);
    const values = { lines, max: LONG_CLAUDE_MD, command: testRun ?? "" };
    const problem = long
      ? noTest
        ? t("detect.audit.claudeMdLongNoTest", values)
        : t("detect.audit.claudeMdLong", values)
      : noTest
        ? t("detect.audit.claudeMdNoTest", values)
        : null;
    const file = { path: claudeMdPath ?? "" };
    checks.push(
      problem
        ? {
            id: "claude-md.stale",
            area: "agent",
            status: "warn",
            title: t("detect.audit.claudeMdStaleTitle", file),
            detail: problem,
            fix: "update-claude-md",
          }
        : {
            id: "claude-md.ok",
            area: "agent",
            status: "ok",
            title: t("detect.audit.claudeMdOkTitle", file),
            detail: t("detect.audit.claudeMdOkDetail", { lines }),
          },
    );
  }
  if (agentsMd && claudeMd !== null && !claudeMd.includes("AGENTS.md")) {
    checks.push({
      id: "agents-md.unlinked",
      area: "agent",
      status: "warn",
      title: t("detect.audit.agentsMdUnlinkedTitle"),
      detail: t("detect.audit.agentsMdUnlinkedDetail"),
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
          title: t("detect.audit.hooksOkTitle"),
          detail: t("detect.audit.hooksOkDetail"),
        }
      : {
          id: "hooks.missing",
          area: "agent",
          status: "missing",
          title: t("detect.audit.hooksMissingTitle"),
          detail: t("detect.audit.hooksMissingDetail"),
          fix: "setup-hooks",
        },
  );
  // Optional (M2-22): with a test command, Claude can be made to run the tests before it stops.
  const testCommand = firstRun("test");
  if (testCommand && !hooks.Stop) {
    checks.push({
      id: "stop-hook.missing",
      area: "agent",
      status: "info",
      title: t("detect.audit.stopHookMissingTitle"),
      detail: t("detect.audit.stopHookMissingDetail", { command: testCommand }),
      fix: "stop-tests",
    });
  }
  const skills = list(".claude/skills").filter((d) => exists(`.claude/skills/${d}/SKILL.md`));
  const agents = list(".claude/agents").filter((a) => a.endsWith(".md"));
  const mcp = parseJson(read(".mcp.json"));
  const mcpServers = Object.keys((mcp?.mcpServers ?? {}) as object);
  // An unreadable .mcp.json lists no servers, so it never has names to show.
  const counts = { skills: skills.length, agents: agents.length, servers: mcpServers.length };
  checks.push({
    id: "claude-dir.inventory",
    area: "agent",
    status: "info",
    title: t("detect.audit.inventoryTitle"),
    detail:
      exists(".mcp.json") && !mcp
        ? t("detect.audit.inventoryDetailBadMcp", counts)
        : mcpServers.length
          ? t("detect.audit.inventoryDetailNamed", { ...counts, names: mcpServers.join(", ") })
          : t("detect.audit.inventoryDetail", counts),
  });

  // Project quality.
  const testRun = firstRun("test");
  checks.push(
    testRun
      ? {
          id: "tests.ok",
          area: "quality",
          status: "ok",
          title: t("detect.audit.testsOkTitle"),
          detail: `\`${testRun}\``,
        }
      : {
          id: "tests.missing",
          area: "quality",
          status: "missing",
          title: t("detect.audit.testsMissingTitle"),
          detail: t("detect.audit.testsMissingDetail"),
          fix: "scaffold-tests",
        },
  );
  const lintRun = firstRun("lint");
  checks.push(
    lintRun
      ? { id: "lint.ok", area: "quality", status: "ok", title: t("detect.audit.lintOkTitle"), detail: `\`${lintRun}\`` }
      : {
          id: "lint.missing",
          area: "quality",
          status: "warn",
          title: t("detect.audit.lintMissingTitle"),
          detail: t("detect.audit.lintMissingDetail"),
          fix: "add-linter",
        },
  );
  const formatRun = firstRun("format");
  checks.push(
    formatRun
      ? {
          id: "format.ok",
          area: "quality",
          status: "ok",
          title: t("detect.audit.formatOkTitle"),
          detail: `\`${formatRun}\``,
        }
      : {
          id: "format.missing",
          area: "quality",
          status: "warn",
          title: t("detect.audit.formatMissingTitle"),
          detail: t("detect.audit.formatMissingDetail"),
          fix: "add-formatter",
        },
  );
  checks.push(
    profile.ci.length
      ? {
          id: "ci.ok",
          area: "quality",
          status: "ok",
          title: t("detect.audit.ciOkTitle"),
          detail: profile.ci.join(", "),
        }
      : {
          id: "ci.missing",
          area: "quality",
          status: "missing",
          title: t("detect.audit.ciMissingTitle"),
          detail: t("detect.audit.ciMissingDetail"),
          fix: "generate-ci",
        },
  );
  const smoke = list("scripts").find((n) => /^smoke([-_.][\w.-]*)?\.(sh|ps1|mjs|js|ts|py)$/.test(n));
  checks.push(
    smoke
      ? {
          id: "smoke.ok",
          area: "quality",
          status: "ok",
          title: t("detect.audit.smokeOkTitle"),
          detail: `scripts/${smoke}`,
        }
      : {
          id: "smoke.missing",
          area: "quality",
          status: "missing",
          title: t("detect.audit.smokeMissingTitle"),
          detail: t("detect.audit.smokeMissingDetail"),
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
      title: t("detect.audit.gitMissingTitle"),
      detail: t("detect.audit.gitMissingDetail"),
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
        title: t("detect.audit.envTrackedTitle", { files: trackedEnv.join(", ") }),
        detail: t("detect.audit.envTrackedDetail"),
        fix: "untrack-env",
      });
    }
    checks.push(
      envIgnored
        ? {
            id: "gitignore.ok",
            area: "hygiene",
            status: "ok",
            title: t("detect.audit.gitignoreOkTitle"),
            detail: t("detect.audit.gitignoreOkDetail"),
          }
        : {
            id: "gitignore.env",
            area: "hygiene",
            status: "missing",
            title: t("detect.audit.gitignoreEnvTitle"),
            detail: t("detect.audit.gitignoreEnvDetail"),
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
            title: t("detect.audit.remoteOkTitle"),
            detail: remotes.split("\n").join(", "),
          }
        : {
            id: "remote.missing",
            area: "git",
            status: "info",
            title: t("detect.audit.remoteMissingTitle"),
            detail: t("detect.audit.remoteMissingDetail"),
            fix: "add-remote",
          },
    );
  }
  return checks.map(({ fix, ...c }) => (fix ? { ...c, fix: { action: fix, label: t(FIXES[fix]) } } : c));
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
  ensureIgnored(root, "profile.json");
  const file = path.join(root, AC_DIR, "profile.json");
  writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`);
  return file;
}
