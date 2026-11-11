import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlanAction } from "@agentchainer/protocol";
import type { Catalog, Item } from "../catalog/schema.ts";
import { auditWorkspace } from "../detect/audit.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { t } from "../i18n/index.ts";
import type { CliResult } from "../installer.ts";
import { git, literal } from "../workspace.ts";
import { readWorkspaceText, refuseLinks } from "../workspace-files.ts";
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
export type Undo =
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

/**
 * A plugin installed from the Plugins page that the catalog hasn't reviewed (ADR-0010): where its marketplace said it
 * came from at install time. The CLI can't pin plugin versions (spike S6), so `version` records what was installed.
 */
export type ListedSource = {
  type: "listed";
  marketplace: string;
  plugin: string;
  url?: string;
  path?: string;
  sha?: string;
};
export type LockItem = {
  id: string;
  kind: string;
  /** A catalog tier, or "unreviewed" for a listed plugin (ADR-0010). */
  tier: string;
  source: Item["source"] | ListedSource;
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

/** `rel` as a path under `root`; throws for an empty, absolute or `..` path. */
export function insideRoot(root: string, rel: string): string {
  const parts = rel.split(/[\\/]+/);
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || parts.includes("..")) {
    throw new Error(t("bootstrap.apply.outsideWorkspace", { path: rel }));
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
      refuseLinks(this.root, rel);
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

/** Keeps the backups and the local-only files out of git, as part of the run so a full rollback restores it too. */
function ignoreOwnFiles(root: string, tracker: Tracker, meta: FileRecord[]): void {
  const ignore = existsSync(abs(root, AC_IGNORE)) ? readFileSync(abs(root, AC_IGNORE), "utf8") : "";
  const lines = ignore.split("\n");
  const missing = ["backups/", "profile.json", "local.json"].filter((l) => !lines.includes(l));
  if (missing.length) {
    tracker.write(meta, AC_IGNORE, `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }
}

/**
 * Writes or deletes workspace files as one recorded run with a single action, so History lists it and Roll back
 * restores the files, like an applied setup step: the agent library's edits (M4-06). `content: null` deletes the file.
 */
export function applyFileEdits(
  root: string,
  action: { id: string; title: string },
  edits: { path: string; content: string | null }[],
  catalogVersion: string,
  now = new Date(),
): string {
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = abs(root, `${BACKUPS}/${runId}`);
  refuseLinks(root, BACKUPS);
  mkdirSync(runDir, { recursive: true });
  const tracker = new Tracker(root, runDir);
  const rec: ActionRecord = { ...action, status: "applied", warnings: [], files: [], undo: [] };
  const run: RunRecord = { runId, startedAt: now.toISOString(), catalogVersion, actions: [rec], meta: [] };
  try {
    for (const e of edits) {
      if (e.content !== null) tracker.write(rec.files, e.path, e.content);
      else {
        tracker.watch(rec.files, e.path);
        rmSync(insideRoot(root, e.path), { force: true });
      }
    }
    tracker.settle(rec.files);
  } catch (err) {
    // Leave nothing half-written.
    restoreFiles(root, runDir, rec.files, true);
    rmSync(runDir, { recursive: true, force: true });
    removeIfEmpty(root);
    throw err;
  }
  ignoreOwnFiles(root, tracker, run.meta);
  writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  return runId;
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
    if (!action) results.push({ id, status: "skipped", message: t("bootstrap.apply.notInPlan"), warnings: [] });
    else if (action.state !== "recommended" && action.state !== "optional") {
      results.push({
        id,
        status: "skipped",
        message:
          action.reason ??
          (action.state === "installed"
            ? t("bootstrap.apply.skippedInstalled")
            : t("bootstrap.apply.skippedUnavailable")),
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
  refuseLinks(root, BACKUPS);
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

  if (run.actions.some((a) => a.status === "applied")) finishRun(root, runDir, tracker, run);
  else {
    rmSync(runDir, { recursive: true, force: true });
    removeIfEmpty(root);
  }
  return { runId, results };
}

/**
 * Records the applied actions' lockfile entries and .agentchainer/.gitignore as part of the run, so a full rollback
 * restores them too, then writes run.json.
 */
function finishRun(root: string, runDir: string, tracker: Tracker, run: RunRecord): void {
  const lock = readLock(root, run.catalogVersion);
  const local = readLock(root, run.catalogVersion, LOCAL);
  let localChanged = false;
  let lockChanged = existsSync(abs(root, LOCK));
  lock.catalogVersion = run.catalogVersion;
  lock.generatedBy = GENERATED_BY;
  for (const a of run.actions.filter((a) => a.status === "applied")) {
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
  ignoreOwnFiles(root, tracker, run.meta);
  writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
}

/** The settings file `claude plugin install` edits for a scope. */
const settingsFor = (scope: "project" | "local") =>
  scope === "local" ? ".claude/settings.local.json" : ".claude/settings.json";

/**
 * Records a change the CLI makes outside the setup plan as a one-action run, so History lists it and Roll back undoes
 * it like a setup step: a plugin from the Plugins page (UX-10), an MCP server from the MCP servers page (CP-02).
 * `change` makes it through the CLI and says how to undo it; it returns null when nothing changed (the CLI wants a
 * command confirmed first), and then no run is left behind. The files in `watch` are restored on Roll back.
 */
export async function recordCliChange(
  root: string,
  action: { id: string; title: string; watch: string[] },
  change: () => Promise<{ undo: Undo; lock?: LockItem; warnings: string[] } | null>,
  catalogVersion: string,
  now = new Date(),
): Promise<string | null> {
  const runId = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = abs(root, `${BACKUPS}/${runId}`);
  refuseLinks(root, BACKUPS);
  mkdirSync(runDir, { recursive: true });
  const tracker = new Tracker(root, runDir);
  const rec: ActionRecord = {
    id: action.id,
    title: action.title,
    status: "applied",
    warnings: [],
    files: [],
    undo: [],
  };
  const run: RunRecord = { runId, startedAt: now.toISOString(), catalogVersion, actions: [rec], meta: [] };
  const dropRun = () => {
    rmSync(runDir, { recursive: true, force: true });
    removeIfEmpty(root);
  };
  for (const file of action.watch) tracker.watch(rec.files, file);
  let done: Awaited<ReturnType<typeof change>>;
  try {
    done = await change();
  } catch (err) {
    dropRun();
    throw err;
  }
  if (!done) {
    dropRun();
    return null;
  }
  tracker.settle(rec.files);
  rec.undo.push(done.undo);
  rec.warnings = done.warnings;
  if (done.lock) rec.lock = done.lock;
  finishRun(root, runDir, tracker, run);
  return runId;
}

/** A plugin installed from the Plugins page (UX-10), recorded by `recordCliChange`; Roll back uninstalls it. */
export function recordPluginInstall(
  root: string,
  action: { id: string; title: string; scope: "project" | "local" | "user" },
  install: () => Promise<{ pluginId: string; lock: LockItem; warnings: string[] } | null>,
  catalogVersion: string,
  now = new Date(),
): Promise<string | null> {
  const { scope } = action;
  return recordCliChange(
    root,
    // A user-scope install (every project, UX-19) changes the CLI's user settings, not this workspace's files: the run
    // keeps no file to restore, and Roll back uninstalls it through the CLI.
    { id: action.id, title: action.title, watch: scope === "user" ? [] : [settingsFor(scope)] },
    async () => {
      const done = await install();
      return (
        done && { undo: { type: "plugin", pluginId: done.pluginId, scope }, lock: done.lock, warnings: done.warnings }
      );
    },
    catalogVersion,
    now,
  );
}

/** The plugin id a lockfile entry installed, if it's a plugin. */
export function lockPluginId(entry: LockItem): string | null {
  const src = entry.source;
  return src.type === "marketplace" || src.type === "listed" ? `${src.plugin}@${src.marketplace}` : null;
}

/** Whether an applied action of a run would undo something `match` picks out. */
const undoes = (a: ActionRecord, match: (u: Undo) => boolean) => a.status === "applied" && a.undo.some(match);

/** After a page removed something a run added: those runs show it as rolled back, so Roll back doesn't try again. */
function forgetUndone(root: string, match: (u: Undo) => boolean): void {
  for (const run of listRuns(root)) {
    let changed = false;
    for (const a of run.actions) {
      if (!undoes(a, match)) continue;
      a.status = "rolled-back";
      changed = true;
    }
    if (changed) writeFileSync(abs(root, `${BACKUPS}/${run.runId}/run.json`), `${JSON.stringify(run, null, 2)}\n`);
  }
}

/**
 * Before a page removes something a run added: when the files that run changed are still as it left them, the
 * returned function puts them back as they were before it, once the CLI has removed it; otherwise null, and the CLI's
 * own edit stays.
 */
function filesBeforeAdd(root: string, match: (u: Undo) => boolean): (() => void) | null {
  for (const run of listRuns(root)) {
    for (const a of run.actions) {
      if (!undoes(a, match)) continue;
      if (changedSince(root, a.files).length) return null;
      const runDir = abs(root, `${BACKUPS}/${run.runId}`);
      return () => {
        restoreFiles(root, runDir, a.files, true);
      };
    }
  }
  return null;
}

const isPlugin = (pluginId: string, scope: string) => (u: Undo) =>
  u.type === "plugin" && u.pluginId === pluginId && u.scope === scope;
const isMcp = (name: string, scope: string) => (u: Undo) => u.type === "mcp" && u.name === name && u.scope === scope;

/**
 * After the Plugins page uninstalls a plugin: its lockfile entries go, and the runs that installed it at that scope
 * show it as rolled back, so a later Roll back doesn't try to uninstall it again.
 */
export function forgetPlugin(root: string, pluginId: string, scope: string): void {
  editPluginLocks(root, pluginId, () => null);
  forgetUndone(root, isPlugin(pluginId, scope));
}

/** Before the Plugins page uninstalls a plugin: its settings file as it was before the latest install, if unchanged. */
export const pluginInstallFiles = (root: string, pluginId: string, scope: string) =>
  filesBeforeAdd(root, isPlugin(pluginId, scope));

/** After the MCP servers page removed a server (CP-02): the runs that added it at that scope show it rolled back. */
export const forgetMcp = (root: string, name: string, scope: string) => forgetUndone(root, isMcp(name, scope));

/** Before the MCP servers page removes a server: `.mcp.json` as it was before the latest add, if unchanged. */
export const mcpAddFiles = (root: string, name: string, scope: string) => filesBeforeAdd(root, isMcp(name, scope));

/** After an update from the Plugins page: the lockfile records the version now installed. */
export function setPluginVersion(root: string, pluginId: string, version: string): void {
  editPluginLocks(root, pluginId, (entry) => ({ ...entry, version }));
}

/** Rewrites (or, with null, removes) the lockfile entries of a plugin, in lock.json and local.json. */
function editPluginLocks(root: string, pluginId: string, edit: (entry: LockItem) => LockItem | null): void {
  for (const rel of [LOCK, LOCAL]) {
    const file = abs(root, rel);
    if (!existsSync(file)) continue;
    refuseLinks(root, rel);
    const lock = readLock(root, "", rel);
    let changed = false;
    lock.items = lock.items.flatMap((entry) => {
      if (lockPluginId(entry) !== pluginId) return [entry];
      changed = true;
      const next = edit(entry);
      return next ? [next] : [];
    });
    if (changed) writeFileSync(file, lockText(lock));
  }
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
      run(root, ["git", "rm", "--cached", "-q", "--", ...paths.map(literal)]);
      rec.undo.push({ type: "git-unstage-removal", paths });
      fixRecord(paths);
      return;
    }
    throw new Error(`No applier for ${action.id}`);
  }
  if (action.kind === "generator") {
    const name = action.id.slice(4);
    const proposal = ctx.proposals?.get(name);
    if (!proposal) throw new Error(t("bootstrap.apply.generateFirst"));
    for (const f of proposal.files) {
      insideRoot(root, f.path);
      const current = readWorkspaceText(root, f.path);
      if (current !== f.before) throw new Error(t("bootstrap.apply.proposalStale", { path: f.path }));
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
    for (const c of failed)
      rec.warnings.push(t("bootstrap.apply.verificationFailed", { name: c.name, detail: c.detail }));
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
    if (!ctx.cli) throw new Error(t("bootstrap.apply.noCliForPlugins"));
    if (!hasMarketplace(ctx.cli.listMarketplaces().json, src.marketplace)) {
      throw new Error(t("bootstrap.apply.marketplaceMissing", { marketplace: src.marketplace, repo: src.repo }));
    }
    const pluginId = `${src.plugin}@${src.marketplace}`;
    tracker.watch(rec.files, ".claude/settings.json");
    const res = ctx.cli.installPlugin(pluginId, item.install.scope);
    if (!res.ok) {
      throw new Error(
        t("bootstrap.apply.pluginInstallFailed", { output: (res.stderr || res.stdout).trim().slice(0, 300) }),
      );
    }
    rec.undo.push({ type: "plugin", pluginId, scope: item.install.scope });
    const version = pluginVersion(ctx.cli.listPlugins().json, pluginId);
    if (version && src.reviewedVersion && version !== src.reviewedVersion) {
      rec.warnings.push(t("bootstrap.apply.versionMovedOn", { version, reviewed: src.reviewedVersion }));
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
        throw new Error(t("bootstrap.apply.hashMismatch", { id: item.id, expected: src.sha256, got }));
      // The license the copied files need, from outside the copied folder (M2-29): checked before anything is written.
      const notice = src.license
        ? { name: path.posix.basename(src.license.path), bytes: readLicense(tree.root, src.license, item.id) }
        : null;
      const written: string[] = [];
      for (const step of item.install.steps) {
        if (!("copy" in step)) {
          throw new Error(t("bootstrap.apply.unsupportedGitStep", { step: Object.keys(step)[0] ?? "" }));
        }
        const from = path.join(tree.dir, ...step.copy.from.split("/").filter((p) => p && p !== "."));
        if (existsSync(abs(root, step.copy.to))) {
          throw new Error(t("bootstrap.apply.alreadyExists", { path: step.copy.to }));
        }
        const files = listFiles(from);
        if (notice && files.includes(notice.name)) {
          throw new Error(t("bootstrap.apply.licenseClash", { id: item.id, name: notice.name }));
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
      if (!ctx.env.toolsDir) throw new Error(t("bootstrap.steps.noToolsDir"));
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
        throw new Error(t("bootstrap.apply.unsupportedStep", { type: src.type, step: Object.keys(step)[0] ?? "" }));
      if (!ctx.cli) throw new Error(t("bootstrap.apply.noCliForMcp"));
      const [command = "", ...args] = step["mcp-add"].command.map((a) =>
        a === "{binary}" ? (changes.binary ?? a) : a,
      );
      const name = step["mcp-add"].name;
      const res = ctx.cli.addMcp(name, item.install.scope, command, args);
      if (!res.ok) {
        throw new Error(t("bootstrap.apply.mcpAddFailed", { output: (res.stderr || res.stdout).trim().slice(0, 300) }));
      }
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
  throw new Error(t("bootstrap.apply.unsupportedSource", { type: src.type }));
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
  const name = t("bootstrap.apply.dependenciesCheck");
  if (command !== shown) {
    return {
      name,
      status: "skipped",
      detail:
        command !== undefined
          ? t("bootstrap.apply.installCommandChanged", { command })
          : t("bootstrap.apply.installCommandGone"),
    };
  }
  const dir = pkg?.path && pkg.path !== "." ? `${pkg.path}/` : "";
  // Watched whether or not they exist yet: a lockfile the install creates is removed again by a rollback.
  for (const lock of LOCKFILES) tracker.watch(rec.files, `${dir}${lock}`);
  const r = await runCommand(command, path.join(root, ...dir.split("/").filter(Boolean)), 600_000);
  tracker.settle(rec.files);
  const values = { command, code: String(r.exitCode), seconds: (r.ms / 1000).toFixed(1) };
  return {
    name,
    status: r.exitCode === 0 ? "pass" : "fail",
    detail: r.timedOut
      ? t("bootstrap.verify.timedOut", { command, seconds: Math.round(r.ms / 1000) })
      : r.exitCode === 0
        ? t("bootstrap.apply.dependenciesInstalled", values)
        : t("bootstrap.verify.exitedWithOutput", { ...values, output: r.tail }),
  };
}

function run(cwd: string, argv: string[]): void {
  const [cmd, ...args] = argv;
  if (cmd !== "git") throw new Error(`Only git commands run here: ${cmd}`);
  const r = git(args, cwd);
  if (r.status !== 0)
    throw new Error(t("bootstrap.apply.commandFailed", { command: argv.join(" "), error: r.stderr.trim() }));
}

/**
 * Undoes one action, all or nothing: if any of its files changed since the run (and `force` isn't set), nothing is
 * touched and the conflicts are returned. Otherwise CLI changes are undone first, then files are restored, because the
 * CLI itself rewrites some of them (e.g. `plugin uninstall` edits .claude/settings.json); what couldn't be undone is
 * returned as `kept`.
 */
function undoAction(
  root: string,
  runDir: string,
  rec: ActionRecord,
  ctx: Pick<ApplyContext, "cli">,
  force: boolean,
): { conflicts: string[]; kept: string[] } {
  if (!force) {
    const conflicts = changedSince(root, rec.files);
    if (conflicts.length) return { conflicts, kept: [] };
  }
  const kept: string[] = [];
  for (const u of [...rec.undo].reverse()) {
    if (u.type === "plugin") {
      const res = ctx.cli?.uninstallPlugin(u.pluginId, u.scope);
      if (!res?.ok) kept.push(t("bootstrap.apply.keptPlugin", { id: u.pluginId, scope: u.scope }));
    } else if (u.type === "mcp") {
      const res = ctx.cli?.removeMcp(u.name, u.scope);
      if (!res?.ok) kept.push(t("bootstrap.apply.keptMcp", { name: u.name, scope: u.scope }));
    } else if (u.type === "git-unstage-removal") {
      const r = git(["reset", "-q", "--", ...u.paths.map(literal)], root);
      if (r.status !== 0) kept.push(t("bootstrap.apply.keptIndex", { paths: u.paths.join(", ") }));
    } else if (u.type === "git-init") {
      // Only an empty repository is removed: once it has commits, deleting .git would lose history.
      if (git(["rev-parse", "--verify", "-q", "HEAD"], root).status === 0) kept.push(t("bootstrap.apply.keptGit"));
      else rmSync(abs(root, ".git"), { recursive: true, force: true });
    }
  }
  restoreFiles(root, runDir, rec.files, true);
  return { conflicts: [], kept };
}

/** Files whose content differs from what the run left behind, each with a note saying so. */
function changedSince(root: string, files: FileRecord[]): string[] {
  return files
    .filter((rec) => {
      const file = abs(root, rec.path);
      return (existsSync(file) ? sha256(readFileSync(file)) : null) !== rec.afterSha256;
    })
    .map((rec) => t("bootstrap.apply.changedSince", { path: rec.path }));
}

/** Restores files byte for byte. A file changed since the run is skipped (and returned) unless `force`. */
function restoreFiles(root: string, runDir: string, files: FileRecord[], force: boolean): string[] {
  if (!force) {
    const conflicts = changedSince(root, files);
    if (conflicts.length) return conflicts;
  }
  for (const rec of [...files].reverse()) {
    const file = abs(root, rec.path);
    // A link planted since the run would send the restore somewhere else.
    refuseLinks(root, rec.path);
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
  if (!/^[\w-]+$/.test(run.runId ?? "")) return t("bootstrap.apply.problemRunId");
  const files = [...(run.meta ?? []), ...(run.actions ?? []).flatMap((a) => a.files ?? [])];
  for (const f of files) {
    try {
      insideRoot(root, f.path);
    } catch {
      return t("bootstrap.apply.problemFileOutside", { path: f.path });
    }
    if (f.backup !== undefined && (!f.backup.startsWith("files/") || f.backup.split(/[\\/]+/).includes(".."))) {
      return t("bootstrap.apply.problemBackupOutside", { path: f.backup });
    }
  }
  const scopes = new Set(["project", "user", "local"]);
  for (const u of (run.actions ?? []).flatMap((a) => a.undo ?? [])) {
    if (u.type === "plugin" && !(/^[\w.-]+@[\w.-]+$/.test(u.pluginId) && scopes.has(u.scope))) {
      return t("bootstrap.apply.problemPluginUndo");
    }
    if (u.type === "mcp" && !(/^[\w-]+$/.test(u.name) && scopes.has(u.scope)))
      return t("bootstrap.apply.problemMcpUndo");
    if (u.type === "git-unstage-removal") {
      for (const p of u.paths) {
        try {
          insideRoot(root, p);
        } catch {
          return t("bootstrap.apply.problemPathOutside", { path: p });
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
  if (!/^[\w-]+$/.test(runId)) throw new Error(t("bootstrap.apply.badRunId", { runId }));
  const runDir = abs(root, `${BACKUPS}/${runId}`);
  const runFile = path.join(runDir, "run.json");
  if (!existsSync(runFile)) throw new Error(t("bootstrap.apply.noRun", { runId }));
  const run = JSON.parse(readFileSync(runFile, "utf8")) as RunRecord;
  const problem = runProblem(root, run);
  if (problem) throw new Error(t("bootstrap.apply.notRecorded", { runId, problem }));
  const force = opts.force ?? false;
  const results: RollbackResult[] = [];
  const targets = run.actions.filter((a) => a.status === "applied" && (!opts.actionId || a.id === opts.actionId));
  if (opts.actionId && targets.length === 0)
    throw new Error(t("bootstrap.apply.notApplied", { actionId: opts.actionId, runId }));

  for (const rec of [...targets].reverse()) {
    try {
      const { conflicts, kept } = undoAction(root, runDir, rec, ctx, force);
      const conflict = conflicts.length > 0;
      const left = [...conflicts, ...kept];
      rec.status = conflict ? rec.status : "rolled-back";
      results.push(
        left.length
          ? {
              id: rec.id,
              status: conflict ? "conflict" : "kept",
              message: t("bootstrap.apply.notRestored", { items: left.join("; ") }),
            }
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
      results.push({
        id: "lockfile",
        status: "conflict",
        message: t("bootstrap.apply.notRestored", { items: conflicts.join("; ") }),
      });
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
