import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlanAction } from "@agentchainer/protocol";
import type { Catalog, Item } from "../catalog/schema.ts";
import { auditWorkspace } from "../detect/audit.ts";
import { detectWorkspace } from "../detect/detect.ts";
import type { CliResult } from "../installer.ts";
import { git } from "../workspace.ts";
import { type FetchTree, fetchGitHubTree, listFiles, treeHash } from "./git-source.ts";
import { buildPlan, type PlanEnv } from "./plan.ts";

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
};

export type ApplyContext = {
  catalog: Catalog;
  env: PlanEnv;
  /** The user's `claude` CLI, or null when it isn't found (plugin installs then fail with a clear message). */
  cli: Cli | null;
  fetchTree?: FetchTree;
  optIn?: string[];
  now?: () => Date;
};

type FileRecord = { path: string; existed: boolean; backup?: string; afterSha256: string | null };
type Undo =
  | { type: "plugin"; pluginId: string; scope: "project" | "user" | "local" }
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
  lock?: LockItem | LockFix;
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
  files?: string[];
};
type LockFix = { id: string; appliedAt: string; files: string[] };
type Lock = {
  lockfileVersion: 1;
  generatedBy: string;
  catalogVersion: string;
  items: LockItem[];
  fixes: LockFix[];
  generated: unknown[];
};

const AC_DIR = ".agentchainer";
const BACKUPS = `${AC_DIR}/backups`;
const LOCK = `${AC_DIR}/lock.json`;
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
        rec.backup = `files/${rel}`;
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

  write(records: FileRecord[], rel: string, content: string | Buffer): void {
    const rec = this.record(records, rel);
    const file = insideRoot(this.root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    rec.afterSha256 = sha256(readFileSync(file));
  }
}

function readLock(root: string, catalogVersion: string): Lock {
  try {
    const lock = JSON.parse(readFileSync(abs(root, LOCK), "utf8")) as Lock;
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
  const plan = buildPlan(root, profile, auditWorkspace(root, profile), ctx.catalog, ctx.env, ctx.optIn ?? []);
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
      results.push({ id: action.id, status: "applied", warnings: rec.warnings });
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
    lock.catalogVersion = ctx.catalog.version;
    lock.generatedBy = GENERATED_BY;
    for (const a of applied) {
      if (!a.lock) continue;
      if ("kind" in a.lock) lock.items = [...lock.items.filter((i) => i.id !== a.lock?.id), a.lock];
      else lock.fixes = [...lock.fixes.filter((f) => f.id !== a.lock?.id), a.lock as LockFix];
    }
    tracker.write(run.meta, LOCK, lockText(lock));
    const ignore = existsSync(abs(root, AC_IGNORE)) ? readFileSync(abs(root, AC_IGNORE), "utf8") : "";
    const lines = ignore.split("\n");
    const missing = ["backups/", "profile.json"].filter((l) => !lines.includes(l));
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
  if (action.kind !== "catalog") throw new Error("Generators aren't available yet.");

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
      const written: string[] = [];
      for (const step of item.install.steps) {
        if (!("copy" in step)) throw new Error(`Unsupported install step for a git source: ${Object.keys(step)[0]}`);
        const from = path.join(tree.dir, ...step.copy.from.split("/").filter((p) => p && p !== "."));
        if (existsSync(abs(root, step.copy.to))) {
          throw new Error(`${step.copy.to} already exists. Remove it first, or keep your own version.`);
        }
        for (const file of listFiles(from)) {
          const target = `${step.copy.to}/${file}`;
          tracker.write(rec.files, target, readFileSync(path.join(from, ...file.split("/"))));
          written.push(target);
        }
      }
      rec.lock = { ...base, installedAt: now().toISOString(), files: written };
    } finally {
      tree.cleanup();
    }
    return;
  }
  throw new Error(`Installing ${src.type} sources arrives later (M2-15).`);
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
    .map((d) => JSON.parse(readFileSync(path.join(dir, d, "run.json"), "utf8")) as RunRecord);
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
    // Some of the run stays: take the rolled-back actions out of the lockfile.
    const lockFile = abs(root, LOCK);
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, "utf8")) as Lock;
      const gone = new Set(run.actions.filter((a) => a.status === "rolled-back").map((a) => a.lock?.id));
      lock.items = (lock.items ?? []).filter((i) => !gone.has(i.id));
      lock.fixes = (lock.fixes ?? []).filter((f) => !gone.has(f.id));
      writeFileSync(lockFile, lockText(lock));
    }
    writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  }
  return results;
}
