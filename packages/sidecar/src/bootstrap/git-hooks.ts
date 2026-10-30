import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { git, repoOf } from "../workspace.ts";
import { MARKER } from "./tools.ts";

/**
 * Pre-commit hooks for catalog items such as gitleaks (M2-22). A repo with a hook manager (lefthook, pre-commit,
 * husky) gets the hook in that manager's committed config, so the whole team runs it; the command is a small committed
 * wrapper that prefers the pinned copy in AgentChainer's tools folder, checked against its marker, then the tool on
 * PATH, and steps aside when neither is there. A repo without one gets a local `.git/hooks/pre-commit` for this machine
 * only, which checks the pinned copy the same way; an existing hook is never overwritten.
 */

/** The app identifier from tauri.conf.json: the tools folder is `<OS app data>/<APP_ID>/tools`. */
export const APP_ID = "io.github.hafizhrf.agentchainer";

/** Every hook file AgentChainer writes carries this line, so it can recognize its own. */
const MARK = "# Added by AgentChainer";

export type HookManager = "lefthook" | "pre-commit" | "husky" | "local";
export type HookSetup = { manager: HookManager } | { manager: null; reason: string };
export type HookSpec = { id: string; run: string[] };
export type HookFile = { path: string; before: string; after: string; executable?: boolean };

const LEFTHOOK = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"];
const PRE_COMMIT = ".pre-commit-config.yaml";
const LOCAL_HOOK = ".git/hooks/pre-commit";

const read = (root: string, rel: string) => {
  const file = path.join(root, ...rel.split("/"));
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

/** How a pre-commit hook can be added to this workspace, or why it can't. */
export function hookSetup(root: string): HookSetup {
  const repo = repoOf(root);
  if (!repo) return { manager: null, reason: "Not a git repository: initialize git first." };
  // The native realpath also expands Windows 8.3 short names (C:\Users\RUNNER~1), which git never prints.
  if (realpathSync.native(repo.top) !== realpathSync.native(root)) {
    return { manager: null, reason: "Open the repository's top folder to add commit hooks." };
  }
  if (LEFTHOOK.some((f) => existsSync(path.join(root, f)))) return { manager: "lefthook" };
  if (existsSync(path.join(root, PRE_COMMIT))) return { manager: "pre-commit" };
  if (existsSync(path.join(root, ".husky")) && statSync(path.join(root, ".husky")).isDirectory()) {
    return { manager: "husky" };
  }
  const hooksPath = git(["config", "--get", "core.hooksPath"], root).stdout.trim();
  if (hooksPath) {
    return {
      manager: null,
      reason: `Git uses its own hooks folder here (core.hooksPath = ${hooksPath}): add the hook there yourself.`,
    };
  }
  // Worktrees and submodules keep hooks outside the workspace; a local hook belongs to the repository's own .git.
  const hooks = path.resolve(root, git(["rev-parse", "--git-path", "hooks"], root).stdout.trim());
  if (hooks !== path.join(path.resolve(root), ".git", "hooks")) {
    return { manager: null, reason: "This repository's hooks live outside the workspace (a worktree or submodule?)." };
  }
  const existing = read(root, LOCAL_HOOK);
  if (existing && !existing.includes(MARK)) {
    return {
      manager: null,
      reason:
        "There's already a pre-commit hook in .git/hooks. Add the command to it, or use a hook manager such as lefthook.",
    };
  }
  return { manager: "local" };
}

/** Committed managers share the config, so their scope is the project; a local hook is private. */
export const hookScope = (manager: HookManager): "project" | "local" => (manager === "local" ? "local" : "project");

/**
 * The exact file changes that add `hook` for `manager`. `binary` is the tool's path in the app's tools folder
 * (`{binary}` in `hook.run`); `tool` is its item id and command name. The plan shows these; apply writes them.
 */
export function hookChanges(
  root: string,
  manager: HookManager,
  hook: HookSpec,
  tool: { id: string; name: string; version: string; binary: string },
): HookFile[] {
  if (manager === "local") {
    const before = read(root, LOCAL_HOOK);
    const after = [
      "#!/bin/sh",
      `${MARK}: ${tool.name} ${tool.version} checks staged changes before each commit (this machine only).`,
      `bin=${shQuote(tool.binary.replaceAll("\\", "/"))}`,
      ...verifyPinned(tool),
      `exec "$bin" ${toolArgs(hook)}`,
      "",
    ].join("\n");
    return [{ path: LOCAL_HOOK, before, after, executable: true }];
  }

  const script = `.agentchainer/hooks/${hook.id}.sh`;
  const command = `sh ${script}`;
  const files: HookFile[] = [
    { path: script, before: read(root, script), after: wrapperScript(hook, tool), executable: true },
  ];
  if (manager === "husky") {
    const file = ".husky/pre-commit";
    const before = read(root, file);
    const after = before.split("\n").includes(command)
      ? before
      : `${before}${before && !before.endsWith("\n") ? "\n" : ""}${command}\n`;
    files.push({ path: file, before, after, executable: true });
    return files;
  }

  const file =
    manager === "lefthook" ? (LEFTHOOK.find((f) => existsSync(path.join(root, f))) ?? LEFTHOOK[0]) : PRE_COMMIT;
  const before = read(root, file ?? PRE_COMMIT);
  const parsed = parseDocument(before);
  if (parsed.errors.length) throw new Error(`${file} isn't valid YAML: ${parsed.errors[0]?.message ?? ""}`);
  // An empty (or comment-only) config starts from a fresh document.
  const doc: Document = isMap(parsed.contents) ? parsed : new Document(manager === "lefthook" ? {} : { repos: [] });
  if (manager === "lefthook") {
    doc.setIn(["pre-commit", "commands", hook.id, "run"], command);
  } else {
    let repos = doc.get("repos");
    if (!isSeq(repos)) {
      doc.set("repos", doc.createNode([]));
      repos = doc.get("repos");
    }
    const present = JSON.stringify(doc.toJS()).includes(`"id":"${hook.id}"`);
    if (!present && isSeq(repos)) {
      repos.add(
        doc.createNode({
          repo: "local",
          hooks: [
            {
              id: hook.id,
              name: `${tool.name} (AgentChainer)`,
              entry: command,
              language: "system",
              pass_filenames: false,
            },
          ],
        }),
      );
    }
  }
  files.push({ path: file ?? PRE_COMMIT, before, after: doc.toString() });
  return files;
}

/** The hook's arguments after `{binary}`, quoted for sh. */
const toolArgs = (hook: HookSpec) =>
  hook.run
    .slice(hook.run[0] === "{binary}" ? 1 : 0)
    .map(shQuote)
    .join(" ");

/**
 * sh lines that stop the commit unless `$bin` matches the sha256 its install recorded in the marker next to it, so a
 * changed or damaged copy never runs (M2-30). `sha256sum` (Linux, Git Bash) or `shasum` (macOS) reads it from stdin.
 */
function verifyPinned(tool: { name: string; version: string }): string[] {
  const reinstall = `Reinstall it from AgentChainer's workspace settings, or remove this hook.`;
  return [
    `want=$(sed -n 's/.*"binarySha256": *"\\([0-9a-f]*\\)".*/\\1/p' "$(dirname "$bin")/${MARKER}" 2>/dev/null)`,
    `if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum < "$bin" 2>/dev/null); else got=$(shasum -a 256 < "$bin" 2>/dev/null); fi`,
    `if [ -z "$want" ] || [ "\${got%% *}" != "$want" ]; then`,
    `  echo "AgentChainer's ${tool.name} ${tool.version} ($bin) failed its hash check, so this commit was stopped. ${reinstall}" >&2`,
    "  exit 1",
    "fi",
  ];
}

/**
 * The committed hook script: AgentChainer's pinned copy (macOS, Linux and Windows app data folders), checked against
 * its marker; else the tool from PATH; else a hint and success, so a teammate without the tool can still commit.
 */
function wrapperScript(hook: HookSpec, tool: { id: string; name: string; version: string }): string {
  const exe = `tools/${tool.id}/${tool.version}/${tool.name}`;
  return `#!/bin/sh
${MARK}: runs ${tool.name} before each commit (pinned ${tool.version} in AgentChainer's tools folder).
# Uses AgentChainer's pinned copy, checked against its recorded sha256 (a copy that fails the check stops the commit),
# else ${tool.name} from PATH. Without either, it only prints a hint, so it never blocks a commit.
bin=
appdata=\${APPDATA:-}
if [ -n "$appdata" ] && command -v cygpath >/dev/null 2>&1; then appdata=$(cygpath -u "$appdata"); fi
for dir in "$HOME/Library/Application Support" "\${XDG_DATA_HOME:-$HOME/.local/share}" "$appdata"; do
  for f in "$dir"/${APP_ID}/${exe} "$dir"/${APP_ID}/${exe}.exe; do
    if [ -f "$f" ]; then bin=$f; fi
  done
done
if [ -n "$bin" ]; then
${verifyPinned(tool)
  .map((l) => `  ${l}`)
  .join("\n")}
else
  bin=$(command -v ${tool.name} 2>/dev/null)
fi
if [ -z "$bin" ]; then
  echo "${tool.name} isn't installed, so this commit wasn't checked. Install it from AgentChainer or your package manager." >&2
  exit 0
fi
exec "$bin" ${toolArgs(hook)}
`;
}

/** Quotes an argument for sh when it needs it. */
function shQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}
