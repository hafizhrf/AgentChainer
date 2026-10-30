import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BootstrapPlan, Finding, PlanAction, WorkspaceProfile } from "@agentchainer/protocol";
import { type Catalog, type Item, type Profile, REQUIRED_REVIEWS } from "../catalog/schema.ts";
import shippedLibrary from "../tasks/library.json" with { type: "json" };
import { LibrarySchema, renderRoleFile } from "../tasks/library.ts";
import { git, repoOf } from "../workspace.ts";
import { GENERATORS, type Proposal } from "./generate.ts";
import { itemChanges } from "./steps.ts";
import { stopHookFiles, stopTestTarget } from "./stop-hook.ts";
import { binaryName, onPath, platformKey, toolsDir } from "./tools.ts";

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
  arch: string;
  /** AgentChainer's tools folder for downloaded binaries (M2-15); null when the app didn't set one. */
  toolsDir: string | null;
  /** Catalog items recorded as installed in `.agentchainer/lock.json` or `local.json`. */
  installedItems: Set<string>;
};

/** The block "Ignore env and secret files" appends to .gitignore. */
export const GITIGNORE_ENV_BLOCK = "\n# Env files can hold secrets (keep examples)\n.env\n.env.*\n!.env.example\n";

const GENERATOR_TEXT: Record<string, { title: string; why: string }> = {
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
  /** Generator proposals waiting for review, by action. */
  proposals: Map<string, Proposal> = new Map(),
): BootstrapPlan {
  const fixes = new Set(findings.filter((f) => f.status !== "ok" && f.fix).map((f) => f.fix?.action ?? ""));
  const actions: PlanAction[] = [...fixActions(root, fixes, profile)];
  const roles = rolesAction(root);
  if (roles) actions.push(roles);

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
      actions.push(itemAction(root, item, p, on, env));
    }
  }

  for (const [action, gen] of Object.entries(GENERATOR_TEXT)) {
    if (!fixes.has(action)) continue;
    const base = {
      id: `gen:${action}`,
      kind: "generator" as const,
      title: gen.title,
      why: gen.why,
      risk: "medium" as const,
      scope: "project" as const,
      permissions: [
        "Generating runs a Claude session that can only read this workspace and run its test, lint, typecheck and build commands",
        "It proposes files; nothing is written until you apply the proposal",
      ],
      secrets: [],
    };
    const proposal = proposals.get(action);
    // Scaffolded tests are verified by running them, which needs the project's dependencies (M2-23).
    const install = action === "scaffold-tests" ? installCommand(profile) : undefined;
    if (proposal) {
      const failing = proposal.checks.filter((c) => c.status === "fail").length;
      actions.push({
        ...base,
        ...(install ? { installCommand: install } : {}),
        notes: proposal.summary,
        preview: { type: "files", files: proposal.files },
        checks: proposal.checks,
        state: "recommended",
        // A proposal that failed its checks after the repair attempts is shown, not pre-selected.
        selected: failing === 0,
        generatable: true,
      });
    } else {
      const available = action in GENERATORS;
      actions.push({
        ...base,
        preview: {
          type: "note",
          text: "Generate a proposal to see the exact files. Claude reads the project and proposes them; you review the diff here.",
        },
        state: "unavailable",
        selected: false,
        reason: available ? "Generate a proposal first (it costs a model call)." : "This generator comes later.",
        generatable: available,
      });
    }
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
const ROLES = Object.values(LibrarySchema.parse(shippedLibrary).roles);

/**
 * AgentChainer's task roles as files in `.claude/agents/` (M3-05), so the CLI and other Claude surfaces can use them
 * too (`claude --agent ac-implementer`). Offered when one is missing or differs; never selected by default, and not
 * tied to a finding, so it doesn't count as something to fix. Applied and rolled back like any file fix.
 */
function rolesAction(root: string): PlanAction | null {
  const files = ROLES.map((role) => {
    const rel = `.claude/agents/${role.name}.md`;
    const abs = path.join(root, ...rel.split("/"));
    return { path: rel, before: existsSync(abs) ? readFileSync(abs, "utf8") : "", after: renderRoleFile(role) };
  }).filter((f) => f.before !== f.after);
  if (!files.length) return null;
  return {
    id: "fix:install-agents",
    kind: "fix",
    title: "Install AgentChainer's task roles",
    why: "The roles tasks run with (implementer, architect, reviewers, planners) as project agents, so the CLI and other Claude surfaces can use them too.",
    risk: "low",
    scope: "project",
    permissions: [],
    secrets: [],
    preview: { type: "files", files },
    state: "optional",
    selected: false,
  };
}

function fixActions(root: string, fixes: Set<string>, profile: WorkspaceProfile): PlanAction[] {
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
  if (fixes.has("stop-tests")) {
    const target = stopTestTarget(profile);
    const files = target && stopHookFiles(root, target);
    if (target && files) {
      actions.push({
        ...base,
        id: "fix:stop-tests",
        title: "Run the tests when Claude stops",
        why: `After each turn, \`${target.run}\` runs; if tests fail, Claude gets the failures and fixes them before stopping. Slow test suites make every turn slower.`,
        preview: { type: "files", files: files.map(({ path: p, before, after }) => ({ path: p, before, after })) },
        // Optional: it changes how every turn ends.
        state: "recommended",
        selected: false,
      });
    }
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

function itemAction(root: string, item: Item, p: Profile, suggestedProfile: boolean, env: PlanEnv): PlanAction {
  const src = item.source;
  const changes = itemChanges(root, item, env);
  const key = platformKey(env.platform, env.arch);
  const asset = src.type === "release-asset" && key ? src.assets[key] : undefined;
  const pluginId = src.type === "marketplace" ? `${src.plugin}@${src.marketplace}` : null;
  const missing = item.requires.filter((r) => !env.hasTool(r.tool));
  const reviews = item.reviews.length;
  const needed = REQUIRED_REVIEWS[item.tier];
  let state: PlanAction["state"] = suggestedProfile ? "recommended" : "optional";
  let reason: string | undefined;
  if ((pluginId && env.enabledPlugins.has(pluginId)) || env.installedItems.has(item.id)) {
    state = "installed";
  } else if (!item.platforms.includes(env.platform as never) || (src.type === "release-asset" && !asset)) {
    state = "unavailable";
    reason = `Not available on ${env.platform}${src.type === "release-asset" ? ` (${env.arch})` : ""}.`;
  } else if (reviews < needed) {
    state = "unavailable";
    reason = `Not reviewed yet: needs ${needed - reviews} more maintainer review(s) against docs/CATALOG.md §4.`;
  } else if (missing.length) {
    state = "unavailable";
    reason = missing.map((r) => `Needs \`${r.tool}\` on PATH (${r.hint}).`).join(" ");
  } else if (changes.unavailable) {
    state = "unavailable";
    reason = changes.unavailable;
  }
  // A download is part of what the user agrees to: what, from where, and its pinned hash.
  const permissions =
    src.type === "release-asset" && asset
      ? [
          ...item.permissions,
          `Downloads ${binaryName(item) ?? item.name} ${src.version} for ${key} from ${new URL(asset.url).host} (sha256 ${asset.sha256.slice(0, 12)}…) into AgentChainer's tools folder; it stays there after a rollback`,
        ]
      : item.permissions;
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
    scope: changes.scope,
    tier: item.tier,
    license: item.license,
    source,
    profile: p.id,
    permissions,
    secrets: item.secrets,
    ...(item.notes ? { notes: item.notes } : {}),
    preview: changes.files.length
      ? { type: "files", files: changes.files.map(({ path: p, before, after }) => ({ path: p, before, after })) }
      : changes.commands.length
        ? { type: "commands", commands: changes.commands }
        : { type: "note", text: notePreview(item) },
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
  const hasTool = (name: string) => onPath(name, env) !== null;
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
  return {
    platform: process.platform,
    arch: process.arch,
    hasTool,
    remoteHost,
    enabledPlugins,
    toolsDir: toolsDir(env),
    installedItems: installedItems(root),
  };
}

/** Item ids recorded in the committed lockfile and the private `local.json` (docs/CATALOG.md §7). */
export function installedItems(root: string): Set<string> {
  const ids = new Set<string>();
  for (const file of [".agentchainer/lock.json", ".agentchainer/local.json"]) {
    try {
      const lock = JSON.parse(readFileSync(path.join(root, file), "utf8")) as { items?: { id?: unknown }[] };
      for (const i of lock.items ?? []) if (typeof i.id === "string") ids.add(i.id);
    } catch {
      // not written yet
    }
  }
  return ids;
}

/** The install command of the first package that has one, for installing before tests run (M2-23). */
export function installCommand(profile: WorkspaceProfile): string | undefined {
  return profile.packages.find((p) => p.commands.install)?.commands.install?.run;
}

/** In words, for items whose changes aren't known before downloading (a pinned git folder copied into the project). */
function notePreview(item: Item): string {
  const src = item.source;
  const targets = item.install.steps.flatMap((s) => ("copy" in s ? [s.copy.to] : []));
  if (src.type === "git" && targets.length) {
    const license = src.license
      ? `, with its license notice (${src.license.path}, sha256 ${src.license.sha256.slice(0, 12)}…)`
      : "";
    return `Copies ${src.path} from ${src.repo} at ${src.ref.slice(0, 7)} into ${targets.join(", ")}${license}, after checking it against the pinned tree sha256 (${src.sha256.slice(0, 12)}…). Nothing else changes.`;
  }
  return item.install.steps.map((s) => Object.keys(s)[0]).join(", ");
}
