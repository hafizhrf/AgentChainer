import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/**
 * Hard denylist applied to every tool call through a PreToolUse hook, in every permission mode
 * (ARCHITECTURE §6). It sees calls that `canUseTool` never sees (rule- or mode-approved ones).
 *
 * This is defense in depth against obviously destructive or exfiltrating commands, not a sandbox:
 * a determined command can be written in ways these patterns don't catch.
 */

const SECRET_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".config/gcloud",
  ".docker/config.json",
  ".netrc",
  ".claude/.credentials.json",
];

const FILE_TOOLS: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  NotebookEdit: "notebook_path",
};

/** `roots`: a multi-folder workspace's other folders (M8-01), where a recursive delete is as allowed as in `cwd`. */
export function checkToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
  home = homedir(),
  roots: string[] = [],
): string | null {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (toolName === "Bash" && typeof args.command === "string") return checkBash(args.command, cwd, home, roots);
  const pathKey = FILE_TOOLS[toolName];
  const path = pathKey ? args[pathKey] : undefined;
  if (typeof path === "string" && isSecretPath(resolve(cwd, expandHome(path, home)), home)) {
    return "Credential files (SSH keys, cloud credentials, Claude login) are off-limits to the agent.";
  }
  return null;
}

export function checkBash(command: string, cwd: string, home = homedir(), roots: string[] = []): string | null {
  if (/(^|[;&|(]\s*)sudo\b/.test(command)) {
    return "sudo needs a password prompt the app can't show. Run it yourself in a terminal if it's intended.";
  }
  if (/\b(curl|wget)\b[^;&|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/.test(command)) {
    return "Piping a download straight into a shell runs unreviewed code.";
  }
  if (/\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(command)) {
    return "Force-pushing rewrites remote history. Push without --force, or do it yourself.";
  }
  // Human-only operations (M5-05): merging, releases and tags are a person's call, and so is writing through the API.
  if (/\bgh\s+pr\s+merge\b/.test(command) || /\bgh\s+release\b/.test(command)) {
    return "Merging pull requests and making releases are a person's decision. Use the task page's Merge, or do it yourself.";
  }
  if (
    /\bgh\s+api\b/.test(command) &&
    /\s(-X|--method)[=\s]*["']?(POST|PUT|PATCH|DELETE)\b|\s(-f|-F|--field|--raw-field|--input)[=\s]/i.test(command)
  ) {
    return "Changing things on GitHub through `gh api` is a person's decision. Reading with `gh api` is fine.";
  }
  if (
    /\bgit\s+tag\b(?![^;&|]*\s(-l|--list|-v|--verify|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged)\b)[^;&|]*\s[^\s;&|-]/.test(
      command,
    ) ||
    /\bgit\s+tag\s+(-a|-s|-d|-f|--delete|--force|--annotate|--sign)\b/.test(command) ||
    /\bgit\s+push\b[^;&|]*(\s--tags\b|\s--follow-tags\b|\srefs\/tags\/|\s--delete\b|\s:\S)/.test(command)
  ) {
    return "Release tags, and pushes that delete refs, are a person's decision. Do it yourself if it's intended.";
  }
  if (/\bmkfs(\.\w+)?\b/.test(command) || /\bdd\b[^;&|]*\bof=\/dev\//.test(command)) {
    return "Formatting or writing raw disks is never done by the agent.";
  }
  if (
    /\b(vercel|netlify)\b[^;&|]*\s--prod\b/.test(command) ||
    /\b(firebase|fly|flyctl)\s+deploy\b/.test(command) ||
    /\bwrangler\s+deploy\b(?![^;&|]*--dry-run)/.test(command) ||
    // Rollbacks and promotions change production too.
    /\b(vercel|wrangler)\s+(rollback|promote)\b/.test(command) ||
    /\bwrangler\s+versions\s+deploy\b/.test(command) ||
    /\bfirebase\s+hosting:clone\b/.test(command) ||
    // Pushing an image publishes it to a registry, where deploys pull it from.
    /\bdocker\s+(image\s+)?push\b/.test(command) ||
    /\bdocker\s+buildx\s+build\b[^;&|]*\s--push\b/.test(command) ||
    /\bdocker\s+buildx\s+imagetools\s+create\b/.test(command) ||
    /\bterraform\s+(apply|destroy)\b/.test(command) ||
    /\bkubectl\s+delete\b/.test(command)
  ) {
    return "Production deploys and infrastructure changes are a person's decision. Deploy from the task page or the workspace's Deploy page.";
  }
  for (const target of recursiveRmTargets(command)) {
    const abs = resolve(cwd, expandHome(target, home));
    if (target === "/" || target === "/*" || abs === home || ![cwd, ...roots].some((root) => isInside(abs, root))) {
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
    const tokens = (match[1] ?? "")
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^["']|["']$/g, ""));
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

/** `path` with links resolved, as far as it exists: a file that isn't there yet resolves through its folder. */
function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrSelf(parent), basename(path));
  }
}

/**
 * Whether a read-only tool's path stays inside one of `roots` (the workspace and its other folders). `~` is expanded
 * as the CLI does, links are followed to where they really point, and a network or device path (`\\server\share`,
 * `//server/share`) never counts as inside. A Glob pattern counts by its fixed part, before the first wildcard.
 */
export function readsInside(target: string, roots: string[], home = homedir()): boolean {
  if (/^(\\\\|\/\/)/.test(target)) return false;
  const fixed = target.split(/[*?[{]/)[0] ?? "";
  const full = resolve(roots[0] ?? ".", expandHome(fixed || ".", home));
  const real = realOrSelf(full);
  return roots.some((root) => isInside(real, realOrSelf(resolve(root))));
}

function isSecretPath(path: string, home: string): boolean {
  return SECRET_DIRS.some((dir) => isInside(path, resolve(home, dir)));
}

function secretPathMentioned(command: string, home: string): boolean {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the literal shell text `${HOME}/` in a command.
  const prefixes = ["~/", "$HOME/", "${HOME}/", `${home}/`];
  return SECRET_DIRS.some((dir) => prefixes.some((p) => command.includes(`${p}${dir}`)));
}

/** How a guard denial reads in a tool's result: what the transcript and a task's evidence look for. */
export const GUARD_PREFIX = "Blocked by AgentChainer guard: ";

/** The tools a read-only session gets: it can look, not change. */
export const READ_TOOLS = ["Read", "Grep", "Glob"];

/**
 * The PreToolUse hook of a read-only session (a task's plan or review step): the denylist, then Read, Grep and Glob
 * inside `root`, and nothing else. Structured output arrives through a tool of its own, which is allowed.
 */
export function readOnlyHook(root: string, who: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });
    if (input.tool_name === "StructuredOutput") return {};
    const guard = checkToolCall(input.tool_name, input.tool_input, input.cwd);
    if (guard) return deny(`Blocked by AgentChainer guard: ${guard}`);
    if (!READ_TOOLS.includes(input.tool_name)) return deny(`${who} can only read files, not use ${input.tool_name}.`);
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    // Glob's `pattern` is a path; Grep's is what to search for.
    const pattern = input.tool_name === "Glob" ? args.pattern : undefined;
    for (const target of [args.file_path, args.path, pattern]) {
      if (typeof target === "string" && target && !readsInside(target, [root])) {
        return deny(`${who} can only read inside the workspace.`);
      }
    }
    return {};
  };
}
