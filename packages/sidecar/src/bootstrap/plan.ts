import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BootstrapPlan, Finding, PlanAction, WorkspaceProfile } from "@agentchainer/protocol";
import { type Catalog, type Item, type Profile, REQUIRED_REVIEWS } from "../catalog/schema.ts";
import { git, repoOf } from "../workspace.ts";

/**
 * The BootstrapPlan builder (M2-11): workspace profile + audit findings + catalog → actions, each with why, risk,
 * scope and a preview. Read-only; applying comes with the installers (M2-13…M2-17).
 */

/** What the plan needs to know about the machine and repo beyond the profile; faked in tests. */
export type PlanEnv = {
  platform: NodeJS.Platform;
  /** Whether a command is on PATH. */
  hasTool: (name: string) => boolean;
  /** Host of the `origin` remote, e.g. "github.com". */
  remoteHost: string | null;
  /** `plugin@marketplace` ids enabled in the project's `.claude/settings.json`. */
  enabledPlugins: Set<string>;
};

/** The block "Ignore env and secret files" appends to .gitignore. */
export const GITIGNORE_ENV_BLOCK = "\n# Env files can hold secrets (keep examples)\n.env\n.env.*\n!.env.example\n";

const GENERATORS: Record<string, { title: string; why: string }> = {
  "generate-claude-md": {
    title: "Generate CLAUDE.md",
    why: "Gives Claude your real commands, an architecture map and conventions at the start of every session.",
  },
  "update-claude-md": {
    title: "Update CLAUDE.md",
    why: "Brings CLAUDE.md back in line with the commands the project actually uses, and keeps it short.",
  },
  "setup-hooks": {
    title: "Add format and lint hooks",
    why: "Formats and lints every file Claude edits, so mistakes surface while Claude can still fix them.",
  },
  "scaffold-tests": {
    title: "Scaffold tests",
    why: "Adds a test runner and one example test, so changes can be checked by running them.",
  },
  "add-linter": { title: "Add a linter", why: "Catches common mistakes in Claude's edits automatically." },
  "add-formatter": { title: "Add a formatter", why: "Keeps edits in one style, so diffs show only real changes." },
  "generate-ci": {
    title: "Generate a CI workflow",
    why: "Checks every change on GitHub Actions: install, lint, typecheck, test, build.",
  },
  "smoke-test": { title: "Add a smoke test", why: "A quick check that the app still starts after a change." },
};

export function buildPlan(
  root: string,
  profile: WorkspaceProfile,
  findings: Finding[],
  catalog: Catalog,
  env: PlanEnv,
  optIn: string[] = [],
): BootstrapPlan {
  const fixes = new Set(findings.filter((f) => f.status !== "ok" && f.fix).map((f) => f.fix?.action ?? ""));
  const actions: PlanAction[] = [...fixActions(root, fixes)];

  const suggested = (p: Profile) =>
    "always" in p.suggest ||
    ("stacks" in p.suggest && p.suggest.stacks.some((s) => profile.stacks.includes(s))) ||
    ("remoteHost" in p.suggest && p.suggest.remoteHost === env.remoteHost);
  const seen = new Set<string>();
  // Suggested profiles first, then the ones the user opted into.
  const ordered = [...catalog.profiles.filter(suggested), ...catalog.profiles.filter((p) => !suggested(p))];
  for (const p of ordered) {
    const on = suggested(p);
    if (!on && !optIn.includes(p.id)) continue;
    for (const id of p.items) {
      const item = catalog.items.find((i) => i.id === id);
      if (!item || seen.has(id)) continue;
      seen.add(id);
      actions.push(itemAction(item, p, on, env));
    }
  }

  for (const [action, gen] of Object.entries(GENERATORS)) {
    if (!fixes.has(action)) continue;
    actions.push({
      id: `gen:${action}`,
      kind: "generator",
      title: gen.title,
      why: gen.why,
      risk: "medium",
      scope: "project",
      permissions: ["Runs a Claude session restricted to this workspace; its changes come back as a diff to review"],
      secrets: [],
      preview: { type: "note", text: "A diff to review is produced when the generator runs." },
      state: "unavailable",
      selected: false,
      reason: "Agent-driven generators arrive with M2-19…M2-26.",
    });
  }

  return {
    catalogVersion: catalog.version,
    profiles: catalog.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      suggested: suggested(p),
    })),
    actions,
  };
}

/** Deterministic fixes: file edits and git commands whose full effect the preview shows. */
function fixActions(root: string, fixes: Set<string>): PlanAction[] {
  const read = (rel: string) => {
    const file = path.join(root, rel);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const base = { kind: "fix" as const, risk: "low" as const, scope: "project" as const, permissions: [], secrets: [] };
  const actions: PlanAction[] = [];
  if (fixes.has("git-init")) {
    actions.push({
      ...base,
      id: "fix:git-init",
      title: "Initialize git",
      why: "Every later change can then be reviewed, reverted and rewound.",
      preview: { type: "commands", commands: [["git", "init"]] },
      state: "recommended",
      selected: true,
    });
  }
  if (fixes.has("untrack-env")) {
    const tracked = git(["ls-files", "--", ".env", "*.env", ".env.*"], root)
      .stdout.split("\n")
      .filter((f) => f && !/\.(example|sample|template)$/.test(f));
    actions.push({
      ...base,
      id: "fix:untrack-env",
      title: "Stop tracking env files",
      why: "Keeps the files on disk but out of future commits. They stay in past commits: rotate any secret they held.",
      preview: { type: "commands", commands: [["git", "rm", "--cached", "--", ...tracked]] },
      state: "recommended",
      selected: true,
    });
  }
  if (fixes.has("fix-gitignore")) {
    const before = read(".gitignore");
    actions.push({
      ...base,
      id: "fix:fix-gitignore",
      title: "Ignore env and secret files",
      why: "A secret dropped into .env won't be committed by the next `git add .`.",
      preview: {
        type: "diff",
        path: ".gitignore",
        before,
        after: `${before.replace(/\n*$/, before ? "\n" : "")}${GITIGNORE_ENV_BLOCK.trimStart()}`,
      },
      state: "recommended",
      selected: true,
    });
  }
  if (fixes.has("link-agents-md")) {
    const file = existsSync(path.join(root, "CLAUDE.md")) ? "CLAUDE.md" : ".claude/CLAUDE.md";
    const before = read(file);
    actions.push({
      ...base,
      id: "fix:link-agents-md",
      title: "Import AGENTS.md from CLAUDE.md",
      why: "Claude Code reads CLAUDE.md; importing AGENTS.md keeps one source of instructions for every agent.",
      preview: { type: "diff", path: file, before, after: `@AGENTS.md\n\n${before}` },
      state: "recommended",
      selected: true,
    });
  }
  return actions;
}

function itemAction(item: Item, p: Profile, suggestedProfile: boolean, env: PlanEnv): PlanAction {
  const src = item.source;
  const pluginId = src.type === "marketplace" ? `${src.plugin}@${src.marketplace}` : null;
  const missing = item.requires.filter((r) => !env.hasTool(r.tool));
  const reviews = item.reviews.length;
  const needed = REQUIRED_REVIEWS[item.tier];
  let state: PlanAction["state"] = suggestedProfile ? "recommended" : "optional";
  let reason: string | undefined;
  if (pluginId && env.enabledPlugins.has(pluginId)) {
    state = "installed";
  } else if (!item.platforms.includes(env.platform as never)) {
    state = "unavailable";
    reason = `Not available on ${env.platform}.`;
  } else if (reviews < needed) {
    state = "unavailable";
    reason = `Not reviewed yet: needs ${needed - reviews} more maintainer review(s) against docs/CATALOG.md §4.`;
  } else if (missing.length) {
    state = "unavailable";
    reason = missing.map((r) => `Needs \`${r.tool}\` on PATH (${r.hint}).`).join(" ");
  }
  const commands = item.install.steps.flatMap((s) => ("run" in s ? [s.run] : []));
  const source =
    src.type === "marketplace"
      ? `${pluginId}${src.reviewedVersion ? `, reviewed v${src.reviewedVersion}` : ""} at ${src.reviewedRef.slice(0, 7)}`
      : src.type === "git"
        ? `${src.repo} at ${src.ref.slice(0, 7)}`
        : src.type === "release-asset" || src.type === "npm"
          ? `${"name" in src ? src.name : src.repo} ${src.version}`
          : "this repository";
  return {
    id: `item:${item.id}`,
    kind: "catalog",
    title: item.name,
    why: item.why,
    risk: item.risk,
    scope: item.install.scope,
    tier: item.tier,
    license: item.license,
    source,
    profile: p.id,
    permissions: item.permissions,
    secrets: item.secrets,
    ...(item.notes ? { notes: item.notes } : {}),
    preview: commands.length
      ? { type: "commands", commands }
      : { type: "note", text: item.install.steps.map((s) => Object.keys(s)[0]).join(", ") },
    state,
    // Community items are never pre-selected (ADR-0005), and nothing unavailable or installed is.
    selected: state === "recommended" && item.tier !== "community",
    ...(reason ? { reason } : {}),
  };
}

/**
 * The host of a remote URL. SSH host aliases such as `github-personal.com` (several accounts on one machine) are
 * read as github.com: the alias's real host lives in ~/.ssh/config, which the app doesn't read.
 */
export function gitHost(url: string): string | null {
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[/:]/i.exec(url)?.[1]?.toLowerCase() ?? null;
  return host && /(^|[.-])github([.-]|$)/.test(host) ? "github.com" : host;
}

/** The real environment of a workspace, for `buildPlan`. */
export function planEnv(root: string, env: NodeJS.ProcessEnv = process.env): PlanEnv {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  const hasTool = (name: string) =>
    dirs.some((d) =>
      exts.some((e) => existsSync(path.join(d, name + e.toLowerCase())) || existsSync(path.join(d, name + e))),
    );
  let remoteHost: string | null = null;
  if (repoOf(root)) {
    const url = git(["remote", "get-url", "origin"], root).stdout.trim();
    remoteHost = gitHost(url);
  }
  let enabledPlugins = new Set<string>();
  try {
    const settings = JSON.parse(readFileSync(path.join(root, ".claude", "settings.json"), "utf8")) as {
      enabledPlugins?: Record<string, unknown>;
    };
    enabledPlugins = new Set(
      Object.entries(settings.enabledPlugins ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id),
    );
  } catch {
    // no project settings yet
  }
  return { platform: process.platform, hasTool, remoteHost, enabledPlugins };
}
