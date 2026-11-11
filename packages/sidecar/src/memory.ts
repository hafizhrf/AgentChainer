import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { hasKeyShape, type MemoryFile, type MemoryProject, RpcErrorCode } from "@agentchainer/protocol";
import { applyFileEdits, insideRoot } from "./bootstrap/apply.ts";
import { HOME_PATH, LONG_CLAUDE_MD, lineCount } from "./claude-md-rules.ts";
import { detectWorkspace } from "./detect/detect.ts";
import { t } from "./i18n/index.ts";
import { claudeConfigDir } from "./permissions.ts";
import { RpcFailure } from "./rpc.ts";
import { listFiles } from "./workspace.ts";
import { linkIn, MAX_PREVIEW_BYTES } from "./workspace-files.ts";

/**
 * CLAUDE.md files (CP-03), which Claude Code calls memory: the ones it loads for a workspace, to read and edit in the
 * app, and a scan across the projects the app knows. A save is a History run that Roll back undoes. The user's own
 * `~/.claude/CLAUDE.md` is only read (ADR-0013). Nothing here leaves the machine.
 */

/** The largest CLAUDE.md the editor saves: the generators' cap. Every session pays for its size. */
const MAX_SAVE_BYTES = 200 * 1024;
/** A password in a URL: worth a second look before it's committed, though local ones are common in docs. */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i;

const PROJECT_FILES = ["CLAUDE.md", ".claude/CLAUDE.md"] as const;
const LOCAL_FILE = "CLAUDE.local.md";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const invalid = (message: string) => new RpcFailure(RpcErrorCode.invalidParams, message);

function kindOf(rel: string): MemoryFile["kind"] {
  if ((PROJECT_FILES as readonly string[]).includes(rel)) return "project";
  return rel === LOCAL_FILE ? "local" : "folder";
}

/** A file's size and lines, or why the app won't open it. `followLinks` only for the user's own file. */
function describe(file: string, shown: string, kind: MemoryFile["kind"], link: string | null): MemoryFile {
  const base: MemoryFile = { path: shown, kind, exists: false, lines: 0, bytes: 0 };
  if (link) return { ...base, exists: true, refused: t("memory.files.link", { path: link }) };
  let st: ReturnType<typeof statSync>;
  try {
    st = kind === "user" ? statSync(file) : lstatSync(file);
  } catch {
    return base;
  }
  if (!st.isFile()) return { ...base, exists: true, refused: t("memory.files.notFile") };
  const found = { ...base, exists: true, bytes: st.size, modifiedAt: st.mtime.toISOString() };
  if (st.size > MAX_PREVIEW_BYTES) return { ...found, refused: t("memory.files.tooLarge") };
  return { ...found, lines: lineCount(readFileSync(file, "utf8")) };
}

const inWorkspace = (root: string, rel: string) =>
  describe(path.join(root, ...rel.split("/")), rel, kindOf(rel), linkIn(root, rel));

/** Where the user's own CLAUDE.md is, and how to show it: under the home folder as `~`. */
function userFile(configDir = claudeConfigDir()): { file: string; shown: string } {
  const file = path.join(configDir, "CLAUDE.md");
  const home = homedir();
  const shown = file.startsWith(home + path.sep) ? `~${file.slice(home.length).replaceAll("\\", "/")}` : file;
  return { file, shown };
}

export function userMemory(configDir = claudeConfigDir()): MemoryFile {
  const { file, shown } = userFile(configDir);
  return { ...describe(file, shown, "user", null), absolute: file };
}

/** The CLAUDE.md files in a workspace's folders, from the git listing (ignored folders such as dependencies left out). */
function folderFiles(root: string): string[] {
  try {
    return listFiles(root)
      .files.map((f) => f.path.replaceAll("\\", "/"))
      .filter((p) => p.includes("/") && /(^|\/)CLAUDE\.md$/.test(p) && p !== ".claude/CLAUDE.md")
      .filter((p) => existsSync(path.join(root, ...p.split("/"))))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The workspace's CLAUDE.md files: the project's (`CLAUDE.md`, or `.claude/CLAUDE.md`; a missing `CLAUDE.md` is
 * listed so it can be started), the personal `CLAUDE.local.md`, the ones in its folders, and the user's own.
 */
export function memoryFiles(root: string, configDir = claudeConfigDir()): MemoryFile[] {
  const project = PROJECT_FILES.map((rel) => inWorkspace(root, rel)).filter((f) => f.exists);
  const local = inWorkspace(root, LOCAL_FILE);
  return [
    ...(project.length ? project : [inWorkspace(root, "CLAUDE.md")]),
    ...(local.exists ? [local] : []),
    ...folderFiles(root).map((rel) => inWorkspace(root, rel)),
    userMemory(configDir),
  ];
}

/** A file's text and its sha256, to save against; a file that isn't there yet reads as "" with a null sha256. */
export function readMemory(
  root: string,
  target: { path: string } | { user: true },
  configDir = claudeConfigDir(),
): { text: string; sha256: string | null } {
  const isUser = "user" in target;
  const { file } = isUser ? userFile(configDir) : { file: insideRoot(root, target.path) };
  const f = isUser ? userMemory(configDir) : inWorkspace(root, target.path);
  if (f.refused) throw invalid(f.refused);
  if (!f.exists) return { text: "", sha256: null };
  const bytes = readFileSync(file);
  return { text: bytes.toString("utf8"), sha256: sha256(bytes) };
}

/** What's worth a second look before saving, without stopping it. */
export function memoryWarnings(text: string): string[] {
  const lines = lineCount(text);
  return [
    ...(lines > LONG_CLAUDE_MD ? [t("memory.save.long", { lines, max: LONG_CLAUDE_MD })] : []),
    ...(HOME_PATH.test(text) ? [t("memory.save.homePath")] : []),
    ...(URL_CREDENTIALS.test(text) ? [t("memory.save.urlPassword")] : []),
  ];
}

/**
 * Saves a workspace CLAUDE.md as a History run. Refused when the file changed since it was read (`baseSha256`, null
 * for a new file), when it's reached through a link or isn't a file, when the text holds a key or token, or when it's
 * over 200 KB.
 */
export function saveMemory(
  root: string,
  rel: string,
  text: string,
  baseSha256: string | null,
  catalogVersion: string,
): { runId: string; sha256: string; warnings: string[] } {
  const file = insideRoot(root, rel);
  const f = inWorkspace(root, rel);
  if (f.refused) throw invalid(f.refused);
  if (!f.exists && rel !== "CLAUDE.md" && !existsSync(path.dirname(file))) throw invalid(t("memory.save.noFolder"));
  const current = f.exists ? sha256(readFileSync(file)) : null;
  if (current !== baseSha256) throw invalid(t("memory.save.changed", { path: rel }));
  if (Buffer.byteLength(text) > MAX_SAVE_BYTES) throw invalid(t("memory.save.tooLarge", { kb: MAX_SAVE_BYTES / 1024 }));
  if (hasKeyShape(text)) throw invalid(t("memory.save.secret"));
  const runId = applyFileEdits(
    root,
    { id: `memory:${rel}`, title: t("memory.save.title", { path: rel }) },
    [{ path: rel, content: text }],
    catalogVersion,
  );
  return { runId, sha256: sha256(text), warnings: memoryWarnings(text) };
}

/** One project's CLAUDE.md, checked the way the readiness audit does (`detect/audit.ts`). */
export function scanProject(root: string): MemoryProject {
  if (!existsSync(root)) return { cwd: root, status: "gone", folders: 0, local: false };
  const files = memoryFiles(root).filter((f) => f.kind !== "user");
  const file = files.find((f) => f.kind === "project");
  const folders = files.filter((f) => f.kind === "folder").length;
  const local = files.some((f) => f.kind === "local");
  const base = { cwd: root, folders, local, ...(file?.exists ? { file } : {}) };
  if (!file?.exists) return { ...base, status: "missing" };
  if (file.refused) return { ...base, status: "refused" };
  let testCommand: string | undefined;
  try {
    testCommand = detectWorkspace(root)
      .packages.map((p) => p.commands.test?.run)
      .find(Boolean);
  } catch {
    testCommand = undefined;
  }
  const text = readFileSync(path.join(root, ...file.path.split("/")), "utf8");
  const status = file.lines > LONG_CLAUDE_MD ? "long" : testCommand && !text.includes(testCommand) ? "noTest" : "ok";
  return { ...base, status, ...(testCommand ? { testCommand } : {}) };
}

/** Every known project's CLAUDE.md, and the user's own, for the CLAUDE.md page. Only reads. */
export function scanMemory(workspaces: string[], configDir = claudeConfigDir()) {
  return { user: userMemory(configDir), projects: [...new Set(workspaces)].map(scanProject) };
}
