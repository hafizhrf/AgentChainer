import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlanAction } from "@agentchainer/protocol";
import type { Catalog, Item } from "../catalog/schema.ts";
import { auditWorkspace } from "../detect/audit.ts";
import { detectWorkspace } from "../detect/detect.ts";
import type { CliResult } from "../installer.ts";
import { git } from "../workspace.ts";
import { type Check, GENERATORS, type Proposal } from "./generate.ts";
import { type FetchTree, fetchGitHubTree, listFiles, readLicense, treeHash } from "./git-source.ts";
import { buildPlan, type PlanEnv } from "./plan.ts";
import { itemChanges } from "./steps.ts";
import { ensureTool, platformKey } from "./tools.ts";
import { runCommand, verifyApplied } from "./verify.ts";

/**
 * The bootstrap apply engine (M2-13…M2-17):
 * - re-plans before applying, so only actions that are currently selectable run;
 * - backs up every file before its first change in a run (`.agentchainer/backups/<run>/`, git-ignored);
 * - records what it applied in `.agentchainer/lock.json` (committed by default, docs/CATALOG.md §7);
 * - rolls back a run or one action: undoes CLI changes and restores files byte for byte, refusing to overwrite a file
 *   that changed since the run unless forced.
 */

export type Cli = {
  installPlugin: (id: string, scope: "project" | "user" | "local") => CliResult;
  uninstallPlugin: (id: string, scope: "project" | "user" | "local") => CliResult;
  listPlugins: () => CliResult;
  listMarketplaces: () => CliResult;
  addMcp: (name: string, scope: "project" | "user" | "local", command: string, args: string[]) => CliResult;
  removeMcp: (name: string, scope: "project" | "user" | "local") => CliResult;
};

export type ApplyContext = {
  catalog: Catalog;
  env: PlanEnv;
  /** The user's `claude` CLI, or null when it isn't found (plugin installs then fail with a clear message). */
  cli: Cli | null;
  fetchTree?: FetchTree;
  /** Downloads release assets; tests pass a fake. */
  fetchAsset?: typeof fetch;
  /** Actions whose install command the user allowed to run before verification (M2-23). */
  install?: string[];
  optIn?: string[];
  /** Generator proposals waiting for review, by action. */
  proposals?: Map<string, Proposal>;
  now?: () => Date;
};

type FileRecord = { path: string; existed: boolean; backup?: string; afterSha256: string | null };
type Undo =
  | { type: "plugin"; pluginId: string; scope: "project" | "user" | "local" }
  | { type: "mcp"; name: string; scope: "project" | "user" | "local" }
  | { type: "git-unstage-removal"; paths: string[] }
  | { type: "git-init" };
type ActionRecord = {
  id: string;
  title: string;
  status: "applied" | "failed" | "rolled-back";
  error?: string;
  warnings: string[];
  files: FileRecord[];
  undo: Undo[];
  checks?: Check[];
  lock?: LockItem | LockFix | LockGenerated;
};
export type RunRecord = {
  runId: string;
  startedAt: string;
  catalogVersion: string;
  actions: ActionRecord[];
  /** Files the run itself changed: lock.json and .agentchainer/.gitignore. */
  meta: FileRecord[];
};

export type ActionResult = {
  id: string;
  status: "applied" | "failed" | "skipped";
  message?: string;
  warnings: string[];
  checks?: Check[];
};
export type RollbackResult = { id: string; status: "rolled-back" | "conflict" | "failed" | "kept"; message?: string };

type LockItem = {
  id: string;
  kind: string;
  tier: string;
  source: Item["source"];
  scope: string;
  installedAt: string;
  version?: string;
  /** Release assets: the sha256 of the archive that was checked before unpacking. */
  archiveSha256?: string;
  files?: string[];
};
type LockFix = { id: string; appliedAt: string; files: string[] };
/** Generated files (docs/CATALOG.md §7): which generator wrote them and whether verification passed. */
type LockGenerated = { id: string; generator: string; appliedAt: string; files: string[]; verified: boolean };
type Lock = {
  lockfileVersion: 1;
  generatedBy: string;
  catalogVersion: string;
  items: LockItem[];
  fixes: LockFix[];
  generated: LockGenerated[];
};

const AC_DIR = ".agentchainer";
const BACKUPS = `${AC_DIR}/backups`;
const LOCK = `${AC_DIR}/lock.json`;
/** Local-scope items are private to this user, so they're recorded here, kept out of git (docs/CATALOG.md §7). */
const LOCAL = `${AC_DIR}/local.json`;
const AC_IGNORE = `${AC_DIR}/.gitignore`;
const GENERATED_BY = "agentchainer@0.1.0";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const abs = (root: string, rel: string) => path.join(root, ...rel.split("/"));

function insideRoot(root: string, rel: string): string {
  const parts = rel.split(/[\\/]+/);
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || parts.includes("..")) {
    throw new Error(`refusing a path outside the workspace: ${rel}`);
  }
  return abs(root, rel);
}

/** Tracks file changes within a run, backing each file up before its first change. */
class Tracker {
  private readonly root: string;
  private readonly runDir: string;
  /**
   * Numbers each backup: several actions of a run can change the same file (every plugin install edits
   * .claude/settings.json), and each needs the content from before its own change.
   */
  private backups = 0;
  constructor(root: string, runDir: string) {
    this.root = root;
    this.runDir = runDir;
  }

  private record(records: FileRecord[], rel: string): FileRecord {
    let rec = records.find((r) => r.path === rel);
    if (!rec) {
      const file = insideRoot(this.root, rel);
      const existed = existsSync(file);
      rec = { path: rel, existed, afterSha256: null };
      if (existed) {
        rec.backup = `files/${++this.backups}/${rel}`;
        const backup = path.join(this.runDir, ...rec.backup.split("/"));
        mkdirSync(path.dirname(backup), { recursive: true });
        writeFileSync(backup, readFileSync(file));
      }
      records.push(rec);
    }
    return rec;
  }

  /** Snapshot a file before something else (a CLI) changes it; call `settle` afterwards. */
  watch(records: FileRecord[], rel: string): void {
    this.record(records, rel);
  }

  settle(records: FileRecord[]): void {
    for (const rec of records) {
      const file = abs(this.root, rec.path);
      rec.afterSha256 = existsSync(file) ? sha256(readFileSync(file)) : null;
    }
  }

  write(records: FileRecord[], rel: string, content: string | Buffer, executable = false): void {
    const rec = this.record(records, rel);
    const file = insideRoot(this.root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (executable) chmodSync(file, 0o755);
    rec.afterSha256 = sha256(readFileSync(file));
  }
}

function readLock(root: string, catalogVersion: string, file = LOCK): Lock {
  try {
    const lock = JSON.parse(readFileSync(abs(root, file), "utf8")) as Lock;
    return { ...lock, items: lock.items ?? [], fixes: lock.fixes ?? [], generated: lock.generated ?? [] };
  } catch {
    return { lockfileVersion: 1, generatedBy: GENERATED_BY, catalogVersion, items: [], fixes: [], generated: [] };
  }
}

const lockText = (lock: Lock) => `${JSON.stringify(lock, null, 2)}\n`;

/** The installed version of `pluginId` from `claude plugin list --json`, whatever its exact shape. */
export function pluginVersion(json: unknown, pluginId: string): string | undefined {
  const [name, marketplace] = pluginId.split("@");
  const entries: unknown[] = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? Object.values(json as object).flatMap((v) => (Array.isArray(v) ? v : [v]))
      : [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const matches =
      o.id === pluginId ||
      o.pluginId === pluginId ||
      (o.name === name && (!o.marketplace || o.marketplace === marketplace));
    if (matches && typeof o.version === "string") return o.version;
  }
  return undefined;
}

function hasMarketplace(json: unknown, name: string): boolean {
  return JSON.stringify(json ?? null).includes(`"${name}"`);
}

export async function applyActions(
  root: string,
  ids: string[],
  ctx: ApplyContext,
): Promise<{ runId: string; results: ActionResult[] }> {
  const now = ctx.now ?? (() => new Date());
  const profile = detectWorkspace(root);
  const findings = auditWorkspace(root, profile);
  const plan = buildPlan(root, profile, findings, ctx.catalog, ctx.env, ctx.optIn ?? [], ctx.proposals ?? new Map());
  const wanted = new Set(ids);
  const results: ActionResult[] = [];
  const toApply: PlanAction[] = [];
  for (const id of ids) {
    const action = plan.actions.find((a) => a.id === id);
    if (!action)
      results.push({ id, status: "skipped", message: "Not in the current plan (already applied?)", warnings: [] });
    else if (action.state !== "recommended" && action.state !== "optional") {
      results.push({
        id,
        status: "skipped",
        message: action.reason ?? `Can't be applied (${action.state}).`,
        warnings: [],
      });
    }
  }
  toApply.push(
    ...plan.actions.filter((a) => wanted.has(a.id) && (a.state === "recommended" || a.state === "optional")),
  );

  const started = now();
  const runId = `${started.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = abs(root, `${BACKUPS}/${runId}`);
  mkdirSync(runDir, { recursive: true });
  const tracker = new Tracker(root, runDir);
  const run: RunRecord = {
    runId,
    startedAt: started.toISOString(),
    catalogVersion: ctx.catalog.version,
    actions: [],
    meta: [],
  };
  if (toApply.length === 0) {
    rmSync(runDir, { recursive: true, force: true });
    removeIfEmpty(root);
    return { runId, results };
  }

  for (const action of toApply) {
    const rec: ActionRecord = {
      id: action.id,
      title: action.title,
      status: "applied",
      warnings: [],
      files: [],
      undo: [],
    };
    run.actions.push(rec);
    try {
      await applyOne(root, action, rec, tracker, ctx, now);
      tracker.settle(rec.files);
      results.push({
        id: action.id,
        status: "applied",
        warnings: rec.warnings,
        ...(rec.checks ? { checks: rec.checks } : {}),
      });
    } catch (err) {
      rec.status = "failed";
      rec.error = err instanceof Error ? err.message : String(err);
      // Leave nothing half-applied: undo this action right away.
      undoAction(root, runDir, rec, ctx, true);
      results.push({ id: action.id, status: "failed", message: rec.error, warnings: rec.warnings });
    }
  }

  // Lockfile and .agentchainer/.gitignore, as part of the run so a full rollback restores them too.
  const applied = run.actions.filter((a) => a.status === "applied");
  if (applied.length) {
    const lock = readLock(root, ctx.catalog.version);
    const local = readLock(root, ctx.catalog.version, LOCAL);
    let localChanged = false;
    let lockChanged = existsSync(abs(root, LOCK));
    lock.catalogVersion = ctx.catalog.version;
    lock.generatedBy = GENERATED_BY;
    for (const a of applied) {
      const entry = a.lock;
      if (!entry) continue;
      if ("kind" in entry && entry.scope === "local") {
        local.items = [...local.items.filter((i) => i.id !== entry.id), entry];
        localChanged = true;
      } else {
        lockChanged = true;
        if ("kind" in entry) lock.items = [...lock.items.filter((i) => i.id !== entry.id), entry];
        else if ("generator" in entry) lock.generated = [...lock.generated.filter((g) => g.id !== entry.id), entry];
        else lock.fixes = [...lock.fixes.filter((f) => f.id !== entry.id), entry];
      }
    }
    // A run of local-only items leaves the committed lockfile alone.
    if (lockChanged) tracker.write(run.meta, LOCK, lockText(lock));
    if (localChanged) tracker.write(run.meta, LOCAL, lockText(local));
    const ignore = existsSync(abs(root, AC_IGNORE)) ? readFileSync(abs(root, AC_IGNORE), "utf8") : "";
    const lines = ignore.split("\n");
    const missing = ["backups/", "profile.json", "local.json"].filter((l) => !lines.includes(l));
    if (missing.length) {
      tracker.write(
        run.meta,
        AC_IGNORE,
        `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
      );
    }
    writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  } else {
    rmSync(runDir, { recursive: true, force: true });
    removeIfEmpty(root);
  }
  return { runId, results };
}

async function applyOne(
  root: string,
  action: PlanAction,
  rec: ActionRecord,
  tracker: Tracker,
  ctx: ApplyContext,
  now: () => Date,
): Promise<void> {
  const fixRecord = (files: string[]) => {
    rec.lock = { id: action.id.slice(4), appliedAt: now().toISOString(), files };
  };
  if (action.kind === "fix") {
    if (action.preview.type === "diff") {
      tracker.write(rec.files, action.preview.path, action.preview.after);
      fixRecord([action.preview.path]);
      return;
    }
    if (action.preview.type === "files") {
      for (const f of action.preview.files) tracker.write(rec.files, f.path, f.after, f.path.endsWith(".sh"));
      fixRecord(action.preview.files.map((f) => f.path));
      if (action.id === "fix:stop-tests") {
        rec.checks = await verifyApplied(root, "stop-tests", []);
        for (const c of rec.checks) if (c.status === "fail") rec.warnings.push(`${c.name}: ${c.detail}`);
      }
      return;
    }
    if (action.id === "fix:git-init") {
      run(root, ["git", "init", "-q"]);
      rec.undo.push({ type: "git-init" });
      fixRecord([]);
      return;
    }
    if (action.id === "fix:untrack-env" && action.preview.type === "commands") {
      const argv = action.preview.commands[0] ?? [];
      const paths = argv.slice(argv.indexOf("--") + 1);
      run(root, ["git", "rm", "--cached", "-q", "--", ...paths]);
      rec.undo.push({ type: "git-unstage-removal", paths });
      fixRecord(paths);
      return;
    }
    throw new Error(`No applier for ${action.id}`);
  }
  if (action.kind === "generator") {
    const name = action.id.slice(4);
    const proposal = ctx.proposals?.get(name);
    if (!proposal) throw new Error("Generate a proposal first.");
    for (const f of proposal.files) {
      const file = insideRoot(root, f.path);
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (current !== f.before) throw new Error(`${f.path} changed since the proposal was made. Generate it again.`);
    }
    for (const f of proposal.files) tracker.write(rec.files, f.path, f.after);
    if (action.installCommand && ctx.install?.includes(action.id)) {
      rec.checks = [await installDependencies(root, action.installCommand, rec, tracker)];
    }
    const verification = await verifyApplied(
      root,
      name,
      proposal.files.map((f) => f.path),
    );
    rec.checks = [...proposal.checks, ...(rec.checks ?? []), ...verification];
    const failed = verification.filter((c) => c.status === "fail");
    for (const c of failed) rec.warnings.push(`Verification failed (${c.name}): ${c.detail}`);
    rec.lock = {
      id: name,
      generator: GENERATORS[name]?.skill ?? name,
      appliedAt: now().toISOString(),
      files: proposal.files.map((f) => f.path),
      verified: failed.length === 0 && !proposal.checks.some((c) => c.status === "fail"),
    };
    return;
  }
  if (action.kind !== "catalog") throw new Error(`Can't apply ${action.kind} actions.`);

  const item = ctx.catalog.items.find((i) => `item:${i.id}` === action.id);
  if (!item) throw new Error(`Unknown catalog item ${action.id}`);
  const base = { id: item.id, kind: item.kind, tier: item.tier, source: item.source, scope: item.install.scope };
  const src = item.source;

  if (src.type === "marketplace") {
    if (!ctx.cli) throw new Error("Claude Code CLI not found, so plugins can't be installed.");
    if (!hasMarketplace(ctx.cli.listMarketplaces().json, src.marketplace)) {
      throw new Error(
        `The ${src.marketplace} marketplace isn't set up in your Claude CLI. Add it in your terminal: claude plugin marketplace add ${src.repo}`,
      );
    }
    const pluginId = `${src.plugin}@${src.marketplace}`;
    tracker.watch(rec.files, ".claude/settings.json");
    const res = ctx.cli.installPlugin(pluginId, item.install.scope);
    if (!res.ok) throw new Error(`claude plugin install failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
    rec.undo.push({ type: "plugin", pluginId, scope: item.install.scope });
    const version = pluginVersion(ctx.cli.listPlugins().json, pluginId);
    if (version && src.reviewedVersion && version !== src.reviewedVersion) {
      rec.warnings.push(
        `Installed ${version}, but ${src.reviewedVersion} was reviewed: the marketplace moved on. Review the changes before relying on it.`,
      );
    }
    rec.lock = { ...base, installedAt: now().toISOString(), ...(version ? { version } : {}) };
    return;
  }

  if (src.type === "git") {
    const fetchTree = ctx.fetchTree ?? fetchGitHubTree;
    const tree = await fetchTree(src.repo, src.ref, src.path);
    try {
      const got = treeHash(tree.dir);
      if (got !== src.sha256)
        throw new Error(`Hash mismatch for ${item.id}: expected ${src.sha256}, got ${got}. Not installed.`);
      // The license the copied files need, from outside the copied folder (M2-29): checked before anything is written.
      const notice = src.license
        ? { name: path.posix.basename(src.license.path), bytes: readLicense(tree.root, src.license, item.id) }
        : null;
      const written: string[] = [];
      for (const step of item.install.steps) {
        if (!("copy" in step)) throw new Error(`Unsupported install step for a git source: ${Object.keys(step)[0]}`);
        const from = path.join(tree.dir, ...step.copy.from.split("/").filter((p) => p && p !== "."));
        if (existsSync(abs(root, step.copy.to))) {
          throw new Error(`${step.copy.to} already exists. Remove it first, or keep your own version.`);
        }
        const files = listFiles(from);
        if (notice && files.includes(notice.name)) {
          throw new Error(
            `${item.id} already has a ${notice.name} in its files, so its license can't go next to them.`,
          );
        }
        for (const file of files) {
          const target = `${step.copy.to}/${file}`;
          tracker.write(rec.files, target, readFileSync(path.join(from, ...file.split("/"))));
          written.push(target);
        }
        if (notice) {
          tracker.write(rec.files, `${step.copy.to}/${notice.name}`, notice.bytes);
          written.push(`${step.copy.to}/${notice.name}`);
        }
      }
      rec.lock = { ...base, installedAt: now().toISOString(), files: written };
    } finally {
      tree.cleanup();
    }
    return;
  }
  if (src.type === "release-asset" || src.type === "npm") {
    // The same changes the plan previewed: hook files, .mcp.json entries, CLI registrations.
    const changes = itemChanges(root, item, ctx.env);
    if (changes.unavailable) throw new Error(changes.unavailable);
    let archiveSha256: string | undefined;
    if (src.type === "release-asset") {
      if (!ctx.env.toolsDir) throw new Error("AgentChainer's tools folder isn't set up. Restart the app.");
      const tool = await ensureTool(item, {
        dir: ctx.env.toolsDir,
        platform: ctx.env.platform,
        key: platformKey(ctx.env.platform, ctx.env.arch),
        ...(ctx.fetchAsset ? { fetchImpl: ctx.fetchAsset } : {}),
      });
      archiveSha256 = tool.archiveSha256;
    }
    for (const f of changes.files) tracker.write(rec.files, f.path, f.after, f.executable);
    for (const step of item.install.steps) {
      if ("download-binary" in step || "pre-commit-hook" in step || "merge-json" in step) continue;
      if (!("mcp-add" in step))
        throw new Error(`Unsupported install step for a ${src.type} source: ${Object.keys(step)[0]}`);
      if (!ctx.cli) throw new Error("Claude Code CLI not found, so MCP servers can't be registered.");
      const [command = "", ...args] = step["mcp-add"].command.map((a) =>
        a === "{binary}" ? (changes.binary ?? a) : a,
      );
      const name = step["mcp-add"].name;
      const res = ctx.cli.addMcp(name, item.install.scope, command, args);
      if (!res.ok) throw new Error(`claude mcp add failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
      rec.undo.push({ type: "mcp", name, scope: item.install.scope });
    }
    rec.lock = {
      ...base,
      scope: changes.scope,
      installedAt: now().toISOString(),
      version: src.version,
      ...(archiveSha256 ? { archiveSha256 } : {}),
      files: changes.files.map((f) => f.path),
    };
    return;
  }
  throw new Error(`Installing ${src.type} sources isn't supported.`);
}

/** Lockfiles an install may rewrite; they're backed up first so a rollback restores them byte for byte. */
const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "pubspec.lock",
  "go.sum",
];

/**
 * Runs the consented install command before the tests are verified (M2-23). Only when it's still the command the user
 * saw: the applied files may have changed what's detected. Lockfile changes are part of the run; installed packages
 * (node_modules, .venv) are ignored by git and stay.
 */
async function installDependencies(root: string, shown: string, rec: ActionRecord, tracker: Tracker): Promise<Check> {
  const pkg = detectWorkspace(root).packages.find((p) => p.commands.install);
  const command = pkg?.commands.install?.run;
  if (command !== shown) {
    return {
      name: "dependencies installed",
      status: "skipped",
      detail: `the install command changed (now ${command ?? "none"}); not run`,
    };
  }
  const dir = pkg?.path && pkg.path !== "." ? `${pkg.path}/` : "";
  // Watched whether or not they exist yet: a lockfile the install creates is removed again by a rollback.
  for (const lock of LOCKFILES) tracker.watch(rec.files, `${dir}${lock}`);
  const r = await runCommand(command, path.join(root, ...dir.split("/").filter(Boolean)), 600_000);
  tracker.settle(rec.files);
  return {
    name: "dependencies installed",
    status: r.exitCode === 0 ? "pass" : "fail",
    detail: r.timedOut
      ? `\`${command}\` timed out after ${Math.round(r.ms / 1000)} s`
      : `\`${command}\` exited ${r.exitCode} in ${(r.ms / 1000).toFixed(1)} s${r.exitCode === 0 ? "; installed packages stay after a rollback (git ignores them)" : `:\n${r.tail}`}`,
  };
}

function run(cwd: string, argv: string[]): void {
  const [cmd, ...args] = argv;
  if (cmd !== "git") throw new Error(`Only git commands run here: ${cmd}`);
  const r = git(args, cwd);
  if (r.status !== 0) throw new Error(`${argv.join(" ")} failed: ${r.stderr.trim()}`);
}

/**
 * Undoes one action, all or nothing: if any of its files changed since the run (and `force` isn't set), nothing is
 * touched and the conflicts are returned. Otherwise CLI changes are undone first, then files are restored, because the
 * CLI itself rewrites some of them (e.g. `plugin uninstall` edits .claude/settings.json).
 */
function undoAction(
  root: string,
  runDir: string,
  rec: ActionRecord,
  ctx: Pick<ApplyContext, "cli">,
  force: boolean,
): string[] {
  if (!force) {
    const conflicts = changedSince(root, rec.files);
    if (conflicts.length) return conflicts;
  }
  const kept: string[] = [];
  for (const u of [...rec.undo].reverse()) {
    if (u.type === "plugin") {
      const res = ctx.cli?.uninstallPlugin(u.pluginId, u.scope);
      if (!res?.ok)
        kept.push(`plugin ${u.pluginId} (uninstall it with: claude plugin uninstall ${u.pluginId} --scope ${u.scope})`);
    } else if (u.type === "mcp") {
      const res = ctx.cli?.removeMcp(u.name, u.scope);
      if (!res?.ok) kept.push(`MCP server ${u.name} (remove it with: claude mcp remove --scope ${u.scope} ${u.name})`);
    } else if (u.type === "git-unstage-removal") {
      const r = git(["reset", "-q", "--", ...u.paths], root);
      if (r.status !== 0) kept.push(`index entries for ${u.paths.join(", ")}`);
    } else if (u.type === "git-init") {
      // Only an empty repository is removed: once it has commits, deleting .git would lose history.
      if (git(["rev-parse", "--verify", "-q", "HEAD"], root).status === 0) kept.push(".git (it has commits now)");
      else rmSync(abs(root, ".git"), { recursive: true, force: true });
    }
  }
  restoreFiles(root, runDir, rec.files, true);
  return kept;
}

/** Files whose content differs from what the run left behind. */
function changedSince(root: string, files: FileRecord[]): string[] {
  return files
    .filter((rec) => {
      const file = abs(root, rec.path);
      return (existsSync(file) ? sha256(readFileSync(file)) : null) !== rec.afterSha256;
    })
    .map((rec) => `${rec.path} (changed since it was applied)`);
}

/** Restores files byte for byte. A file changed since the run is skipped (and returned) unless `force`. */
function restoreFiles(root: string, runDir: string, files: FileRecord[], force: boolean): string[] {
  if (!force) {
    const conflicts = changedSince(root, files);
    if (conflicts.length) return conflicts;
  }
  for (const rec of [...files].reverse()) {
    const file = abs(root, rec.path);
    if (rec.existed && rec.backup) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, readFileSync(path.join(runDir, ...rec.backup.split("/"))));
    } else {
      rmSync(file, { force: true });
      pruneEmptyDirs(root, path.dirname(file));
    }
  }
  return [];
}

function pruneEmptyDirs(root: string, dir: string): void {
  let d = dir;
  while (d.startsWith(root) && d !== root) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
    d = path.dirname(d);
  }
}

function removeIfEmpty(root: string): void {
  pruneEmptyDirs(root, abs(root, BACKUPS));
}

export function listRuns(root: string): RunRecord[] {
  const dir = abs(root, BACKUPS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(path.join(dir, d, "run.json")))
    .sort()
    .reverse()
    .flatMap((d) => {
      try {
        const run = JSON.parse(readFileSync(path.join(dir, d, "run.json"), "utf8")) as RunRecord;
        return runProblem(root, run) ? [] : [run];
      } catch {
        return [];
      }
    });
}

/**
 * Why a run record can't be trusted, or null. `.agentchainer/backups/` lives in the workspace, so a cloned repo or an
 * archive could ship a forged run.json; rollback writes and deletes the paths in it. Every file and backup path must
 * stay inside the workspace and the run's folder, and every CLI undo must name a plugin or server, nothing else.
 */
function runProblem(root: string, run: RunRecord): string | null {
  if (!/^[\w-]+$/.test(run.runId ?? "")) return "bad run id";
  const files = [...(run.meta ?? []), ...(run.actions ?? []).flatMap((a) => a.files ?? [])];
  for (const f of files) {
    try {
      insideRoot(root, f.path);
    } catch {
      return `file outside the workspace: ${f.path}`;
    }
    if (f.backup !== undefined && (!f.backup.startsWith("files/") || f.backup.split(/[\\/]+/).includes(".."))) {
      return `backup outside the run: ${f.backup}`;
    }
  }
  const scopes = new Set(["project", "user", "local"]);
  for (const u of (run.actions ?? []).flatMap((a) => a.undo ?? [])) {
    if (u.type === "plugin" && !(/^[\w.-]+@[\w.-]+$/.test(u.pluginId) && scopes.has(u.scope))) return "bad plugin undo";
    if (u.type === "mcp" && !(/^[\w-]+$/.test(u.name) && scopes.has(u.scope))) return "bad MCP undo";
    if (u.type === "git-unstage-removal") {
      for (const p of u.paths) {
        try {
          insideRoot(root, p);
        } catch {
          return `path outside the workspace: ${p}`;
        }
      }
    }
  }
  return null;
}

/**
 * Rolls back a whole run, or one action of it. A whole-run rollback also restores the lockfile and leaves no trace of
 * the run; rolling back one action removes it from the lockfile.
 */
export function rollback(
  root: string,
  runId: string,
  ctx: Pick<ApplyContext, "cli">,
  opts: { actionId?: string; force?: boolean } = {},
): RollbackResult[] {
  if (!/^[\w-]+$/.test(runId)) throw new Error(`Bad run id: ${runId}`);
  const runDir = abs(root, `${BACKUPS}/${runId}`);
  const runFile = path.join(runDir, "run.json");
  if (!existsSync(runFile)) throw new Error(`No bootstrap run ${runId} in this workspace.`);
  const run = JSON.parse(readFileSync(runFile, "utf8")) as RunRecord;
  const problem = runProblem(root, run);
  if (problem) throw new Error(`Run ${runId} wasn't recorded by AgentChainer (${problem}), so nothing was changed.`);
  const force = opts.force ?? false;
  const results: RollbackResult[] = [];
  const targets = run.actions.filter((a) => a.status === "applied" && (!opts.actionId || a.id === opts.actionId));
  if (opts.actionId && targets.length === 0)
    throw new Error(`${opts.actionId} isn't an applied action of run ${runId}.`);

  for (const rec of [...targets].reverse()) {
    try {
      const kept = undoAction(root, runDir, rec, ctx, force);
      const conflict = kept.some((k) => k.includes("changed since"));
      rec.status = conflict ? rec.status : "rolled-back";
      results.push(
        kept.length
          ? { id: rec.id, status: conflict ? "conflict" : "kept", message: `Not restored: ${kept.join("; ")}` }
          : { id: rec.id, status: "rolled-back" },
      );
    } catch (err) {
      results.push({ id: rec.id, status: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const remaining = run.actions.filter((a) => a.status === "applied");
  if (remaining.length === 0 && results.every((r) => r.status === "rolled-back")) {
    // Nothing of the run is left: restore the lockfile and .agentchainer/.gitignore, then drop the backups.
    const conflicts = restoreFiles(root, runDir, run.meta, force);
    if (conflicts.length)
      results.push({ id: "lockfile", status: "conflict", message: `Not restored: ${conflicts.join("; ")}` });
    else {
      rmSync(runDir, { recursive: true, force: true });
      pruneEmptyDirs(root, abs(root, BACKUPS));
    }
  } else {
    // Some of the run stays: take the rolled-back actions out of the lockfiles.
    const gone = new Set(run.actions.filter((a) => a.status === "rolled-back").map((a) => a.lock?.id));
    for (const rel of [LOCK, LOCAL]) {
      const lockFile = abs(root, rel);
      if (!existsSync(lockFile)) continue;
      const lock = JSON.parse(readFileSync(lockFile, "utf8")) as Lock;
      lock.items = (lock.items ?? []).filter((i) => !gone.has(i.id));
      lock.fixes = (lock.fixes ?? []).filter((f) => !gone.has(f.id));
      lock.generated = (lock.generated ?? []).filter((g) => !gone.has(g.id));
      writeFileSync(lockFile, lockText(lock));
    }
    writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  }
  return results;
}
