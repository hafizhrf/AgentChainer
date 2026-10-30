/**
 * What an approval is about, in plain words (UX-05): the command or file it touches, Claude's own one-line
 * explanation, and a risk level from fixed rules. Deterministic on purpose: no model call, the same request always
 * reads the same way. The guard (sidecar `guard.ts`) still blocks the worst commands outright; this only helps the
 * user decide on the rest.
 */

export type RiskLevel = "low" | "medium" | "high";
export type Risk = { level: RiskLevel; reasons: string[] };

export type Described =
  | { kind: "command"; command: string; explanation: string | null; risk: Risk }
  | { kind: "edit"; path: string; risk: Risk }
  | { kind: "read"; target: string; risk: Risk }
  | { kind: "web"; target: string; risk: Risk }
  | { kind: "mcp"; server: string; tool: string; risk: Risk }
  | { kind: "other"; risk: Risk };

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

type Rule = { level: RiskLevel; test: RegExp; reason: string };

/** Rules for one simple command (no `&&`, `;` or `|`), most severe first. */
const RULES: Rule[] = [
  {
    level: "high",
    test: /^rm\s+(.*\s)?(-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b/,
    reason: "Deletes files recursively or without asking",
  },
  { level: "high", test: /^find\b.*\s-delete\b/, reason: "Deletes every file it finds" },
  { level: "high", test: /^git\s+clean\b/, reason: "Removes untracked files for good" },
  { level: "high", test: /^git\s+push\b/, reason: "Publishes commits to a remote" },
  { level: "high", test: /^git\s+reset\b.*--hard\b/, reason: "Throws away uncommitted changes" },
  { level: "high", test: /^git\s+(rebase|filter-branch|filter-repo)\b/, reason: "Rewrites git history" },
  { level: "high", test: /^(chmod|chown)\b.*\s-R\b/, reason: "Changes permissions recursively" },
  { level: "high", test: /^(kill|killall|pkill)\b/, reason: "Stops running processes" },
  {
    level: "high",
    test: /^curl\b.*(\s(-d|--data\S*|-F|--form|-T|--upload-file)\b|\s-X\s*(POST|PUT|PATCH|DELETE)\b)/i,
    reason: "Sends data over the internet",
  },
  { level: "high", test: /^(ssh|scp|sftp)\b/, reason: "Connects to another machine" },
  { level: "high", test: /^rsync\b.*\S+:\S*/, reason: "Copies files to or from another machine" },
  { level: "high", test: /^((npm|pnpm|yarn)\s+publish|cargo\s+publish)\b/, reason: "Publishes a package" },
  { level: "high", test: /^docker\s+(rm|rmi|volume\s+rm|system\s+prune)\b/, reason: "Deletes Docker data" },
  {
    level: "medium",
    test: /^((npm|pnpm|yarn|bun)\s+(add|install|i|ci)|pip3?\s+install|cargo\s+(add|install)|brew\s+install|go\s+(get|install)|gem\s+install)\b/,
    reason: "Installs packages from the internet",
  },
  { level: "medium", test: /^(npx|bunx|pnpm\s+dlx|yarn\s+dlx)\b/, reason: "Downloads and runs a package" },
  { level: "medium", test: /^(curl|wget)\b/, reason: "Reaches the internet" },
  { level: "medium", test: /^git\s+(clone|fetch|pull)\b/, reason: "Downloads from a git remote" },
  {
    level: "medium",
    test: /^((npm|pnpm|yarn|bun)\s+(?!(add|install|i|ci|publish|dlx)\b)[\w:-]+|make|cargo\s+(run|test|build|check|clippy|fmt)|go\s+(run|test|build|vet)|python3?|node|deno|tsx|pytest|jest|vitest)\b/,
    reason: "Runs code from this project",
  },
  { level: "medium", test: /(^|\s)>>?\s*(?!\/dev\/null\b)\S/, reason: "Writes to a file" },
  { level: "medium", test: /^(tee|mv|cp|mkdir|touch|ln|rm|sed\s+(.*\s)?-i)\b/, reason: "Changes files" },
  {
    level: "medium",
    test: /^git\s+(commit|checkout|switch|merge|stash|restore|add|tag|branch\s+-[dD])\b/,
    reason: "Changes the git repository",
  },
  { level: "medium", test: /^find\b.*\s-exec\b/, reason: "Runs a command on every file it finds" },
  { level: "medium", test: /(^|[\s/'"])\.env(\.[\w.-]+)?\b/, reason: "Touches an .env file, which may hold secrets" },
];

/** Commands that only read: listed so they aren't reported as unknown programs. */
const READ_ONLY =
  /^(cd|ls|cat|head|tail|less|grep|rg|find|pwd|echo|which|wc|file|stat|du|df|tree|diff|sort|uniq|cut|awk|sed|jq|date|whoami|uname|test|git\s+(status|diff|log|show|branch|rev-parse|blame|ls-files|remote))\b/;

const worst = (risks: Risk[]): Risk => {
  const level = risks.reduce<RiskLevel>((l, r) => (RANK[r.level] > RANK[l] ? r.level : l), "low");
  const reasons = [...new Set(risks.filter((r) => r.level === level).flatMap((r) => r.reasons))];
  return { level, reasons };
};

/** The risk of one simple command: its most severe matching rule. */
function partRisk(part: string): Risk {
  // Leading `VAR=value` assignments don't change what runs; a path to the program reads as its name.
  const cmd = part
    .replace(/^(\w+=\S*\s+)+/, "")
    .replace(/^\S*\//, "")
    .trim();
  const hits = RULES.filter((r) => r.test.test(cmd));
  if (hits.length) return worst(hits.map((h) => ({ level: h.level, reasons: [h.reason] })));
  if (READ_ONLY.test(cmd)) return { level: "low", reasons: ["Only reads"] };
  return {
    level: "medium",
    reasons: [`Runs ${cmd.split(/\s+/)[0] ?? "a program"}, which AgentChainer has no rule for`],
  };
}

/** The risk of a shell command: the worst of its parts (split on `&&`, `||`, `;` and pipes). */
export function commandRisk(command: string): Risk {
  const parts = command
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? worst(parts.map(partRisk)) : { level: "low", reasons: [] };
}

/** Whether `p` (absolute or relative) stays inside the workspace `cwd`. */
export function insideWorkspace(p: string, cwd: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = norm(p);
  const root = norm(cwd);
  const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.startsWith("~");
  const inside = absolute ? path === root || path.startsWith(`${root}/`) : true;
  const rel = absolute ? path.slice(root.length + 1) : path;
  return inside && !rel.split("/").includes("..");
}

/** A workspace path relative to `cwd`, or the path as given when it's outside. */
export function displayPath(p: string, cwd: string): string {
  const norm = p.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm.startsWith(`${root}/`) ? norm.slice(root.length + 1) : p;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Describes an approval request for the dialog. `defaultToNo` is Claude Code's own "this is risky" flag. */
export function describeRequest(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  defaultToNo = false,
): Described {
  const flagged = (risk: Risk): Risk =>
    defaultToNo ? { level: "high", reasons: ["Claude Code marks this one as risky", ...risk.reasons] } : risk;

  if (toolName === "Bash") {
    const command = str(input.command) ?? "";
    return { kind: "command", command, explanation: str(input.description), risk: flagged(commandRisk(command)) };
  }
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) {
    const file = str(input.file_path) ?? str(input.notebook_path) ?? "";
    const rel = displayPath(file, cwd);
    const risk: Risk = !insideWorkspace(file, cwd)
      ? { level: "high", reasons: ["Writes outside the workspace"] }
      : /(^|\/)\.env(\.[\w.-]+)?$/.test(rel)
        ? { level: "high", reasons: ["An .env file may hold secrets"] }
        : /(^|\/)\.git\//.test(rel)
          ? { level: "high", reasons: ["Inside git's own folder"] }
          : /^\.github\/workflows\//.test(rel)
            ? { level: "medium", reasons: ["Changes CI for everyone"] }
            : { level: "low", reasons: ["Changes a file in this workspace; you can rewind it"] };
    return { kind: "edit", path: rel, risk: flagged(risk) };
  }
  if (["Read", "Glob", "Grep", "LS"].includes(toolName)) {
    const target = str(input.file_path) ?? str(input.path) ?? str(input.pattern) ?? "";
    const outside = (str(input.file_path) ?? str(input.path)) !== null && !insideWorkspace(target, cwd);
    const risk: Risk = outside
      ? { level: "medium", reasons: ["Reads outside the workspace"] }
      : { level: "low", reasons: ["Only reads"] };
    return { kind: "read", target: displayPath(target, cwd), risk: flagged(risk) };
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    const target = str(input.url) ?? str(input.query) ?? "";
    return { kind: "web", target, risk: flagged({ level: "medium", reasons: ["Reaches the internet"] }) };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) {
    const [, server = "", tool = ""] = mcp;
    return {
      kind: "mcp",
      server,
      tool,
      risk: flagged({ level: "medium", reasons: [`Uses a tool from the ${server} MCP server`] }),
    };
  }
  return { kind: "other", risk: flagged({ level: "medium", reasons: ["Review the details before allowing"] }) };
}
