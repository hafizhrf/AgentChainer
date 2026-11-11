import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasKeyShape, RpcErrorCode } from "@agentchainer/protocol";
import { z } from "zod";
import { applyFileEdits } from "../bootstrap/apply.ts";
import { installCommand } from "../bootstrap/plan.ts";
import { detectWorkspace } from "../detect/detect.ts";
import { t } from "../i18n/index.ts";
import { RpcFailure } from "../rpc.ts";
import { git } from "../workspace.ts";
import { linkIn, readWorkspaceText, refuseLinks } from "../workspace-files.ts";

/**
 * Worktree setup (CP-04): what a task's new worktree gets besides the tracked files.
 * - **Copies:** gitignored files the project names in `.worktreeinclude` (Claude Code's format: gitignore syntax at the
 *   workspace root; only files that match **and** are gitignored). Being ignored, a copy is never committed.
 * - **Scripts:** `.agentchainer/worktree.json`, committed with the project: `setup` runs in each new worktree instead
 *   of the detected install command, `run` starts the app from a finished task's worktree.
 * - **Approvals:** a cloned repository can't run its scripts on its own. Each script runs only once the person has
 *   allowed that exact text on this computer, recorded in the app's data folder (`AGENTCHAINER_TRUST_FILE`), never in
 *   the repository.
 */

export const INCLUDE_FILE = ".worktreeinclude";
export const CONFIG_FILE = ".agentchainer/worktree.json";
/** At most this many files, and this many bytes, are copied into one worktree. Dependencies belong to setup. */
export const MAX_COPY_FILES = 200;
export const MAX_COPY_BYTES = 20 * 1024 * 1024;
const MAX_SCRIPT = 2000;

export type ScriptKind = "setup" | "run";

const ConfigSchema = z.object({
  setup: z.string().max(MAX_SCRIPT).optional(),
  run: z.string().max(MAX_SCRIPT).optional(),
});
export type WorktreeConfig = z.infer<typeof ConfigSchema>;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const invalid = (message: string) => new RpcFailure(RpcErrorCode.invalidParams, message);

/** The project's scripts; an unreadable file reads as none, with why. Never read through a link. */
export function readConfig(root: string): { config: WorktreeConfig; problem?: string } {
  const text = readWorkspaceText(root, CONFIG_FILE);
  if (!text.trim()) return { config: {} };
  try {
    const parsed = ConfigSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { config: parsed.data };
    return { config: {}, problem: t("worktree.config.invalid", { error: z.prettifyError(parsed.error) }) };
  } catch (err) {
    return { config: {}, problem: t("worktree.config.invalid", { error: String(err) }) };
  }
}

/* ---------- Approvals, outside the repository ---------- */

const TrustSchema = z.object({
  version: z.literal(1),
  allowed: z.array(z.object({ workspace: z.string(), kind: z.enum(["setup", "run"]), sha256: z.string() })),
});
type Trust = z.infer<typeof TrustSchema>;

const trustFile = (env: NodeJS.ProcessEnv) => env.AGENTCHAINER_TRUST_FILE || null;
const realWorkspace = (root: string) => {
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
};

function readTrust(env: NodeJS.ProcessEnv): Trust {
  const file = trustFile(env);
  if (!file || !existsSync(file)) return { version: 1, allowed: [] };
  try {
    return TrustSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { version: 1, allowed: [] };
  }
}

/** Whether the person allowed this exact script for this workspace on this computer. */
export function isAllowed(root: string, kind: ScriptKind, command: string, env = process.env): boolean {
  const workspace = realWorkspace(root);
  const hash = sha256(command);
  return readTrust(env).allowed.some((a) => a.workspace === workspace && a.kind === kind && a.sha256 === hash);
}

/** Records that the person allowed a script they saw; without a trust file (tests, scripts) nothing is kept. */
export function allowScript(root: string, kind: ScriptKind, command: string, env = process.env): void {
  const file = trustFile(env);
  if (!file || !command.trim() || isAllowed(root, kind, command, env)) return;
  const trust = readTrust(env);
  const entry = { workspace: realWorkspace(root), kind, sha256: sha256(command) };
  // The latest thousand are kept: enough for every workspace's scripts as they change.
  const next: Trust = { version: 1, allowed: [...trust.allowed, entry].slice(-1000) };
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, file);
}

/* ---------- Copies ---------- */

/** The main checkout's folder a worktree's code folder mirrors: `<repo>/.agentchainer/worktrees/<id>/<sub>` → `<repo>/<sub>`. */
export function mainCheckoutOf(code: string): string | null {
  const m = /^(.*?)[\\/]\.agentchainer[\\/]worktrees[\\/][^\\/]+(?:[\\/](.*))?$/.exec(path.resolve(code));
  return m?.[1] ? path.join(m[1], m[2] ?? "") : null;
}

/** Which of `paths` git ignores in `cwd` by the repository's own rules. */
function ignoredIn(cwd: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const r = git(["check-ignore", "--stdin", "-z"], cwd, `${paths.join("\0")}\0`);
  // Exit 1 means none is ignored; anything else but 0 is an error, and then nothing counts as ignored.
  if (r.status !== 0) return new Set();
  return new Set(r.stdout.split("\0").filter(Boolean));
}

export type IncludedFile = { path: string; bytes: number };

/**
 * The gitignored files `.worktreeinclude` (or a draft of it) names in `source`, with their sizes, up to the caps.
 * Links, files that aren't regular, and the app's own folder are left out.
 */
export function includedFiles(
  source: string,
  include = readWorkspaceText(source, INCLUDE_FILE),
): { files: IncludedFile[]; bytes: number; capped: boolean } {
  const none = { files: [], bytes: 0, capped: false };
  if (!include.trim()) return none;
  const dir = mkdtempSync(path.join(tmpdir(), "ac-include-"));
  try {
    const patterns = path.join(dir, "include");
    writeFileSync(patterns, include);
    const r = git(["ls-files", "--others", "--ignored", "-z", `--exclude-from=${patterns}`], source);
    if (r.status !== 0) return none;
    const matched = r.stdout
      .split("\0")
      .filter((p) => p && !p.startsWith(".agentchainer/") && !p.startsWith(".git/"))
      .sort();
    const ignored = ignoredIn(source, matched);
    const files: IncludedFile[] = [];
    let bytes = 0;
    for (const rel of matched) {
      if (!ignored.has(rel) || linkIn(source, rel)) continue;
      let size: number;
      try {
        const st = lstatSync(path.join(source, ...rel.split("/")));
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      if (files.length >= MAX_COPY_FILES || bytes + size > MAX_COPY_BYTES) return { files, bytes, capped: true };
      files.push({ path: rel, bytes: size });
      bytes += size;
    }
    return { files, bytes, capped: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copies the included files from the main checkout into a new worktree. A file must be ignored there too (so it's
 * never committed), and one that's already there is kept: a reused worktree's own changes win.
 */
export function copyIncluded(source: string, dest: string): { copied: string[]; capped: boolean } {
  const { files, capped } = includedFiles(source);
  const ignoredThere = ignoredIn(
    dest,
    files.map((f) => f.path),
  );
  const copied: string[] = [];
  for (const f of files) {
    if (!ignoredThere.has(f.path)) continue;
    const to = path.join(dest, ...f.path.split("/"));
    try {
      refuseLinks(dest, f.path);
      if (existsSync(to)) continue;
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(path.join(source, ...f.path.split("/")), to, constants.COPYFILE_EXCL);
      copied.push(f.path);
    } catch {
      // A link on the way, or a file that appeared meanwhile: left as it is.
    }
  }
  return { copied, capped };
}

/* ---------- Scripts ---------- */

/** What a new worktree runs to get ready: the project's script once it's allowed, else the detected install command. */
export function setupCommand(
  source: string,
  code: string,
  env = process.env,
): { command?: string; scriptNotAllowed?: boolean } {
  const script = readConfig(source).config.setup?.trim();
  const detected = installCommand(detectWorkspace(code));
  if (script && isAllowed(source, "setup", script, env)) return { command: script };
  return { ...(detected ? { command: detected } : {}), ...(script ? { scriptNotAllowed: true } : {}) };
}

/** What starts the app: the project's run script, else the detected dev command. */
export function runCommand(source: string, code: string): { command: string; script: boolean } | null {
  const script = readConfig(source).config.run?.trim();
  if (script) return { command: script, script: true };
  const dev = detectWorkspace(code).packages.find((p) => p.commands.dev)?.commands.dev?.run;
  return dev ? { command: dev, script: false } : null;
}

/** A script as the form gave it, or why it can't be committed with the repository. */
function checkScript(text: string | undefined): string | undefined {
  const script = text?.trim();
  if (!script) return undefined;
  if (/[\r\n]/.test(script)) throw invalid(t("worktree.save.oneLine"));
  if (script.length > MAX_SCRIPT) throw invalid(t("worktree.save.tooLong", { max: MAX_SCRIPT }));
  if (hasKeyShape(script)) throw invalid(t("worktree.save.secret"));
  return script;
}

/**
 * Saves `.worktreeinclude` and the scripts as one History run, which Roll back undoes; an empty one is removed. The
 * scripts saved here are allowed at once: the person wrote them. Null when nothing changed.
 */
export function saveWorktreeSetup(
  root: string,
  change: { include: string; setup?: string; run?: string },
  catalogVersion: string,
  env = process.env,
): string | null {
  const setup = checkScript(change.setup);
  const run = checkScript(change.run);
  if (hasKeyShape(change.include)) throw invalid(t("worktree.save.secret"));
  const edits: { path: string; content: string | null }[] = [];
  const include = change.include.trim() ? `${change.include.replace(/\s+$/, "")}\n` : null;
  const includeNow = existsSync(path.join(root, INCLUDE_FILE)) ? readWorkspaceText(root, INCLUDE_FILE) : null;
  if (include !== includeNow) edits.push({ path: INCLUDE_FILE, content: include });
  const config =
    setup || run ? `${JSON.stringify({ ...(setup ? { setup } : {}), ...(run ? { run } : {}) }, null, 2)}\n` : null;
  const configNow = existsSync(path.join(root, ...CONFIG_FILE.split("/")))
    ? readWorkspaceText(root, CONFIG_FILE)
    : null;
  if (config !== configNow) edits.push({ path: CONFIG_FILE, content: config });
  const runId = edits.length
    ? applyFileEdits(root, { id: "worktree-setup", title: t("worktree.save.title") }, edits, catalogVersion)
    : null;
  if (setup) allowScript(root, "setup", setup, env);
  if (run) allowScript(root, "run", run, env);
  return runId;
}
