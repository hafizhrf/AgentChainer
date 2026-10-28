import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Hard denylist applied to every tool call through a PreToolUse hook, in every permission mode
 * (ARCHITECTURE §6). It sees calls that `canUseTool` never sees (rule- or mode-approved ones).
 *
 * This is defense in depth against obviously destructive or exfiltrating commands, not a sandbox:
 * a determined command can be written in ways these patterns don't catch.
 */

const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".config/gcloud", ".docker/config.json", ".netrc", ".claude/.credentials.json"];

const FILE_TOOLS: Record<string, string> = { Read: "file_path", Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path" };

export function checkToolCall(toolName: string, input: unknown, cwd: string, home = homedir()): string | null {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (toolName === "Bash" && typeof args.command === "string") return checkBash(args.command, cwd, home);
  const pathKey = FILE_TOOLS[toolName];
  const path = pathKey ? args[pathKey] : undefined;
  if (typeof path === "string" && isSecretPath(resolve(cwd, expandHome(path, home)), home)) {
    return "Credential files (SSH keys, cloud credentials, Claude login) are off-limits to the agent.";
  }
  return null;
}

export function checkBash(command: string, cwd: string, home = homedir()): string | null {
  if (/(^|[;&|(]\s*)sudo\b/.test(command)) {
    return "sudo needs a password prompt the app can't show. Run it yourself in a terminal if it's intended.";
  }
  if (/\b(curl|wget)\b[^;&|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(command)) {
    return "Piping a download straight into a shell runs unreviewed code.";
  }
  if (/\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    return "Force-pushing rewrites remote history. Push without --force, or do it yourself.";
  }
  if (/\bmkfs(\.\w+)?\b/.test(command) || /\bdd\b[^;&|]*\bof=\/dev\//.test(command)) {
    return "Formatting or writing raw disks is never done by the agent.";
  }
  if (
    /\b(vercel|netlify)\b[^;&|]*\s--prod\b/.test(command) ||
    /\b(firebase|fly|flyctl)\s+deploy\b/.test(command) ||
    /\bwrangler\s+deploy\b(?![^;&|]*--dry-run)/.test(command) ||
    /\bterraform\s+(apply|destroy)\b/.test(command) ||
    /\bkubectl\s+delete\b/.test(command)
  ) {
    return "Production deploys and infrastructure changes need an explicit human step (deploy flow arrives in M6).";
  }
  for (const target of recursiveRmTargets(command)) {
    const abs = resolve(cwd, expandHome(target, home));
    if (target === "/" || target === "/*" || abs === home || !isInside(abs, cwd)) {
      return `Recursive delete outside the workspace (${target}) is blocked.`;
    }
  }
  if (secretPathMentioned(command, home)) {
    return "Credential files (SSH keys, cloud credentials, Claude login) are off-limits to the agent.";
  }
  return null;
}

/** Targets of every `rm` invocation that has a recursive flag. Quotes are stripped; globs are kept as text. */
function recursiveRmTargets(command: string): string[] {
  const targets: string[] = [];
  for (const match of command.matchAll(/(?:^|[;&|(]\s*|\s)rm\s+([^;&|]*)/g)) {
    const tokens = (match[1] ?? "").trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
    const recursive = tokens.some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === "--recursive");
    if (recursive) targets.push(...tokens.filter((t) => t && !t.startsWith("-")));
  }
  return targets;
}

function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=$|\/)/, home).replace(/^\$\{?HOME\}?(?=$|\/)/, home);
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSecretPath(path: string, home: string): boolean {
  return SECRET_DIRS.some((dir) => isInside(path, resolve(home, dir)));
}

function secretPathMentioned(command: string, home: string): boolean {
  const prefixes = ["~/", "$HOME/", "${HOME}/", `${home}/`];
  return SECRET_DIRS.some((dir) => prefixes.some((p) => command.includes(`${p}${dir}`)));
}
