import { z } from "zod";
import { currentLocale } from "./i18n.ts";
import { t } from "./messages.ts";

/**
 * Contract between the UI (via the Rust relay) and the sidecar, as zod schemas (checklist M1-02).
 * - The sidecar validates every request's params and its own results.
 * - The UI validates every notification and result it receives.
 * - TypeScript types are inferred from the schemas, so the two can't drift.
 * - `schema/protocol.schema.json` is the JSON Schema export (`pnpm --filter @agentchainer/protocol export-schema`).
 * - The Rust core only relays frames (ADR-0003), so it needs no generated types.
 *
 * `PROTOCOL_VERSION` is exchanged in `system.hello`; see docs/ARCHITECTURE.md §4.
 */
export const PROTOCOL_VERSION = 2;

/* ---------- JSON-RPC envelope ---------- */

export type RpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
export type RpcError = { code: number; message: string };
export type RpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: RpcError };
/** `ts` (sidecar send time, epoch ms) is only present when AGENTCHAINER_METRICS=1, for latency measurement (spike S2). */
export type RpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown; ts?: number };
export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

/** JSON-RPC error codes used by the sidecar. */
export const RpcErrorCode = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  noSession: -32001,
  claudeNotFound: -32002,
  noPendingPermission: -32003,
  sdkUnavailable: -32004,
  protocolMismatch: -32005,
  /** The session is already open in another tab, or is open and can't be deleted. */
  sessionOpen: -32006,
  /** The user stopped the operation (`task.cancel`). */
  cancelled: -32007,
} as const;

/* ---------- Shared shapes ---------- */

/**
 * Permission modes the app offers. `bypassPermissions` is deliberately excluded. `auto` lets Claude's
 * classifier approve or deny each call and only asks when unsure; our PreToolUse guard still applies.
 * Profiles (Safe/Standard/Autonomous, ARCHITECTURE §6) arrive in M1-18.
 */
export const PermissionModeSchema = z.enum(["default", "acceptEdits", "auto", "plan"]);
export const PERMISSION_MODES = PermissionModeSchema.options;
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * Where an "Always allow" rule is saved (UX-05): this session only, the workspace for this user
 * (`.claude/settings.local.json`, not committed), or the workspace for the whole team (`.claude/settings.json`).
 */
export const AlwaysScopeSchema = z.enum(["session", "workspace", "team"]);
export type AlwaysScope = z.infer<typeof AlwaysScopeSchema>;
/**
 * Where a rule is kept; session rules aren't stored. A workspace has two files (just you, the team); `user` is the
 * CLI's own user settings (`~/.claude/settings.json`), which every project reads (UX-19, ADR-0013).
 */
export const RuleScopeSchema = z.enum(["workspace", "team", "user"]);
export type RuleScope = z.infer<typeof RuleScopeSchema>;
const RulesSchema = z.object({ allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()) });
/**
 * A permission rule as Claude Code writes it: `Tool` or `Tool(content)`, e.g. `Bash(npm test:*)`, `Edit(src/**)`,
 * `mcp__github__get_issue`. Kept short and on one line.
 */
export const PermissionRuleTextSchema = z
  .string()
  .max(300)
  .regex(/^[A-Za-z][\w-]*(?:\([^\n()]*(?:\([^\n()]*\)[^\n()]*)*\))?$/);
/** Where a plugin is installed: this workspace for you (`local`), for the team (`project`), or every project (`user`). */
export const PluginInstallScopeSchema = z.enum(["local", "project", "user"]);

/** An agent's name, which is also its file name in `.claude/agents/` (M4-06). */
export const AgentNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: () => t("protocol.agent.nameFormat") });

/** Where an agent lives: the project's `.claude/agents/`, or the user's `~/.claude/agents/` (both editable, M8-04). */
export const AgentScopeSchema = z.enum(["project", "user"]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

/** A subagent definition: `.claude/agents/<name>.md` in the project, or the user's `~/.claude/agents` (M4-06). */
export const AgentDefinitionSchema = z.object({
  name: z.string(),
  scope: AgentScopeSchema,
  /** Where it lives, for display: `.claude/agents/x.md` or `~/.claude/agents/x.md`. */
  file: z.string(),
  description: z.string(),
  tools: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string(),
  /** Its description asks Claude to use it on its own ("use proactively"); otherwise it runs when asked for. */
  auto: z.boolean(),
  /** One of AgentChainer's task roles (M3-05), which the setup plan installs. */
  role: z.boolean(),
  /** Why the file couldn't be read as an agent; the other fields are then empty. */
  error: z.string().optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const AgentInputSchema = z.object({
  name: AgentNameSchema,
  description: z.string().trim().min(1).max(2000),
  /** Comma-separated tool names; omitted for all tools. */
  tools: z.string().trim().max(1000).optional(),
  /** `inherit`, an alias (`haiku`, `sonnet`, `opus`) or a model id; omitted for the default. */
  model: z
    .string()
    .trim()
    .regex(/^[\w.[\]-]{1,100}$/)
    .optional(),
  prompt: z.string().trim().min(1).max(100_000),
  auto: z.boolean(),
  /** Where it's saved (M8-04); the project when omitted. */
  scope: AgentScopeSchema.optional(),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

/**
 * The CLI's built-in tools an agent profile may list (M8-04), grouped as the tool picker shows them. When the app runs
 * a profile, only the tools it lists are available.
 */
export const KNOWN_TOOLS = {
  read: ["Read", "Grep", "Glob"],
  edit: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
  shell: ["Bash", "BashOutput", "KillShell"],
  web: ["WebFetch", "WebSearch"],
  other: ["TodoWrite", "Agent", "Task", "Skill", "AskUserQuestion"],
} as const;
const BUILT_IN_TOOLS = new Set<string>(Object.values(KNOWN_TOOLS).flat());

/** An MCP server's tools in a profile: `mcp__server`, `mcp__server__*` or `mcp__server__tool`. */
export const MCP_TOOL_ENTRY = /^mcp__[A-Za-z0-9_-]+(__(\*|[A-Za-z0-9_-]+))?$/;

/** A profile's `tools` field as a list; empty when it lists none, which means every tool. */
export const toolList = (tools: string | undefined): string[] =>
  (tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** Model aliases a profile may name, besides a full `claude-…` id. */
export const AGENT_MODELS = ["inherit", "haiku", "sonnet", "opus", "fable"] as const;

/**
 * What's wrong with an agent before it's saved (M8-04): the form shows these live, and the sidecar checks again.
 * `taken` are the other agents' names in the same scope.
 */
export function agentProblems(
  agent: { name: string; description: string; tools?: string | undefined; model?: string | undefined; prompt: string },
  taken: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const name = AgentNameSchema.safeParse(agent.name);
  if (!name.success)
    problems.push(
      t("protocol.agent.name", { problem: name.error.issues[0]?.message ?? t("protocol.agent.notValidName") }),
    );
  else if (taken.includes(agent.name)) problems.push(t("protocol.agent.nameTaken", { name: agent.name }));
  if (!agent.description.trim()) problems.push(t("protocol.agent.descriptionMissing"));
  else if (agent.description.length > 2000) problems.push(t("protocol.agent.descriptionLong"));
  if (!agent.prompt.trim()) problems.push(t("protocol.agent.promptMissing"));
  else if (agent.prompt.length > 100_000) problems.push(t("protocol.agent.promptLong"));
  const model = agent.model?.trim();
  if (model && !(AGENT_MODELS as readonly string[]).includes(model) && !/^claude-[a-z0-9.-]+(\[1m\])?$/.test(model)) {
    problems.push(t("protocol.agent.modelUnknown", { model }));
  }
  const tools = toolList(agent.tools);
  const unknown = tools.filter((t) => !BUILT_IN_TOOLS.has(t) && !MCP_TOOL_ENTRY.test(t));
  if (unknown.length)
    problems.push(t("protocol.agent.toolsUnknown", { count: unknown.length, tools: unknown.join(", ") }));
  const repeated = tools.filter((tool, i) => tools.indexOf(tool) !== i);
  if (repeated.length) problems.push(t("protocol.agent.toolsRepeated", { tools: [...new Set(repeated)].join(", ") }));
  return problems;
}

/** What in a finished run a lesson comes from (M8-06). */
export const LessonSourceSchema = z.enum(["gate", "format", "review", "guard", "approval", "notes"]);
export type LessonSource = z.infer<typeof LessonSourceSchema>;

/**
 * A text the sidecar wrote into a task's results, and how to show it in another language (X-13 part 2b): a key of
 * the results catalog (`results/`) and its values, which may be such texts in turn. Stored next to the English text,
 * which stays what pull requests, evidence and Claude get.
 */
export type MessageRef = { key: string; params?: Record<string, string | number | MessageRef> | undefined };
export const MessageRefSchema: z.ZodType<MessageRef> = z.lazy(() =>
  z.object({
    key: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number(), MessageRefSchema])).optional(),
  }),
);

/**
 * A suggested CLAUDE.md line from a finished task (M8-06, docs/design/lessons.md), with the run's records it comes
 * from. Nothing is written until the person approves it.
 */
export const LessonSchema = z.object({
  id: z.string(),
  text: z.string(),
  why: z.string(),
  sources: z.array(
    z.object({ source: LessonSourceSchema, ref: z.string(), text: z.string(), textRef: MessageRefSchema.optional() }),
  ),
});
export type Lesson = z.infer<typeof LessonSchema>;

/** A starting point for a new agent (M8-04): a shipped task role or a bundled starter. Nothing is saved from it. */
export const AgentTemplateSchema = z.object({
  id: z.string(),
  source: z.enum(["role", "starter"]),
  name: z.string(),
  description: z.string(),
  tools: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string(),
});
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

/** Wording that asks Claude to start an agent on its own, as the CLI's docs suggest ("use proactively", M4-06). */
const AUTO_AGENT = /\bproactively\b|\bMUST BE USED\b/i;
export const isAutoAgent = (description: string) => AUTO_AGENT.test(description);

/** Adds or removes the "use proactively" wording, so the description says whether Claude may start it on its own. */
export function withAutoWording(description: string, auto: boolean): string {
  const text = description.trim();
  if (auto === isAutoAgent(text)) return text;
  if (auto) return `${text}${/[.!?]$/.test(text) ? "" : "."} Use proactively.`;
  const kept = text.split(/(?<=[.!?])\s+/).filter((s) => !isAutoAgent(s));
  // A description that is one long sentence keeps its words, without the wording itself.
  return kept.length
    ? kept.join(" ")
    : text
        .replace(/[,;]?\s*\b(use|invoke)\b[^.,;]*\bproactively\b/gi, "")
        .replace(AUTO_AGENT, "")
        .trim();
}

/** How hard Claude thinks (the SDK's `effort`, M1-15). Unset means the CLI's default for the model. */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const EFFORTS = EffortSchema.options;
export type Effort = z.infer<typeof EffortSchema>;

/**
 * Only the fields ADR-0002 allows us to read from `claude auth status --json`:
 * - `method`: "claude.ai" | "api_key" | "third_party" | "none" | …
 * - `provider`: "firstParty" | "bedrock" | "vertex" | "foundry" | …
 */
export const AuthStateSchema = z.object({ loggedIn: z.boolean(), method: z.string(), provider: z.string() });
export type AuthState = z.infer<typeof AuthStateSchema>;

export const EnvCheckSchema = z.object({
  platform: z.string(),
  node: z.string(),
  claude: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
    minVersion: z.string(),
    versionOk: z.boolean(),
  }),
  /** null when the CLI is missing or its status can't be read. */
  auth: AuthStateSchema.nullable(),
  git: z.object({ version: z.string().nullable() }),
  /** True when a session can start: CLI found, version OK, signed in, git present. */
  ready: z.boolean(),
});
export type EnvCheck = z.infer<typeof EnvCheckSchema>;

const Empty = z.object({});
const Ok = z.object({ ok: z.literal(true) });

export const SessionIdSchema = z.uuid();

/** An image attached to a user message. ~5 MB of image data at most, the API's per-image limit (verify). */
export const ImageSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: z.string().max(7_000_000),
});
export type Image = z.infer<typeof ImageSchema>;
/** A live session, open in a tab. */
const SessionRef = z.object({ sessionId: SessionIdSchema });
/** A session on disk; `cwd` lets the SDK look in that project only instead of scanning every project. */
const StoredSessionRef = z.object({ cwd: z.string().min(1), sessionId: SessionIdSchema });

/** Metadata from the SDK's `listSessions` (ADR-0004: we never read the transcript files ourselves). */
export const SessionInfoSchema = z.object({
  sessionId: SessionIdSchema,
  /** Custom title, the CLI's summary, or the first prompt. */
  title: z.string(),
  lastModified: z.number(),
  createdAt: z.number().optional(),
  gitBranch: z.string().optional(),
  tag: z.string().optional(),
  /** Which agent's history it's in (M9-09); absent is Claude's. */
  agent: z.enum(["claude", "codex", "agy"]).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const RewindResultSchema = z.object({
  canRewind: z.boolean(),
  error: z.string().optional(),
  filesChanged: z.array(z.string()),
  insertions: z.number(),
  deletions: z.number(),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;

/** Git status of a file, simplified from `git status --porcelain` (M1-25). */
export const FileStatusSchema = z.enum(["modified", "added", "deleted", "renamed", "untracked", "conflicted"]);
export type FileStatus = z.infer<typeof FileStatusSchema>;

/** `path` is relative to the workspace, with `/` separators. Files without changes have no `status`. */
export const WorkspaceFileSchema = z.object({
  path: z.string(),
  status: FileStatusSchema.optional(),
  /** Some of the change is staged. */
  staged: z.boolean().optional(),
  /** Some of the change (or the whole file, if untracked) is not staged. */
  unstaged: z.boolean().optional(),
  /** The old path of a rename. */
  origPath: z.string().optional(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

export const WorkspaceFilesSchema = z.object({
  isGitRepo: z.boolean(),
  /** Current branch; "detached at <sha>"; null outside git or before the first commit on a detached HEAD. */
  branch: z.string().nullable(),
  files: z.array(WorkspaceFileSchema),
  /** The listing hit its cap. */
  truncated: z.boolean(),
});
export type WorkspaceFiles = z.infer<typeof WorkspaceFilesSchema>;

export const HunkSchema = z.object({
  header: z.string(),
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
});
export type Hunk = z.infer<typeof HunkSchema>;

/** HEAD vs working tree. Contents are null when absent on that side, binary, or too large to diff. */
export const FileDiffSchema = z.object({
  path: z.string(),
  status: FileStatusSchema.optional(),
  original: z.string().nullable(),
  modified: z.string().nullable(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  /** In the order of `git diff -U0`; `workspace.revert` takes an index into this list. */
  hunks: z.array(HunkSchema),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

/** Images the file viewer shows as pictures (UX-21), by extension. SVG is shown as an image, never run as a page. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

/** The media type of an image path the viewer shows, or null. */
export function imageType(path: string): string | null {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && IMAGE_TYPES[ext]) ?? null;
}

/** A workspace image for the file viewer (UX-21): its bytes as base64, unless it's over the cap. */
export const WorkspaceImageSchema = z.object({
  mediaType: z.string(),
  bytes: z.number().int().min(0),
  data: z.string().nullable(),
  tooLarge: z.boolean(),
});
export type WorkspaceImage = z.infer<typeof WorkspaceImageSchema>;

/* ---------- Workspace profile and readiness (M2-06…M2-10) ---------- */

export const COMMAND_KINDS = ["install", "build", "lint", "format", "typecheck", "test", "dev"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** A discovered command: what to run, where it came from (e.g. `package.json#scripts.test`) and how sure we are. */
export const DetectedCommandSchema = z.object({
  run: z.string(),
  source: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type DetectedCommand = z.infer<typeof DetectedCommandSchema>;

export const PackageProfileSchema = z.object({
  /** Relative to the workspace, `/`-separated; "." for the root. */
  path: z.string(),
  name: z.string().optional(),
  stack: z.enum(["node", "python", "flutter", "dart", "go", "rust"]),
  /** npm, pnpm, yarn, bun, uv, poetry, pip, pub, go, cargo. */
  packageManager: z.string(),
  frameworks: z.array(z.string()),
  testFrameworks: z.array(z.string()),
  commands: z.object(Object.fromEntries(COMMAND_KINDS.map((k) => [k, DetectedCommandSchema.optional()]))) as z.ZodType<
    Partial<Record<CommandKind, DetectedCommand>>
  >,
});
export type PackageProfile = z.infer<typeof PackageProfileSchema>;

/** What a workspace is made of. Paths are relative, so the profile can be shared (`.agentchainer/profile.json`). */
export const WorkspaceProfileSchema = z.object({
  stacks: z.array(z.string()),
  /** pnpm-workspace, npm-workspaces, yarn-workspaces, go-work, cargo-workspace, or "multiple" (no workspace tool). */
  monorepo: z.string().nullable(),
  packages: z.array(PackageProfileSchema),
  /** github-actions, gitlab-ci, … */
  ci: z.array(z.string()),
});
export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

/**
 * One readiness finding (M2-08/M2-09). Anything short of `ok` carries the fix that resolves it; the bootstrap plan
 * (M2-11) turns fixes into actions.
 */
export const FindingSchema = z.object({
  id: z.string(),
  area: z.enum(["agent", "quality", "hygiene", "git"]),
  status: z.enum(["ok", "info", "warn", "missing"]),
  title: z.string(),
  detail: z.string(),
  fix: z.object({ action: z.string(), label: z.string() }).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/* ---------- Bootstrap plan (M2-11/M2-12) ---------- */

/** What applying an action would do, shown before anything is applied (ADR-0005). */
export const PlanPreviewSchema = z.discriminatedUnion("type", [
  /** A file change; `before` is empty for a new file. */
  z.object({ type: z.literal("diff"), path: z.string(), before: z.string(), after: z.string() }),
  /** Commands as argv arrays: run without a shell. */
  z.object({ type: z.literal("commands"), commands: z.array(z.array(z.string())) }),
  z.object({ type: z.literal("note"), text: z.string() }),
  /** A generator's proposal: several files, each with its current and proposed content. */
  z.object({
    type: z.literal("files"),
    files: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })),
  }),
]);
export type PlanPreview = z.infer<typeof PlanPreviewSchema>;

/** A deterministic check of a generator's proposal or of applied files (M2-26). */
export const CheckSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "skipped"]),
  detail: z.string(),
});
export type Check = z.infer<typeof CheckSchema>;

export const PlanActionSchema = z.object({
  /** `fix:<action>`, `item:<catalog id>` or `gen:<action>`. */
  id: z.string(),
  kind: z.enum(["fix", "catalog", "generator"]),
  title: z.string(),
  why: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  scope: z.enum(["project", "user", "local"]),
  /** Catalog items only. */
  tier: z.enum(["first-party", "official", "verified-vendor", "community"]).optional(),
  license: z.string().optional(),
  /** e.g. "code-review@claude-plugins-official, reviewed v1.0.1 at f8c5e7a". */
  source: z.string().optional(),
  profile: z.string().optional(),
  permissions: z.array(z.string()),
  /** Env var names the item reads; the user provides them, the app never stores them. */
  secrets: z.array(z.string()),
  notes: z.string().optional(),
  preview: PlanPreviewSchema,
  /**
   * recommended: suggested for this workspace; optional: from a profile the user opted into; installed: already set
   * up; unavailable: can't be applied, see `reason`.
   */
  state: z.enum(["recommended", "optional", "installed", "unavailable"]),
  /** Pre-selected. Never true for community items (ADR-0005). */
  selected: z.boolean(),
  reason: z.string().optional(),
  /** Generators: a proposal can be (re)generated with `bootstrap.generate`. */
  generatable: z.boolean().optional(),
  /** Generators: checks of the current proposal. */
  checks: z.array(CheckSchema).optional(),
  /**
   * Generators whose verification runs the project's tests (M2-23): the install command that can run first, with
   * the user's consent (`bootstrap.apply` `install`). It may run package scripts.
   */
  installCommand: z.string().optional(),
});
export type PlanAction = z.infer<typeof PlanActionSchema>;

export const BootstrapPlanSchema = z.object({
  catalogVersion: z.string(),
  profiles: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), suggested: z.boolean() })),
  actions: z.array(PlanActionSchema),
});
export type BootstrapPlan = z.infer<typeof BootstrapPlanSchema>;

/** One bootstrap run: what was applied, from `.agentchainer/backups/<runId>/run.json` (M2-16/M2-17). */
export const BootstrapRunSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  catalogVersion: z.string(),
  actions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["applied", "failed", "rolled-back"]),
      error: z.string().optional(),
      warnings: z.array(z.string()),
      /** Verification after applying generated files (M2-26). */
      checks: z.array(CheckSchema).optional(),
    }),
  ),
});
export type BootstrapRun = z.infer<typeof BootstrapRunSchema>;

/**
 * A plugin a marketplace lists, from the user's own CLI (`claude plugin list --available --json`), for the Plugins page
 * (UX-10, ADR-0010). `review` is set when the AgentChainer catalog has the plugin; `approved` says whether it has its
 * tier's reviews. Everything else is listed as not reviewed.
 */
export const MarketPluginSchema = z.object({
  /** `plugin@marketplace`. */
  id: z.string(),
  name: z.string(),
  marketplace: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  installCount: z.number().optional(),
  /** Where the marketplace says the plugin comes from: a repository URL, a folder in it, and the commit it pins. */
  source: z.object({ url: z.string().optional(), path: z.string().optional(), sha: z.string().optional() }),
  /** Listed by one of Anthropic's marketplaces, not one the user added. */
  official: z.boolean(),
  review: z
    .object({
      itemId: z.string(),
      approved: z.boolean(),
      tier: z.enum(["first-party", "official", "verified-vendor", "community"]),
      reviews: z.array(z.object({ by: z.string(), date: z.string(), notes: z.string().optional() })),
      reviewedVersion: z.string().optional(),
      license: z.string(),
      risk: z.enum(["low", "medium", "high"]),
      permissions: z.array(z.string()),
      summary: z.string(),
      homepage: z.string().optional(),
    })
    .optional(),
});
export type MarketPlugin = z.infer<typeof MarketPluginSchema>;

export const PluginScopeSchema = z.enum(["user", "project", "local", "managed"]);

/** An installed plugin, from `claude plugin list --json`. */
export const InstalledPluginSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  scope: PluginScopeSchema,
  enabled: z.boolean(),
  installedAt: z.string().optional(),
  /** Installed for this workspace (project or local scope), not for all of the user's projects. */
  here: z.boolean(),
  /** A newer listed version. `reviewed` says whether the catalog reviewed that version (null: not in the catalog). */
  update: z.object({ to: z.string(), reviewed: z.boolean().nullable() }).optional(),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

/** An install or update: done, or waiting for a person to confirm a command the marketplace declares. */
export const PluginChangeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    version: z.string().optional(),
    warnings: z.array(z.string()),
    /** The History run an install was recorded in; Roll back uninstalls it. */
    runId: z.string().optional(),
  }),
  z.object({
    status: z.literal("confirm"),
    /** The command, as the CLI showed it. */
    command: z.string(),
    /** Pass it back as `acceptCommand` once the person agreed. */
    sha256: z.string(),
  }),
]);
export type PluginChange = z.infer<typeof PluginChangeSchema>;

/** What `bootstrap.apply` did, per action. */
export const ApplyResultSchema = z.object({
  runId: z.string(),
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["applied", "failed", "skipped"]),
      message: z.string().optional(),
      warnings: z.array(z.string()),
      checks: z.array(CheckSchema).optional(),
    }),
  ),
});

/* ---------- Tasks: contract and triage (M3-02, M3-03; docs/design/planner.md) ---------- */

/** Task tiers: S (one agent → gates) up to XL (sub-tasks in worktrees). */
export const TIERS = ["S", "M", "L", "XL"] as const;

/** A project workflow file the app can't use, and why (M6-04). */
export const ProjectWorkflowProblemSchema = z.object({ file: z.string(), error: z.string() });
export type ProjectWorkflowProblem = z.infer<typeof ProjectWorkflowProblemSchema>;

/** The workflow a tier runs: the app's, or the project's file that replaced it (M6-04). */
export const TierWorkflowSchema = z.object({
  tier: z.enum(TIERS),
  id: z.string(),
  version: z.number().int(),
  description: z.string(),
  /** How many steps (XL: its split step and the sub-tasks' workflows). */
  steps: z.number().int(),
  source: z.enum(["app", "project"]),
  file: z.string().optional(),
  hash: z.string().optional(),
});
export type TierWorkflow = z.infer<typeof TierWorkflowSchema>;
export type Tier = (typeof TIERS)[number];
export const TierSchema = z.enum(TIERS);

/** Gates the sidecar runs from the workspace profile's commands (M3-08). */
export const GATE_KINDS = ["format", "lint", "typecheck", "test", "build", "smoke"] as const;

/** The roles a workflow step runs with (`agents/ac-<role>.md`); the canvas offers these (M3-05, M6-04). */
export const WORKFLOW_ROLES = [
  "implementer",
  "architect",
  "independent-reviewer",
  "test-planner",
  "security-reviewer",
  "docs-writer",
] as const;
/** What an agent step's prompt can include. */
export const STEP_INPUTS = ["contract", "plan", "diff", "gates"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** How a criterion is proved: by a gate run (`gate:test`), judged by the independent reviewer, or checked by the user. */
export const CriterionCheckSchema = z.union([
  z.enum(["review", "manual"]),
  z.templateLiteral(["gate:", z.enum(GATE_KINDS)]),
]);
export type CriterionCheck = z.infer<typeof CriterionCheckSchema>;

const ContractLine = z.string().min(1).max(2000);

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(20),
  text: ContractLine,
  check: CriterionCheckSchema,
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** What will be done and what counts as done, approved by the user before anything changes (`contract.json`). */
export const TaskContractSchema = z.object({
  /** The user's request, verbatim. */
  task: z.string(),
  /** The outcome in one or two sentences, not the steps. */
  objective: z.string().max(4000),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(30),
  /** e.g. "no new dependencies", "keep the public API". */
  constraints: z.array(ContractLine).max(30),
  /** What the task explicitly won't touch. */
  outOfScope: z.array(ContractLine).max(30),
  /** What could go wrong; feeds triage and the report. */
  risks: z.array(ContractLine).max(30),
  /** Workspace paths or globs Claude expects to touch: relative, `/`-separated. */
  affectedAreas: z.array(z.string().min(1).max(500)).max(50),
  /** What the request leaves undecided. The user answers by editing the contract. */
  openQuestions: z.array(ContractLine).max(20),
  /** Set on approval; the contract is read-only after that, except through `task.revise`. */
  approvedAt: z.string().optional(),
});
export type TaskContract = z.infer<typeof TaskContractSchema>;

/** One deterministic triage signal, computed without a model. */
export const TriageSignalSchema = z.object({
  /** The rule: risk-keywords, breadth, scope, repo-size, tests or new-areas. */
  signal: z.string(),
  detail: z.string(),
  detailRef: MessageRefSchema.optional(),
  /** The lowest tier this signal allows; null when it only informs. */
  floor: TierSchema.nullable(),
});
export type TriageSignal = z.infer<typeof TriageSignalSchema>;

/** `triage.json`: the tier proposal, why, and the user's choice. */
export const TriageSchema = z.object({
  signals: z.array(TriageSignalSchema),
  /** The highest floor among the signals. */
  floor: TierSchema,
  /** The cheap model's classification; null when it failed (`modelError`), and the proposal is then the floor. */
  model: z
    .object({
      tier: TierSchema,
      rationale: z.string(),
      /** Set when the sidecar wrote the rationale itself (a split's sub-task), not the model. */
      rationaleRef: MessageRefSchema.optional(),
      confidence: z.enum(["low", "medium", "high"]),
    })
    .nullable(),
  modelError: z.string().optional(),
  modelErrorRef: MessageRefSchema.optional(),
  /** The higher of the model's tier and the floor: a risk keyword can't be talked down. */
  proposed: TierSchema,
  /** What the task runs at: the proposal, unless the user picked another tier with a reason. */
  chosen: TierSchema,
  /** `reasonRef` is set when the sidecar gave the reason (a split's sub-tasks), not the person. */
  override: z.object({ reason: z.string().min(1), reasonRef: MessageRefSchema.optional() }).optional(),
  /**
   * The task's spend cap, defaulting by tier; null for no cap (the person's choice). Each step's own limit from its
   * workflow still applies.
   */
  budgetUsd: z.number().positive().nullable(),
  at: z.string(),
});
export type Triage = z.infer<typeof TriageSchema>;

/** `<date>-<8 hex>`, e.g. 2026-10-30-1a2b3c4d. Checked before it becomes part of a path. */
export const TaskIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);

/** When a schedule runs (M8-05), in local time: presets only, so it always reads as a sentence. */
const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time like 02:30.");
export const CadenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hourly"), every: z.number().int().min(1).max(24) }),
  z.object({ kind: z.literal("daily"), at: ClockSchema }),
  z.object({
    kind: z.literal("weekly"),
    /** 0 is Sunday, as `Date.getDay()`. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    at: ClockSchema,
  }),
]);
export type Cadence = z.infer<typeof CadenceSchema>;

const at = (clock: string) => clock.split(":").map(Number) as [number, number];

/** The first time the cadence names strictly after `after`, in local time. */
export function nextRun(cadence: Cadence, after: Date): Date {
  if (cadence.kind === "hourly") {
    // On the hour, every N hours counted from midnight: 1 → every hour, 6 → 00:00, 06:00, 12:00, 18:00.
    const when = new Date(after);
    when.setMinutes(0, 0, 0);
    do when.setHours(when.getHours() + 1);
    while (when.getHours() % cadence.every !== 0 || when <= after);
    return when;
  }
  const [h, m] = at(cadence.at);
  const when = new Date(after);
  when.setHours(h, m, 0, 0);
  // Day by day through the calendar (setDate keeps the local time across daylight-saving changes).
  for (let i = 0; i < 8; i++) {
    const allowed = cadence.kind === "daily" || cadence.days.includes(when.getDay());
    if (allowed && when > after) return when;
    when.setDate(when.getDate() + 1);
    when.setHours(h, m, 0, 0);
  }
  throw new Error(t("protocol.cadence.noRunTime"));
}

/** The cadence in words: "Every 6 hours", "Daily at 02:00", "Mon, Wed at 09:30". */
export function cadenceText(c: Cadence): string {
  if (c.kind === "hourly")
    return c.every === 1 ? t("protocol.cadence.everyHour") : t("protocol.cadence.everyHours", { n: c.every });
  if (c.kind === "daily") return t("protocol.cadence.dailyAt", { at: c.at });
  // Day names in the language (2023-01-01 was a Sunday): "Mon", "Sen".
  const name = (d: number) => new Date(2023, 0, 1 + d).toLocaleDateString(currentLocale(), { weekday: "short" });
  const days = [...c.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const which = days.length === 7 ? t("protocol.cadence.everyDay") : days.map(name).join(", ");
  return t("protocol.cadence.daysAt", { days: which, at: c.at });
}

/**
 * A scheduled flow (M8-05, docs/design/scheduled-flows.md): one approved task run again on a cadence, while the app
 * is open. Kept in the workspace's `.agentchainer/schedules.json`, which git ignores.
 */
export const ScheduleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  cwd: z.string(),
  taskId: TaskIdSchema,
  /** The task's title when it was scheduled, for lists. */
  title: z.string(),
  cadence: CadenceSchema,
  enabled: z.boolean(),
  createdAt: z.string(),
  /** When it runs next; past it, the next check runs it once (a run missed while the app was closed). */
  nextAt: z.string(),
  lastRun: z
    .object({
      at: z.string(),
      state: z.enum(["started", "skipped", "failed-to-start"]),
      /** It ran more than a couple of minutes after its time: the app was closed, or the computer asleep. */
      late: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

/**
 * `draft` until the user approves the contract and the tier, then `ready`. A run (M3-06) ends `done` (every gate's
 * latest run passed after the last change), `failed`, `unverified` (no gates to run), or `cancelled`. `interrupted`
 * is a run the app stopped in the middle of (computed when read back), which can be resumed. A failed or unverified
 * run can end `accepted`: the user took the risk, with a reason (M3-10).
 */
export const TASK_STATES = [
  "draft",
  "ready",
  "running",
  "done",
  "failed",
  "unverified",
  "cancelled",
  "interrupted",
  "accepted",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** One entry in a run's timeline: an agent step's turn, a fix round, or a round of gates. */
/** The agents a task's step can run on (M9, ADR-0012): the user's own Claude, Codex or Antigravity CLI. */
export const StepAgentSchema = z.enum(["claude", "codex", "agy"]);
export type StepAgent = z.infer<typeof StepAgentSchema>;
/**
 * How a step's cost was counted (M9-07): absent when the agent reported dollars (Claude); `estimate` from its tokens
 * at the model's API price; `unknown` for a model with no price, which then counts $0 toward the budget.
 */
export const CostKindSchema = z.enum(["estimate", "unknown"]);
export type CostKind = z.infer<typeof CostKindSchema>;
/** Tokens a step used, for agents that report tokens and not dollars (M9-07). Input includes cached tokens. */
export const StepTokensSchema = z.object({ input: z.number(), output: z.number() });

export const StepRunSchema = z.object({
  /** Unique within the run, e.g. `implement`, `gates-2`, `fix-1`. */
  id: z.string(),
  /** The template step it belongs to. */
  step: z.string(),
  label: z.string(),
  /** Set for a label the sidecar wrote ("Task branch"); a workflow's own labels are the workflow's words. */
  labelRef: MessageRefSchema.optional(),
  /** XL adds `setup` (the task branch's worktree), `subtask` (a sub-task's run, see `taskId`) and `merge`. */
  kind: z.enum(["agent", "fix", "gates", "baseline", "setup", "subtask", "merge"]),
  /** The sub-task a `subtask` or `merge` entry is about. */
  taskId: z.string().optional(),
  role: z.string().optional(),
  /** Steps that run at the same time (L's planners) share their parallel step's label, as the workflow names it. */
  group: z.string().optional(),
  /** The group's label in the app's language, when the workflow translates it (X-15). */
  groupRef: MessageRefSchema.optional(),
  status: z.enum(["running", "done", "failed", "cancelled"]),
  sessionId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  costUsd: z.number(),
  /** An agent step's agent and the model it ran (M9-07); absent on entries before M9. */
  agent: StepAgentSchema.optional(),
  model: z.string().optional(),
  costKind: CostKindSchema.optional(),
  tokens: StepTokensSchema.optional(),
  /** What happened, in a sentence: the failing gates, the must-fix findings, an error. */
  note: z.string().optional(),
  noteRef: MessageRefSchema.optional(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

/** A gate the sidecar ran itself (M3-08): the real command, exit code and end of the log. */
export const GateRunSchema = z.object({
  kind: z.enum(GATE_KINDS),
  command: z.string(),
  /** The package it ran in; "." is the workspace root, and another folder's start with its name (`api`, `api:web`). */
  package: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  tail: z.string(),
  /** 0 for the first run, then one more per fix round. */
  round: z.number().int(),
  at: z.string(),
  /** Format: the files it rewrote. A check: files it changed, which were reverted. */
  changed: z.array(z.string()).optional(),
  /** A multi-folder task's other folder it ran in, by name (M8-01); none in the primary folder. */
  folder: z.string().optional(),
});
export type GateRun = z.infer<typeof GateRunSchema>;

/** An approval a task step asked for during a run, and the answer (M3-09 security notes). */
export const ApprovalRecordSchema = z.object({
  stepId: z.string(),
  label: z.string(),
  tool: z.string(),
  /** The command, file or target, as the approval dialog shows it. */
  target: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  allowed: z.boolean(),
  /** Saved as a rule ("Always allow"). */
  always: z.boolean(),
  at: z.string(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/** A tool call the guard hook denied during a run. */
export const GuardBlockSchema = z.object({
  stepId: z.string(),
  tool: z.string(),
  target: z.string(),
  reason: z.string(),
  at: z.string(),
});
export type GuardBlock = z.infer<typeof GuardBlockSchema>;

/**
 * A task's agent per role (M9-06): a write step implements, a read step with a verdict reviews, other read steps plan.
 * A step's own `agent:` in its workflow wins; a role left out runs on Claude.
 */
export const AgentRolesSchema = z
  .object({ plan: StepAgentSchema, implement: StepAgentSchema, review: StepAgentSchema })
  .partial();
export type AgentRoles = z.infer<typeof AgentRolesSchema>;

/**
 * How tasks run unless they choose otherwise (owner request, 2026-11-10): the agent per role, the model, the
 * permission profile and the budget per tier. Kept for the whole app (Settings) and per workspace
 * (`.agentchainer/defaults.json`); a workspace's value wins over the app's, and each falls back to the built-in one
 * (Claude, the chat's model and profile, the triage budgets). A budget of `null` is "no budget".
 */
export const TaskDefaultsSchema = z
  .object({
    agents: AgentRolesSchema,
    model: z.string().min(1).max(100),
    permissionMode: z.enum(["default", "acceptEdits", "auto"]),
    budgetUsd: z.partialRecord(z.enum(["S", "M", "L", "XL"]), z.number().min(0).max(1_000_000).nullable()),
  })
  .partial();
export type TaskDefaults = z.infer<typeof TaskDefaultsSchema>;
/** Both levels and what they come to for a workspace: what its task page and its defaults card show. */
export const TaskDefaultsViewSchema = z.object({
  app: TaskDefaultsSchema,
  workspace: TaskDefaultsSchema,
  effective: TaskDefaultsSchema,
});
export type TaskDefaultsView = z.infer<typeof TaskDefaultsViewSchema>;

export const TaskRunSchema = z.object({
  /**
   * The workflow it runs; `source: "project"` when the project's file replaced the app's (M6-04), `"task"` when the
   * task has its own flow (UX-14), with its hash.
   */
  workflow: z.object({
    id: z.string(),
    version: z.number().int(),
    source: z.enum(["project", "task"]).optional(),
    file: z.string().optional(),
    hash: z.string().optional(),
  }),
  permissionMode: PermissionModeSchema,
  model: z.string().optional(),
  /** The agent per role the person chose at Run (M9-06); fix rounds and resumes keep it. */
  agents: AgentRolesSchema.optional(),
  /** What the task's changes are measured from: a snapshot of the tree at the start, or null outside git. */
  base: z.string().nullable(),
  /** Files already untracked at the start: not the task's changes. */
  untrackedAtStart: z.array(z.string()),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /** The template step running now, or to resume from. */
  position: z.number().int(),
  fixRounds: z.number().int(),
  steps: z.array(StepRunSchema),
  gates: z.array(GateRunSchema),
  /** Gates the workflow asks for that the workspace has no command for: reported as not run, never as passed. */
  notRun: z.array(z.enum(GATE_KINDS)),
  /** The gates run once before the first step: what already failed before the task. */
  baseline: z.array(GateRunSchema).default([]),
  approvals: z.array(ApprovalRecordSchema).default([]),
  guardBlocks: z.array(GuardBlockSchema).default([]),
  /** Set when the user accepted a failed or unverified run's risk (M3-10). */
  acceptance: z.object({ reason: z.string().min(1), at: z.string() }).optional(),
  costUsd: z.number(),
  /** Why the run ended, in a sentence, in English; `outcomeRef` shows it in the app's language. */
  outcome: z.string().optional(),
  outcomeRef: MessageRefSchema.optional(),
  /** A schedule started it (M8-05), not a person. */
  trigger: z.literal("schedule").optional(),
});
export type TaskRun = z.infer<typeof TaskRunSchema>;

/** An earlier run of a task, kept when "Run again" replaced it (M7, docs/design/evals.md §3). */
export const RunSummarySchema = z.object({
  workflow: TaskRunSchema.shape.workflow,
  model: z.string().optional(),
  /** The state the task ended that run in. */
  state: z.enum(TASK_STATES),
  costUsd: z.number(),
  /** How many gate rounds ran: the first, then one per fix round. */
  gateRounds: z.number().int(),
  /** Whether the last round passed every gate that ran; null when none ran. */
  gatesPassed: z.boolean().nullable(),
  fixRounds: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  trigger: z.literal("schedule").optional(),
  /** That run's own evidence report, in the task's folder (M8-05): `evidence-<n>.md`. */
  evidence: z.string().optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** A task behind the metrics (M7-01): enough to list it and to see which numbers it counts in. */
export const MetricsTaskSchema = z.object({
  id: z.string(),
  request: z.string(),
  tier: z.string().nullable(),
  state: z.enum(TASK_STATES),
  createdAt: z.string(),
  costUsd: z.number(),
  runs: z.number().int(),
  /** The latest run's last gate round; null when no gate ran. */
  gatesPassed: z.boolean().nullable(),
  fixRounds: z.number().int(),
  ciFixes: z.number().int(),
  /** Done, or its PR merged with every gate green. */
  success: z.boolean(),
  /** Accepted with risk, merged with gates not green, or a Fix CI round. */
  neededPerson: z.boolean(),
});
export type MetricsTask = z.infer<typeof MetricsTaskSchema>;

/** A workspace's task metrics (M7-01, docs/design/evals.md §4), computed locally; a rate is null with nothing to count. */
/**
 * The usage page's series (CP-01): fixed agent families, so a color keeps its meaning whatever a period shows.
 * Claude's by model line; Codex and agy by agent; anything else is `other`.
 */
export const USAGE_FAMILIES = ["opus", "sonnet", "haiku", "fable", "codex", "agy", "other"] as const;
export const UsageFamilySchema = z.enum(USAGE_FAMILIES);
export type UsageFamily = z.infer<typeof UsageFamilySchema>;

const UsageTokensSchema = {
  costUsd: z.number(),
  /** All tokens: input, output, cache reads and cache writes. */
  tokens: z.number(),
};

/**
 * The user's Codex account usage (CP-01), from Codex's own app-server: daily tokens across the whole ChatGPT account
 * (every device and app, so it overlaps the app's own Codex runs) and the plan's quota windows. Tokens only: Codex
 * gives no per-model split here, so no cost.
 */
export const CodexAccountUsageSchema = z.object({
  available: z.boolean(),
  /** Why there's nothing: Codex isn't installed, the login isn't ChatGPT (API key), or the call failed. */
  reason: z.enum(["notInstalled", "needsChatgpt", "failed"]).optional(),
  plan: z.string().nullable().optional(),
  lifetimeTokens: z.number().nullable().optional(),
  /** Days with activity, as Codex reports them. */
  daily: z.array(z.object({ day: z.string(), tokens: z.number() })).optional(),
  limits: z
    .array(
      z.object({
        name: z.string(),
        which: z.enum(["primary", "secondary"]),
        usedPercent: z.number(),
        windowMins: z.number().nullable(),
        resetsAt: z.string().nullable(),
      }),
    )
    .optional(),
});
export type CodexAccountUsage = z.infer<typeof CodexAccountUsageSchema>;

/**
 * What agents spent across sessions (CP-01): every stored Claude session (from the SDK's history, ADR-0004) and the
 * Codex and agy steps of the given workspaces' tasks. Costs are estimates at API prices; a model with no price
 * counts its tokens in `unpricedTokens` and $0. A session counts on the day it was last active.
 */
export const UsageReportSchema = z.object({
  generatedAt: z.string(),
  /** Null: all time. */
  sinceDays: z.number().nullable(),
  totals: z.object({
    ...UsageTokensSchema,
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    unpricedTokens: z.number(),
    sessions: z.number(),
  }),
  byModel: z.array(
    z.object({
      model: z.string(),
      family: UsageFamilySchema,
      ...UsageTokensSchema,
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      unpricedTokens: z.number(),
      sessions: z.number(),
    }),
  ),
  /** By folder the session ran in (a task's worktree is its own). */
  byProject: z.array(z.object({ project: z.string(), ...UsageTokensSchema, sessions: z.number() })),
  /** Each day with spend, oldest first: the estimate by family. */
  byDay: z.array(z.object({ day: z.string(), costUsd: z.partialRecord(UsageFamilySchema, z.number()) })),
  /** Codex's own account usage, when Codex is installed; separate from the totals, which it would count twice. */
  codexAccount: CodexAccountUsageSchema.optional(),
  /** The costliest sessions and task steps, costliest first. */
  sessions: z.array(
    z.object({
      id: z.string(),
      project: z.string(),
      title: z.string(),
      day: z.string(),
      source: z.enum(["claude", "codex", "agy"]),
      models: z.array(z.string()),
      ...UsageTokensSchema,
      unpricedTokens: z.number(),
    }),
  ),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

const UsageParams = z.object({
  /** 7, 30 or 90 days back from now; null for all time. */
  sinceDays: z.number().int().positive().max(3650).nullable(),
  /** Workspaces whose task records add their Codex and agy steps. */
  workspaces: z.array(z.string()).max(200),
});

export const MetricsSummarySchema = z.object({
  tasks: z.number().int(),
  runs: z.number().int(),
  gatePass: z.object({ rate: z.number().nullable(), judged: z.number().int(), unjudged: z.number().int() }),
  costUsd: z.object({
    total: z.number(),
    perTask: z.number().nullable(),
    perSuccess: z.number().nullable(),
    successes: z.number().int(),
  }),
  durationMs: z.object({ p50: z.number(), p90: z.number(), count: z.number().int() }).nullable(),
  retries: z.object({ extraRuns: z.number().int(), fixRounds: z.number().int(), ciFixes: z.number().int() }),
  humanFix: z.object({ rate: z.number().nullable(), tasks: z.number().int() }),
  byTier: z.array(
    z.object({ tier: z.string(), tasks: z.number().int(), successes: z.number().int(), costUsd: z.number() }),
  ),
  byWorkflow: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      runs: z.number().int(),
      gatePassRate: z.number().nullable(),
      costUsd: z.number(),
    }),
  ),
  taskList: z.array(MetricsTaskSchema),
});
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;

/**
 * The git worktree a task works in, on its own branch (every tier since M5-01): `base` is the commit it started from,
 * `from` the branch that was checked out then (a PR's base), and `untracked` the files already untracked after its
 * setup (installed dependencies), which aren't its changes. `removed` once the worktree is gone (merged, or cleaned up);
 * the branch can outlive it.
 */
export const TaskWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string(),
  base: z.string(),
  from: z.string().optional(),
  untracked: z.array(z.string()),
  removed: z.boolean().optional(),
});

/**
 * One of a multi-folder workspace's other folders (M8-01): `name` prefixes its paths in the contract's areas and the
 * evidence (`api:src/routes.ts`). A git folder gets its own worktree on the task's branch; one without git is worked
 * in directly.
 */
export const TaskFolderSchema = z.object({
  name: z.string(),
  path: z.string(),
  worktree: TaskWorktreeSchema.optional(),
  /** The draft PR made from this folder's branch in its own repository, with the task's main PR (M8-01). */
  pr: z.object({ number: z.number().int(), url: z.string(), base: z.string(), head: z.string() }).optional(),
});
export type TaskFolder = z.infer<typeof TaskFolderSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  /** What the user asked for, verbatim. */
  request: z.string(),
  /**
   * The task's own flow (UX-14): a workflow AI proposed for this task, checked like a project's, approved with the
   * contract; its run follows it instead of the tier's.
   */
  flow: z.object({ yaml: z.string().max(65_536), summary: z.string(), hash: z.string(), at: z.string() }).optional(),
  /** The chat a task was made from (UX-13, "Make this a task"): its last messages, which drafting reads. */
  chatContext: z.string().max(12_000).optional(),
  state: z.enum(TASK_STATES),
  createdAt: z.string(),
  updatedAt: z.string(),
  contract: TaskContractSchema.nullable(),
  triage: TriageSchema.nullable(),
  /** Gates the profile has commands for. A criterion checked by another gate can't be proved. */
  availableGates: z.array(z.enum(GATE_KINDS)),
  /** Model spend so far on drafting, triage and the run, an estimate. */
  costUsd: z.number(),
  /** The latest run; tasks from before runs existed have none. */
  run: TaskRunSchema.nullable().default(null),
  /** The runs before `run`, oldest first (M7); tasks from before run history have none. */
  runs: z.array(RunSummarySchema).optional(),
  /** A sub-task of an XL task (M3-07): its parent, and its place in the split. */
  parent: z.object({ id: TaskIdSchema, index: z.number().int().min(0) }).optional(),
  /** A sub-task's short title, from the split. */
  title: z.string().optional(),
  /** The sub-tasks this one runs after. */
  dependsOn: z.array(TaskIdSchema).optional(),
  /** The task's worktree in the primary folder (`TaskWorktreeSchema`). */
  worktree: TaskWorktreeSchema.optional(),
  /** A multi-folder workspace's other folders (M8-01), each with its worktree once a run made one. */
  folders: z.array(TaskFolderSchema).max(16).optional(),
  /** The other folder an XL sub-task works in (M8-01), with its worktree in that folder's repository. */
  folder: z.object({ name: z.string(), path: z.string() }).optional(),
  /** An XL task's sub-tasks, in the split's order. */
  subtasks: z.array(TaskIdSchema).optional(),
  /** Where the user merged the task's branch. */
  mergedInto: z.object({ branch: z.string(), at: z.string() }).optional(),
  /** The pull request made from the task's branch (M5-02). */
  pr: z
    .object({
      number: z.number().int(),
      url: z.string(),
      base: z.string(),
      head: z.string(),
      /** The commit the PR's branch pointed at when it was pushed. */
      headSha: z.string(),
      draft: z.boolean(),
      createdAt: z.string(),
      /** Fix CI rounds (M5-03), at most `MAX_CI_FIXES`: the check that failed, and how the round ended. */
      fixes: z
        .array(z.object({ check: z.string(), at: z.string(), state: z.enum(["done", "failed", "cancelled"]) }))
        .optional(),
      /**
       * The latest independent review that covers the PR (M5-04): the run's own review (M and L), or one run on the
       * PR's diff. It counts for the merge gate only while the PR's head is still `headSha`.
       */
      review: z
        .object({
          headSha: z.string(),
          verdict: z.enum(["approve", "changes-requested", "unreadable"]),
          mustFix: z.number().int(),
          at: z.string(),
          source: z.enum(["run", "pr"]),
        })
        .optional(),
      /** How a person merged it (M5-05): only from the Merge button, after a confirmation. */
      merged: z
        .object({
          method: z.enum(["merge", "squash", "rebase"]),
          sha: z.string(),
          at: z.string(),
          /** Why the person merged with gates that weren't green, when they did. */
          accepted: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/** One merge gate of a task's PR (M5-04): `fail`, `pending` and `missing` hold Merge back; `not-run` doesn't. */
export const MergeGateSchema = z.object({
  id: z.enum(["local", "review", "secrets", "semgrep", "trivy", "ci"]),
  label: z.string(),
  state: z.enum(["pass", "fail", "pending", "missing", "not-run"]),
  detail: z.string(),
});
export type MergeGate = z.infer<typeof MergeGateSchema>;
export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);

/** A Docker repository to push to: lowercase, with its registry or namespace, and no tag (`ghcr.io/you/app`). */
export const DockerImageSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\.[a-z0-9-]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/, {
    error: () => t("protocol.deploy.imageFormat"),
  });

/** The deploy providers (M6-01). */
export const DeployAdapterSchema = z.enum(["vercel", "cloudflare", "firebase", "fly", "docker"]);

/** A provider a workspace can deploy to (M6-01): its config file, and whether its CLI is installed and signed in. */
export const DeployTargetSchema = z.object({
  adapter: DeployAdapterSchema,
  label: z.string(),
  /** The file that marks the project for this provider, e.g. `.vercel/project.json`. */
  config: z.string(),
  /** missing: the CLI isn't installed; not-linked: the project isn't connected to the provider yet. */
  state: z.enum(["missing", "not-linked", "signed-out", "ready"]),
  /** What to do when it isn't ready. */
  hint: z.string().optional(),
  /** Where it can deploy: Fly.io has no previews. */
  environments: z.array(z.enum(["preview", "production"])),
  /** Whether it can roll back without a recorded previous deploy (the provider knows its own previous one). */
  rollbackWithoutRecord: z.boolean(),
  /** The provider's project, the name typed to confirm production (Docker: the image), when the config names it. */
  project: z.string().optional(),
});
export type DeployTarget = z.infer<typeof DeployTargetSchema>;

/** One deploy the app ran, always from a person's click (M6, design §7). Kept in `.agentchainer/deploys/`. */
export const DeployRecordSchema = z.object({
  id: z.string(),
  adapter: DeployAdapterSchema,
  env: z.enum(["preview", "production"]),
  taskId: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string(),
  /** The exact command, as the plan showed it. */
  command: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  status: z.enum(["done", "failed"]),
  url: z.string().optional(),
  /** The provider's id for the deployment (Vercel: its URL; Cloudflare: a version; Firebase: site@version; Fly: an image), which rollback goes back to. */
  deploymentId: z.string().optional(),
  /** Why it failed, in English; `errorRef` shows it in the app's language when the sidecar wrote it (X-15). */
  error: z.string().optional(),
  errorRef: MessageRefSchema.optional(),
  /** The smoke test; `detail` is English, `detailRef` the app's language (X-15). Older records have no refs. */
  smoke: z
    .object({
      ok: z.boolean(),
      how: z.enum(["script", "http"]),
      detail: z.string(),
      detailRef: MessageRefSchema.optional(),
    })
    .optional(),
  /** Production: what was live before this one, which Roll back goes back to (design §6). */
  previous: z
    .object({
      recordId: z.string().optional(),
      deploymentId: z.string().optional(),
      url: z.string().optional(),
      commit: z.string().optional(),
    })
    .optional(),
  /** A rollback: the record it rolled back. */
  rollbackOf: z.string().optional(),
  /** The rollback that undid this deploy. */
  rolledBackBy: z.string().optional(),
});
export type DeployRecord = z.infer<typeof DeployRecordSchema>;

/**
 * What a production deploy will do, shown before it runs (M6-02, design §5): the command, the provider's project (the
 * name the person types to confirm), and the branch and commit. `problem` says why it can't run yet.
 */
export const DeployPlanSchema = z.object({
  adapter: DeployAdapterSchema,
  label: z.string(),
  project: z.string(),
  command: z.string(),
  branch: z.string(),
  commit: z.string(),
  problem: z.string().optional(),
  /** The production deploy that is live now, as far as the app knows. */
  current: DeployRecordSchema.optional(),
});
export type DeployPlan = z.infer<typeof DeployPlanSchema>;

/** How many Fix CI rounds a PR gets (design §6). */
export const MAX_CI_FIXES = 3;

/** One check on a task's PR, as `gh pr checks` reports it (M5-03). */
export const PrCheckSchema = z.object({
  name: z.string(),
  workflow: z.string(),
  state: z.string(),
  /** pass, fail, pending, skipping or cancel. */
  bucket: z.string(),
  link: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type PrCheck = z.infer<typeof PrCheckSchema>;

/**
 * Whether the app can make pull requests for a workspace through the user's own `gh` (M5-02, ADR-0002): `missing` when
 * `gh` isn't installed, `signed-out` when it has no login for the remote's host, `no-remote` when the repository has
 * no `origin` on a GitHub host, `ready` otherwise. Never carries the account or a token.
 */
export const GitHubStatusSchema = z.object({
  state: z.enum(["missing", "no-remote", "signed-out", "ready"]),
  version: z.string().optional(),
  host: z.string().optional(),
  /** `owner/name` of the origin remote, when it's on a GitHub host. */
  repo: z.string().optional(),
});
export type GitHubStatus = z.infer<typeof GitHubStatusSchema>;

export const TaskSummarySchema = TaskSchema.pick({
  id: true,
  request: true,
  state: true,
  createdAt: true,
  updatedAt: true,
  costUsd: true,
}).extend({ tier: TierSchema.nullable() });
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

const WorkspaceRef = z.object({ cwd: z.string().min(1) });
/** A file inside the workspace; the sidecar rejects absolute paths and `..`. */
const WorkspacePath = WorkspaceRef.extend({ path: z.string().min(1) });
const TaskRef = WorkspaceRef.extend({ id: TaskIdSchema });

/** A slash command or skill the session offers (UX-12): the SDK's `supportedCommands()` and its later pushes. */
export const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string(),
  aliases: z.array(z.string()).optional(),
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/** A model the CLI offers, as its `/model` lists it (UX-12): the SDK's `supportedModels()`. */
export const ModelOptionSchema = z.object({
  /** What `setModel` takes: an alias like "opus", "default", or a full id. */
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  efforts: z.array(z.string()).optional(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

/** Normalized agent activity, independent of raw SDK message shapes (ARCHITECTURE §5.2). */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.started"),
    sessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
    claudeCodeVersion: z.string(),
    permissionMode: z.string(),
    /** Slash commands and skills the session offers, for the composer's `/` palette (M1-13). */
    slashCommands: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("text.delta"), text: z.string() }),
  /** The main agent's visible thinking, when the model streams it (M1-10). */
  z.object({ type: z.literal("thinking.delta"), text: z.string() }),
  /** Only in `session.history`: live user messages are added by the UI when it sends them. */
  z.object({
    type: z.literal("user.message"),
    messageId: z.string(),
    text: z.string(),
    imageCount: z.number().int().optional(),
  }),
  /**
   * `parentToolUseId` is null for the main agent; otherwise it is the `toolUseId` of the Agent tool call that
   * spawned the subagent doing this work (the key of the agent tree, ARCHITECTURE §5.2).
   */
  z.object({
    type: z.literal("tool.started"),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolUseId: z.string().nullable(),
    agentId: z.string().optional(),
    /** A subagent's call: the model its message came from, so the graph says which model each agent runs (UX-18). */
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    toolUseId: z.string(),
    isError: z.boolean(),
    output: z.string(),
    parentToolUseId: z.string().nullable(),
  }),
  /**
   * A subagent was spawned by the Agent tool call `toolUseId` (spike S4). `parentTaskId` is the `taskId` of the
   * subagent that spawned it, absent for a spawn from the main agent (M4-01). `runId` changes when a task resumes.
   */
  z.object({
    type: z.literal("agent.started"),
    toolUseId: z.string(),
    taskId: z.string(),
    description: z.string(),
    agentType: z.string().optional(),
    depth: z.number().optional(),
    background: z.boolean().optional(),
    parentTaskId: z.string().optional(),
    runId: z.string().optional(),
    prompt: z.string().optional(),
  }),
  /** A running subagent's totals so far and the tool it used last (M4-01). */
  z.object({
    type: z.literal("agent.progress"),
    toolUseId: z.string(),
    taskId: z.string(),
    runId: z.string().optional(),
    totalTokens: z.number(),
    toolUses: z.number(),
    durationMs: z.number(),
    lastTool: z.string().optional(),
    summary: z.string().optional(),
  }),
  /**
   * A change to a task's state, keyed by `taskId` only: the SDK's `task_updated` carries no tool call id (M4-01).
   * `endTime` is epoch ms.
   */
  z.object({
    type: z.literal("agent.updated"),
    taskId: z.string(),
    runId: z.string().optional(),
    status: z.enum(["pending", "running", "completed", "failed", "killed", "paused"]).optional(),
    endTime: z.number().optional(),
    pausedMs: z.number().optional(),
    error: z.string().optional(),
    background: z.boolean().optional(),
  }),
  /**
   * Every live background task of the session after a change (M4-07): replace the set, don't merge. Ambient tasks
   * (watchers the CLI starts itself) are left out.
   */
  z.object({
    type: z.literal("background.changed"),
    tasks: z.array(
      z.object({
        taskId: z.string(),
        runId: z.string().optional(),
        /** `local_agent`, `local_bash`, `monitor`, … */
        kind: z.string(),
        description: z.string(),
        agentType: z.string().optional(),
        parentTaskId: z.string().optional(),
      }),
    ),
  }),
  /**
   * A turn the CLI started without a user message: background work finished and the main agent goes on (M4-07).
   * It ends with `turn.completed` like any turn.
   */
  z.object({ type: z.literal("turn.started"), reason: z.literal("background") }),
  z.object({
    type: z.literal("agent.text"),
    parentToolUseId: z.string(),
    agentId: z.string().optional(),
    text: z.string(),
    /** The model the subagent's message came from (UX-18). */
    model: z.string().optional(),
  }),
  z.object({
    type: z.literal("agent.completed"),
    toolUseId: z.string(),
    taskId: z.string(),
    runId: z.string().optional(),
    /** The SDK's: completed, failed or stopped. */
    status: z.string(),
    /** Set only when the task didn't end the ordinary way, e.g. `worker_restart`. */
    reason: z.string().optional(),
    summary: z.string(),
    totalTokens: z.number().optional(),
    toolUses: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  /**
   * `totalCostUsd` is the session's running total, not this turn's cost: the SDK's `total_cost_usd` is cumulative in
   * streaming-input sessions, and a resumed session starts from its saved total. An estimate (ARCHITECTURE §5.3).
   */
  z.object({
    type: z.literal("turn.completed"),
    subtype: z.string(),
    isError: z.boolean(),
    totalCostUsd: z.number(),
    durationMs: z.number(),
    numTurns: z.number(),
    /** Token totals for the session so far, summed over models (cumulative like `totalCostUsd`). */
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheCreationTokens: z.number(),
      })
      .optional(),
  }),
  /** The full list of commands, replacing the last one (UX-12): after init, and when skills appear mid-session. */
  z.object({ type: z.literal("commands.changed"), commands: z.array(SlashCommandSchema) }),
  /** The models the CLI offers, when a chat starts (UX-12): the composer's model picker, named as the CLI names them. */
  z.object({ type: z.literal("models.changed"), models: z.array(ModelOptionSchema) }),
  /** How full the context window is, after each turn (UX-12). */
  z.object({
    type: z.literal("context.usage"),
    percentage: z.number(),
    totalTokens: z.number(),
    maxTokens: z.number(),
    /** What fills the window, for `/usage`: system prompt, tools, memory files, messages, the buffer, free space. */
    categories: z
      .array(z.object({ name: z.string(), tokens: z.number(), kind: z.enum(["used", "free", "buffer", "deferred"]) }))
      .optional(),
  }),
  /** Earlier messages were summarized to free the context window, by `/compact` or automatically (UX-12). */
  z.object({
    type: z.literal("context.compacted"),
    trigger: z.enum(["manual", "auto"]),
    preTokens: z.number(),
    postTokens: z.number().optional(),
  }),
  /**
   * A Team chat's worker reported back (M8-03): its turn ended, and the sidecar handed the report to the supervisor as
   * its next message. Shown as the worker's card, not as something the person typed.
   */
  z.object({
    type: z.literal("worker.message"),
    workerId: z.string(),
    name: z.string(),
    text: z.string(),
    isError: z.boolean(),
  }),
  /**
   * What a Team chat and its workers have spent together, against its one cap (M8-03). `stopped` once the cap is
   * reached: the workers are closed and no more reports are delivered.
   */
  z.object({
    type: z.literal("team.budget"),
    spentUsd: z.number(),
    capUsd: z.number(),
    stopped: z.boolean(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/* ---------- Requests: UI → sidecar ---------- */

export const methodSchemas = {
  "system.hello": {
    params: z.object({ protocolVersion: z.number().int() }),
    result: z.object({
      protocolVersion: z.number().int(),
      sdkVersion: z.string(),
      nodeVersion: z.string(),
      homeDir: z.string(),
      claudePath: z.string().nullable(),
      claudeVersion: z.string().nullable(),
    }),
  },
  /** Liveness check used by the UI's health ping (M1-01). */
  "system.ping": { params: Empty, result: Ok },
  /**
   * Every live session across workspaces, for the fleet view (M8-02): chats and task steps, with their status. Changes
   * then arrive as `fleet.changed`.
   */
  "fleet.list": { params: Empty, result: z.object({ items: z.array(z.lazy(() => FleetItemSchema)) }) },
  /** Readiness of the user's machine (spike S5). Never includes account identity (email, org). */
  "env.check": { params: Empty, result: EnvCheckSchema },
  /**
   * The other agents' CLIs a task step can run on (M9-06), each by its own status command: Codex's `login status`,
   * agy's `models`. Only version and signed in or not; never an account detail (ADR-0002).
   */
  "agents.available": {
    params: Empty,
    result: z.object({
      codex: z.object({ installed: z.boolean(), version: z.string().optional(), signedIn: z.boolean() }),
      agy: z.object({ installed: z.boolean(), version: z.string().optional(), signedIn: z.boolean() }),
    }),
  },
  /**
   * Makes the Claude Agent SDK ready. The packaged app downloads and verifies the pinned SDK on first use (ADR-0003);
   * dev builds use node_modules.
   */
  "sdk.prepare": {
    params: Empty,
    result: z.object({ version: z.string(), source: z.enum(["node_modules", "download", "cache"]) }),
  },
  /** Dev-only: lets the UI write a line to the sidecar's log, e.g. self-test metrics (spike S2). */
  "debug.log": { params: z.object({ message: z.string().max(10_000) }), result: Ok },
  /**
   * Starts a session, or resumes one from `session.list` when `resume` is set. Returns its SDK session id, which every
   * other session method and notification carries (multi-session, M1-08).
   */
  "session.start": {
    params: z.object({
      cwd: z.string().min(1),
      model: z.string().optional(),
      permissionMode: PermissionModeSchema.optional(),
      effort: EffortSchema.optional(),
      /** The SDK stops the session's turns once this much is spent since start (M1-32). */
      maxBudgetUsd: z.number().positive().optional(),
      /** Stream summaries of Claude's thinking (adaptive thinking, summarized display); off, they arrive empty (M1-10). */
      showThinking: z.boolean().optional(),
      resume: SessionIdSchema.optional(),
      /**
       * A multi-folder workspace's other folders (M8-01): absolute paths the session may read and change besides
       * `cwd` (the SDK's `additionalDirectories`). Checked like the New workspace dialog checks them.
       */
      folders: z.array(z.string().min(1).max(4096)).max(16).optional(),
      /**
       * A Team chat (M8-03): the session gets the app's tools to start worker sessions, hand them work and read their
       * reports. Needs `maxBudgetUsd`, which then caps the chat and its workers together.
       */
      team: z.boolean().optional(),
      /**
       * An agent profile to run as (M8-04): a project or user agent's prompt, model and tools. Only the tools it lists
       * are available; `model` overrides its model.
       */
      profile: AgentNameSchema.optional(),
      /** The agent the chat runs on (M9-09): Claude unless set. Profiles and Team are Claude's. */
      agent: StepAgentSchema.optional(),
    }),
    /**
     * `attached`: the session was still running, e.g. after the window reloaded, and was handed back as it is
     * (M1-36). Its history comes from `session.history` as for any resume.
     */
    result: z.object({ sessionId: SessionIdSchema, attached: z.boolean().optional() }),
  },
  /**
   * `messageId` is the user message's uuid: the anchor for "Rewind files to here" (M1-23). `images` are pasted
   * screenshots (M1-13), base64 without the data-URL prefix.
   */
  "session.send": {
    params: z.object({
      sessionId: SessionIdSchema,
      text: z.string().min(1),
      images: z.array(ImageSchema).max(5).optional(),
    }),
    result: z.object({ ok: z.literal(true), messageId: z.string() }),
  },
  /** `interrupted: false` means no turn was running, so nothing was sent to the CLI. */
  "session.interrupt": {
    params: SessionRef,
    result: z.object({ ok: z.literal(true), interrupted: z.boolean() }),
  },
  /**
   * Stops one subagent (M4-05); the turn goes on. The SDK then sends its `agent.completed` with status `stopped`.
   * `stopped: false` means no turn was running. `taskId` is the SDK's task id from `agent.started`.
   */
  "session.stopAgent": {
    params: SessionRef.extend({ taskId: z.string().min(1).max(200) }),
    result: z.object({ ok: z.literal(true), stopped: z.boolean() }),
  },
  "session.setMode": { params: z.object({ sessionId: SessionIdSchema, mode: PermissionModeSchema }), result: Ok },
  /** Switches the model for the next turn (M1-15); an empty string goes back to the default model. */
  "session.setModel": { params: z.object({ sessionId: SessionIdSchema, model: z.string() }), result: Ok },
  /** `null` goes back to the model's default effort. */
  "session.setEffort": {
    params: z.object({ sessionId: SessionIdSchema, effort: EffortSchema.nullable() }),
    result: Ok,
  },
  /** Ends the live session (its tab closed). The transcript stays on disk and can be resumed. */
  "session.close": { params: SessionRef, result: Ok },
  /**
   * Restores files edited by Edit/Write to their state before the user message `messageId` (SDK file checkpoints).
   * `dryRun` previews the change. Bash-made changes are not tracked.
   */
  "session.rewind": {
    params: z.object({ sessionId: SessionIdSchema, messageId: z.string().min(1), dryRun: z.boolean().optional() }),
    result: RewindResultSchema,
  },
  /**
   * Answers a `permission.request` (M1-17):
   * - `always` also saves the request's `alwaysRules` to `.claude/settings.local.json`;
   * - `updatedInput` runs the tool with the user's edited input;
   * - `message` tells the agent why it was denied;
   * - `mode` (ExitPlanMode only) is the permission mode to execute an approved plan in (M1-16).
   */
  "permission.respond": {
    params: z.object({
      sessionId: SessionIdSchema,
      requestId: z.string().min(1),
      allow: z.boolean(),
      always: z.boolean().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      message: z.string().optional(),
      mode: PermissionModeSchema.optional(),
      /** Where "Always allow" saves its rules (UX-05); the workspace's local settings when left out. */
      scope: AlwaysScopeSchema.optional(),
    }),
    result: Ok,
  },
  /**
   * Permission rules (M1-20): the workspace's `.claude/settings.local.json` (just this user, not committed) and its
   * `.claude/settings.json` (shared with the team, committed). Other settings never leave the sidecar.
   */
  "permissions.list": {
    params: z.object({ cwd: z.string().min(1) }),
    result: z.object({ workspace: RulesSchema, team: RulesSchema, user: RulesSchema }),
  },
  /** The project's and the user's subagent definitions (M4-06). */
  "agents.list": {
    params: z.object({ cwd: z.string().min(1) }),
    result: z.object({ agents: z.array(AgentDefinitionSchema) }),
  },
  /**
   * Creates or edits a project agent, as a recorded run that History can roll back. `previousName` renames: the old
   * file goes in the same run. Front matter fields the form doesn't show are kept.
   */
  "agents.save": {
    params: z.object({ cwd: z.string().min(1), agent: AgentInputSchema, previousName: AgentNameSchema.optional() }),
    /** No run for a user agent (M8-04): it isn't the workspace's, so History can't roll it back. */
    result: z.object({ runId: z.string().optional() }),
  },
  /** Deletes a project agent as a recorded run that History can roll back, or a user agent (M8-04). */
  "agents.delete": {
    params: z.object({ cwd: z.string().min(1), name: AgentNameSchema, scope: AgentScopeSchema.optional() }),
    result: z.object({ runId: z.string().optional() }),
  },
  /**
   * Scheduled flows (M8-05). `schedule.watch` names the workspaces whose schedules run while the app is open; the UI
   * sends it after every handshake, so a restarted sidecar runs them again. `cwd` omitted: every watched workspace.
   */
  "schedule.list": {
    params: z.object({ cwd: z.string().min(1).optional() }),
    result: z.object({ schedules: z.array(ScheduleSchema) }),
  },
  "schedule.save": {
    params: z.object({
      cwd: z.string().min(1),
      /** Omitted for a new schedule. */
      id: z.string().optional(),
      taskId: TaskIdSchema,
      cadence: CadenceSchema,
      enabled: z.boolean(),
    }),
    result: z.object({ schedule: ScheduleSchema }),
  },
  "schedule.delete": { params: z.object({ cwd: z.string().min(1), id: z.string() }), result: Ok },
  /** Runs it now, as its time would; its next time stays as it was. */
  "schedule.runNow": {
    params: z.object({ cwd: z.string().min(1), id: z.string() }),
    result: z.object({ schedule: ScheduleSchema }),
  },
  "schedule.watch": {
    params: z.object({ cwds: z.array(z.string().min(1)).max(200) }),
    result: z.object({ schedules: z.array(ScheduleSchema) }),
  },
  /** Starting points for a new agent (M8-04): the shipped task roles and a few starters. */
  "agents.templates": { params: Empty, result: z.object({ templates: z.array(AgentTemplateSchema) }) },
  /** Adds a rule to one of the files; it's kept once. `user` writes the CLI's user settings (ADR-0013). */
  "permissions.add": {
    params: z.object({
      cwd: z.string().min(1),
      behavior: z.enum(["allow", "ask", "deny"]),
      rule: PermissionRuleTextSchema,
      scope: RuleScopeSchema,
    }),
    result: Ok,
  },
  "permissions.remove": {
    params: z.object({
      cwd: z.string().min(1),
      behavior: z.enum(["allow", "ask", "deny"]),
      rule: z.string().min(1),
      scope: RuleScopeSchema.optional(),
    }),
    result: Ok,
  },

  /* Stored sessions (SDK session APIs, ADR-0004). Includes sessions started in the terminal CLI (M1-22). */
  "session.list": {
    params: z.object({ cwd: z.string().min(1), limit: z.number().int().positive().max(500).optional() }),
    result: z.object({ sessions: z.array(SessionInfoSchema) }),
  },
  /** The main conversation of a stored session as events, to render before resuming it. */
  /**
   * A stored session as live events, its subagents' transcripts included (M4-08). `times[i]` is when `events[i]`
   * happened (epoch ms), `null` when unknown.
   */
  "session.history": {
    params: StoredSessionRef.extend({ agent: StepAgentSchema.optional() }),
    result: z.object({ events: z.array(AgentEventSchema), times: z.array(z.number().nullable()).optional() }),
  },
  "session.rename": { params: StoredSessionRef.extend({ title: z.string().trim().min(1).max(200) }), result: Ok },
  /** `tag: null` clears the tag. */
  "session.tag": { params: StoredSessionRef.extend({ tag: z.string().trim().max(50).nullable() }), result: Ok },
  "session.delete": { params: StoredSessionRef, result: Ok },
  /** Copies a stored session into a new one (without its file checkpoints) and returns the new id. */
  "session.fork": { params: StoredSessionRef, result: z.object({ sessionId: SessionIdSchema }) },
  /** How long Claude Code keeps session transcripts (`cleanupPeriodDays`, M1-24). No other settings leave the sidecar. */
  "session.retention": {
    params: z.object({ cwd: z.string().min(1) }),
    result: z.object({ days: z.number(), source: z.string() }),
  },

  /* Workspace files and git (M1-25…M1-27), through the system git CLI. */
  "workspace.files": { params: WorkspaceRef, result: WorkspaceFilesSchema },
  "workspace.diff": { params: WorkspacePath, result: FileDiffSchema },
  /** An image in the workspace, for the file viewer (UX-21). Read-only. */
  "workspace.image": { params: WorkspacePath, result: WorkspaceImageSchema },
  /** Reverts a file to HEAD (a new file is deleted), or only hunk `hunk` of `workspace.diff`. */
  "workspace.revert": { params: WorkspacePath.extend({ hunk: z.number().int().min(0).optional() }), result: Ok },
  /** Offered when the workspace isn't a git repository (M1-06). */
  "workspace.gitInit": { params: WorkspaceRef, result: Ok },

  /** Detects stacks and commands and audits the agent setup (M2-06…M2-09). Read-only. */
  "workspace.scan": {
    params: WorkspaceRef,
    result: z.object({ profile: WorkspaceProfileSchema, findings: z.array(FindingSchema) }),
  },
  /** Writes the profile to `.agentchainer/profile.json`, kept out of git by `.agentchainer/.gitignore` (M2-10). */
  "workspace.saveProfile": { params: WorkspaceRef, result: z.object({ path: z.string() }) },

  /**
   * The bootstrap plan for a workspace (M2-11): fixes from the audit, catalog items from the suggested profiles plus
   * any opt-in `profiles`, and generators. Read-only: nothing is applied.
   */
  "bootstrap.plan": {
    params: WorkspaceRef.extend({ profiles: z.array(z.string()).optional() }),
    result: BootstrapPlanSchema,
  },

  /**
   * Applies the given plan actions (M2-13…M2-16). The plan is rebuilt first, so only actions that are currently
   * selectable run. Files are backed up before their first change; the run is recorded in `.agentchainer/lock.json`.
   */
  "bootstrap.apply": {
    params: WorkspaceRef.extend({
      actions: z.array(z.string()).min(1),
      profiles: z.array(z.string()).optional(),
      /** Actions whose `installCommand` the user allowed to run before verification (M2-23). */
      install: z.array(z.string()).optional(),
    }),
    result: ApplyResultSchema,
  },
  /**
   * The opt-in auto-apply before a new session (M2-18): only recommended first-party and official catalog items and
   * the low-risk fixes, never generators or vendor and community items. `runId` is null when nothing applied.
   */
  "bootstrap.autoApply": {
    params: WorkspaceRef,
    result: ApplyResultSchema.extend({ runId: z.string().nullable() }),
  },
  /**
   * Runs a generator (M2-19…M2-25): a read-only Claude session proposes files, which are checked and then offered in
   * the plan as a diff to review. Writes nothing. Costs a model call; `costUsd` is the estimate.
   */
  "bootstrap.generate": {
    params: WorkspaceRef.extend({ action: z.string().min(1), model: z.string().optional() }),
    result: z.object({
      summary: z.string(),
      files: z.array(z.string()),
      checks: z.array(CheckSchema),
      attempts: z.number().int(),
      costUsd: z.number(),
    }),
  },
  "bootstrap.runs": { params: WorkspaceRef, result: z.object({ runs: z.array(BootstrapRunSchema) }) },
  /**
   * Rolls back a run, or one action of it (M2-17): CLI changes are undone and files restored byte for byte. A file
   * edited since the run is left alone (`conflict`) unless `force`.
   */
  "bootstrap.rollback": {
    params: WorkspaceRef.extend({
      runId: z.string().regex(/^[\w-]+$/),
      actionId: z.string().optional(),
      force: z.boolean().optional(),
    }),
    result: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          status: z.enum(["rolled-back", "conflict", "failed", "kept"]),
          message: z.string().optional(),
        }),
      ),
    }),
  },

  /* The Plugins page (UX-10, ADR-0010): every call goes through the user's own CLI. */
  /** Installed and listed plugins. The listing is kept for the app session; `refresh` asks the CLI again. */
  "plugins.list": {
    params: WorkspaceRef.extend({ refresh: z.boolean().optional() }),
    result: z.object({
      available: z.array(MarketPluginSchema),
      installed: z.array(InstalledPluginSchema),
      marketplaces: z.array(z.object({ name: z.string(), repo: z.string().optional(), official: z.boolean() })),
      fetchedAt: z.string(),
    }),
  },
  /**
   * What an installed plugin brings: the CLI's own text, and the counts read from it when its format is known. Plugins
   * that aren't installed have no details yet.
   */
  "plugins.details": {
    params: WorkspaceRef.extend({ id: z.string().regex(/^[\w.-]+@[\w.-]+$/) }),
    result: z.object({
      text: z.string(),
      inventory: z
        .object({
          skills: z.array(z.string()),
          agents: z.array(z.string()),
          hooks: z.array(z.string()),
          mcpServers: z.array(z.string()),
          lspServers: z.array(z.string()),
        })
        .optional(),
      alwaysOnTokens: z.number().optional(),
    }),
  },
  /** Installs a plugin for this workspace, recorded as a History run like a setup step. */
  "plugins.install": {
    params: WorkspaceRef.extend({
      id: z.string().regex(/^[\w.-]+@[\w.-]+$/),
      scope: PluginInstallScopeSchema,
      acceptCommand: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
    result: PluginChangeSchema,
  },
  "plugins.update": {
    params: WorkspaceRef.extend({
      id: z.string().regex(/^[\w.-]+@[\w.-]+$/),
      scope: PluginInstallScopeSchema,
      acceptCommand: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
    result: PluginChangeSchema,
  },
  "plugins.uninstall": {
    params: WorkspaceRef.extend({ id: z.string().regex(/^[\w.-]+@[\w.-]+$/), scope: PluginInstallScopeSchema }),
    result: Ok,
  },
  /** Turns an installed plugin off or on for this workspace, without uninstalling it. */
  "plugins.setEnabled": {
    params: WorkspaceRef.extend({
      id: z.string().regex(/^[\w.-]+@[\w.-]+$/),
      scope: PluginInstallScopeSchema,
      enabled: z.boolean(),
    }),
    result: Ok,
  },

  /* Git panel (M1-30). Never force-pushes. */
  "git.branches": {
    params: WorkspaceRef,
    result: z.object({
      current: z.string().nullable(),
      branches: z.array(z.string()),
      /** Remote branches with no local branch of the same name, e.g. "origin/feature-x". */
      remote: z.array(z.string()),
      upstream: z.string().nullable(),
      ahead: z.number().int(),
      behind: z.number().int(),
      /** A merge in progress: the branch being merged, when known, and the files with conflicts. */
      merging: z.object({ branch: z.string().nullable(), conflicts: z.array(z.string()) }).nullable(),
    }),
  },
  "git.switch": {
    params: WorkspaceRef.extend({
      branch: z.string().min(1).max(250),
      create: z.boolean().optional(),
      /** `branch` is a remote branch: create the local branch that tracks it. */
      track: z.boolean().optional(),
    }),
    result: Ok,
  },
  "git.stage": { params: WorkspaceRef.extend({ paths: z.array(z.string().min(1)).min(1) }), result: Ok },
  "git.unstage": { params: WorkspaceRef.extend({ paths: z.array(z.string().min(1)).min(1) }), result: Ok },
  "git.commit": { params: WorkspaceRef.extend({ message: z.string().min(1) }), result: z.object({ sha: z.string() }) },
  "git.push": { params: WorkspaceRef, result: z.object({ output: z.string() }) },
  "git.fetch": { params: WorkspaceRef, result: z.object({ output: z.string() }) },
  /** Fast-forward only: a diverged branch fails with a message, and is never merged behind the user's back. */
  "git.pull": { params: WorkspaceRef, result: z.object({ output: z.string() }) },
  /** Without `force`, an unmerged branch isn't deleted and comes back as `unmerged`, so the UI can ask again. */
  "git.deleteBranch": {
    params: WorkspaceRef.extend({ branch: z.string().min(1).max(250), force: z.boolean().optional() }),
    result: z.object({ deleted: z.boolean(), unmerged: z.boolean() }),
  },
  "git.renameBranch": {
    params: WorkspaceRef.extend({ from: z.string().min(1).max(250), to: z.string().min(1).max(250) }),
    result: Ok,
  },
  /** Merges a branch into the current one. Conflicts aren't an error: the merge stays in progress. */
  "git.merge": {
    params: WorkspaceRef.extend({ branch: z.string().min(1).max(250) }),
    result: z.object({ merged: z.boolean(), conflicts: z.array(z.string()) }),
  },
  "git.abortMerge": { params: WorkspaceRef, result: Ok },
  /** A commit message drafted by Claude (haiku, no tools) from the staged diff, for the user to edit. */
  "git.draftMessage": { params: WorkspaceRef, result: z.object({ message: z.string() }) },

  /* Tasks (M3-02, M3-03). Files in `.agentchainer/tasks/<id>/`, kept out of git. */
  "task.create": {
    params: WorkspaceRef.extend({
      request: z.string().min(1).max(20_000),
      /** The chat it's made from (UX-13): its last messages, for drafting. */
      context: z.string().max(12_000).optional(),
      /** A multi-folder workspace's other folders (M8-01), checked like `session.start`'s. */
      folders: z.array(z.string().min(1).max(4096)).max(16).optional(),
    }),
    result: TaskSchema,
  },
  /**
   * A read-only Claude session drafts the contract from the request and the repo, then triage runs on the draft
   * (signals and a haiku classification). Writes nothing but the task's own files. Costs model calls (`costUsd`).
   */
  "task.draft": { params: TaskRef.extend({ model: z.string().optional() }), result: TaskSchema },
  /**
   * Drafts the contract again with the person's reply (UX-13): the current contract and the feedback go to the same
   * read-only drafting, then triage runs again. Its events stream like `task.draft`'s.
   */
  "task.redraft": {
    params: TaskRef.extend({ feedback: z.string().min(1).max(4000), model: z.string().optional() }),
    result: TaskSchema,
  },
  /** Saves the user's edits to a draft contract and triages it again. */
  "task.retriage": { params: TaskRef.extend({ contract: TaskContractSchema }), result: TaskSchema },
  /**
   * Approves the contract and the tier together. Refused if the contract differs from the one last triaged; a tier
   * other than the proposal needs a reason, which is recorded.
   */
  "task.approve": {
    params: TaskRef.extend({
      contract: TaskContractSchema,
      tier: TierSchema,
      reason: z.string().optional(),
      /** null: no spend cap for the task as a whole. */
      budgetUsd: z.number().positive().max(1000).nullable(),
    }),
    result: TaskSchema,
  },
  /** Reopens an approved contract for editing. Edits then need a new triage before approval. */
  "task.revise": { params: TaskRef, result: TaskSchema },
  /**
   * Runs an approved S or M task (M3-06): returns at once, and the run continues, reporting through `task.updated`.
   * Write steps ask for approvals in `permissionMode`.
   */
  "task.start": {
    params: TaskRef.extend({
      permissionMode: PermissionModeSchema.exclude(["plan"]),
      model: z.string().optional(),
      /** The agent per role (M9-06); every agent it names must be installed, or the run doesn't start. */
      agents: AgentRolesSchema.optional(),
    }),
    result: TaskSchema,
  },
  /**
   * AI writes the task's own flow from its contract (UX-14): the tier's workflow, changed only where the task calls for
   * it, checked like a project's. A draft S, M or L task only; the person drops it or approves it with the contract.
   */
  "task.proposeFlow": { params: TaskRef.extend({ model: z.string().optional() }), result: TaskSchema },
  /** Drops the task's own flow: it runs its tier's again. */
  "task.dropFlow": { params: TaskRef, result: TaskSchema },
  /**
   * The workflow a task's Flow tab draws (UX-14): its run's, or before a run, its tier's now. Null before triage.
   * The workflow's own shape, as in its YAML.
   */
  "task.workflow": {
    params: TaskRef,
    result: z
      .object({ workflow: z.record(z.string(), z.unknown()), source: z.enum(["app", "project", "task"]) })
      .nullable(),
  },
  /**
   * The person's message to a running task's current step (UX-13): it goes into the turn that's running, as in a chat.
   * Refused when no step is working.
   */
  "task.message": {
    params: TaskRef.extend({ text: z.string().min(1).max(8000) }),
    result: z.object({ sent: z.boolean() }),
  },
  /** Continues an interrupted run from the step it stopped in. */
  "task.resume": { params: TaskRef, result: TaskSchema },
  /** Ends a failed or unverified run as accepted with risk; the reason goes into the evidence (M3-10). */
  "task.acceptRisk": { params: TaskRef.extend({ reason: z.string().min(1).max(2000) }), result: TaskSchema },
  /**
   * The task's evidence report (M3-09), built from the run's records: markdown, and where it's kept
   * (`.agentchainer/tasks/<id>/evidence.md`).
   */
  "task.evidence": { params: TaskRef, result: z.object({ markdown: z.string(), path: z.string() }) },
  /**
   * Lessons from a finished task (M8-06): one small read-only model call words what the run's records point at as
   * CLAUDE.md lines; none, and no call, when nothing does. `stored` returns the last suggestions without a call.
   */
  "task.lessons": {
    params: TaskRef.extend({ model: z.string().optional(), stored: z.boolean().optional() }),
    result: z.object({ lessons: z.array(LessonSchema), costUsd: z.number(), note: z.string().optional() }),
  },
  /** CLAUDE.md before and after the picked lessons, for the diff. */
  "task.lessonsPreview": {
    params: TaskRef.extend({ ids: z.array(z.string()).min(1) }),
    result: z.object({ path: z.string(), before: z.string(), after: z.string() }),
  },
  /** Adds the picked lessons to CLAUDE.md as a History run; the rest are dismissed. */
  "task.lessonsApply": {
    params: TaskRef.extend({ ids: z.array(z.string()).min(1) }),
    result: z.object({ runId: z.string(), path: z.string() }),
  },
  /** Never offers these again in this workspace. */
  "task.lessonsDismiss": {
    params: TaskRef.extend({ ids: z.array(z.string()).min(1) }),
    result: z.object({ lessons: z.array(LessonSchema) }),
  },
  /**
   * XL (M3-07): a read-only session splits the approved contract into sub-tasks, created as draft tasks with their own
   * contracts and triage. Again replaces sub-tasks that haven't run.
   */
  "task.split": { params: TaskRef.extend({ model: z.string().optional() }), result: TaskSchema },
  /** Approves every draft sub-task as drafted (contract and tier). */
  "task.approveSubtasks": { params: TaskRef, result: TaskSchema },
  /** Picks a stopped, failed or interrupted XL run up again: merged sub-tasks are skipped, the others run. */
  "task.continue": { params: TaskRef, result: TaskSchema },
  /**
   * Merges a finished task's branch into the workspace's current branch, after committing what its run left in its
   * worktree (M5-01); conflicts leave the merge in progress.
   */
  "task.mergeResult": {
    params: TaskRef,
    result: z.object({ merged: z.boolean(), conflicts: z.array(z.string()), into: z.string() }),
  },
  /** Removes a task's worktrees (an XL task's sub-tasks' too), and its branches when asked. */
  "task.cleanup": { params: TaskRef.extend({ deleteBranches: z.boolean() }), result: Ok },
  /** Whether pull requests can be made here through the user's `gh` (M5-02). */
  "github.status": { params: WorkspaceRef, result: GitHubStatusSchema },
  /**
   * What Create PR would send (M5-02): the `gh` status, the base branch, the title and the body built from the contract
   * and the evidence, and the task's PR when it has one already. Nothing is pushed or sent.
   */
  "task.prPreview": {
    params: TaskRef,
    result: z.object({
      github: GitHubStatusSchema,
      base: z.string(),
      head: z.string(),
      title: z.string(),
      body: z.string(),
    }),
  },
  /**
   * Commits what the run left, scans the changed files for secrets, pushes the task's branch (never forced) and opens
   * a pull request through `gh` (M5-02). The body is built here, not taken from the UI. A branch that has a PR already
   * gets that one recorded instead of a second.
   */
  "task.createPr": {
    params: TaskRef.extend({ title: z.string().trim().min(1).max(256), draft: z.boolean() }),
    result: TaskSchema,
  },
  /** The task's PR on GitHub and its checks, read through `gh` (M5-03). The page polls it while it's open. */
  "task.prStatus": {
    params: TaskRef,
    result: z.object({
      state: z.string(),
      draft: z.boolean(),
      headSha: z.string(),
      checks: z.array(PrCheckSchema),
    }),
  },
  /**
   * The failed steps' log of one of the PR's GitHub Actions checks, cut to its end and redacted (M5-03). The check is
   * named by its link, which must be one of the PR's checks.
   */
  "task.ciLog": { params: TaskRef.extend({ link: z.string().min(1) }), result: z.object({ log: z.string() }) },
  /**
   * One Fix CI round (M5-03), after the user saw the log: the implementer fixes the code with the log as data, the
   * gates run, and when they pass the branch is committed and pushed again (never forced). Runs in the background
   * like a run; at most `MAX_CI_FIXES` rounds.
   */
  "task.fixCi": { params: TaskRef.extend({ link: z.string().min(1) }), result: TaskSchema },
  /**
   * The merge gates of the task's PR (M5-04), worked out now: the run, the review of the current head, gitleaks, semgrep
   * and trivy when installed (offline only), and CI. Also the merge methods the repository allows.
   */
  "task.mergeGates": {
    params: TaskRef,
    result: z.object({
      headSha: z.string(),
      draft: z.boolean(),
      gates: z.array(MergeGateSchema),
      methods: z.array(MergeMethodSchema),
      defaultMethod: MergeMethodSchema,
    }),
  },
  /** Runs the independent reviewer on the PR's diff (M5-04), in the background like a run; the task records the verdict. */
  "task.reviewPr": { params: TaskRef, result: TaskSchema },
  /**
   * Merges the task's PR on GitHub (M5-05): only from a person's click and confirmation, with the head the gates were
   * worked out for (`--match-head-commit`). Gates that hold Merge back need `acceptReason`, which the task keeps. A
   * draft is marked ready first. Never `--auto`.
   */
  "task.mergePr": {
    params: TaskRef.extend({
      method: MergeMethodSchema,
      headSha: z.string().min(7),
      acceptReason: z.string().trim().min(1).max(2000).optional(),
    }),
    result: TaskSchema,
  },
  /** The providers this workspace can deploy to, with their CLI's state (M6-01). Runs only `whoami`-style checks. */
  "deploy.targets": { params: WorkspaceRef, result: z.object({ targets: z.array(DeployTargetSchema) }) },
  /**
   * Deploys a task's worktree as a preview with the provider's own CLI, then runs the smoke test on its URL (M6-01,
   * M6-03). Always from a person's click; never production.
   */
  "deploy.preview": {
    params: TaskRef.extend({ adapter: DeployAdapterSchema }),
    result: DeployRecordSchema,
  },
  /** What a production deploy of the workspace's current branch would run (M6-02). Runs only `whoami`-style checks. */
  "deploy.plan": {
    params: WorkspaceRef.extend({ adapter: DeployAdapterSchema }),
    result: DeployPlanSchema,
  },
  /**
   * Deploys the workspace's current branch to production, then runs the smoke test (M6-02, M6-03). Only from a
   * person's click: `confirm` is the project's name as they typed it, and `commit` the one the plan showed.
   */
  "deploy.production": {
    params: WorkspaceRef.extend({
      adapter: DeployAdapterSchema,
      confirm: z.string(),
      commit: z.string().min(7),
    }),
    result: DeployRecordSchema,
  },
  /** Rolls the live production deploy back to the one before it, with the provider's own rollback (M6-03). */
  "deploy.rollback": {
    params: WorkspaceRef.extend({ id: z.string().min(1), confirm: z.string() }),
    result: DeployRecordSchema,
  },
  /** The workspace's deploys, newest first; a task's only, with `taskId`. */
  /** Names the image a Docker deploy pushes to (`.agentchainer/docker.json`), or clears it with null (M6-01). */
  "deploy.setDockerImage": {
    params: WorkspaceRef.extend({
      image: DockerImageSchema.nullable(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  "deploy.list": {
    params: WorkspaceRef.extend({ taskId: TaskIdSchema.optional() }),
    result: z.object({ deploys: z.array(DeployRecordSchema) }),
  },
  /** Other tasks whose live branches change the same files as this one's: merging both may conflict (M5-01). */
  /**
   * The workflow each tier runs in this workspace, and the project workflow files that can't be used, with why
   * (M6-04). Reads `.agentchainer/workflows/` only.
   */
  /** The workspace's default agent per role (M9-06): who plans, implements and reviews when a task doesn't choose. */
  "workspace.agents": { params: WorkspaceRef, result: AgentRolesSchema },
  /** Saves them to `.agentchainer/agents.json`, out of git; Claude for a role is the same as no default. */
  "workspace.setAgents": { params: WorkspaceRef.extend({ agents: AgentRolesSchema }), result: AgentRolesSchema },
  /** The app's task defaults, from Settings: sent at the start and on every change, so scheduled runs use them too. */
  "app.setDefaults": { params: z.object({ defaults: TaskDefaultsSchema }), result: z.object({ ok: z.literal(true) }) },
  /** A workspace's task defaults, the app's, and what they come to. */
  "workspace.defaults": { params: WorkspaceRef, result: TaskDefaultsViewSchema },
  /** Replaces a workspace's own task defaults (`.agentchainer/defaults.json`, out of git); `{}` follows the app. */
  "workspace.setDefaults": {
    params: WorkspaceRef.extend({ defaults: TaskDefaultsSchema }),
    result: TaskDefaultsViewSchema,
  },
  "workflow.list": {
    params: WorkspaceRef,
    result: z.object({ workflows: z.array(TierWorkflowSchema), problems: z.array(ProjectWorkflowProblemSchema) }),
  },
  /**
   * A tier's workflow as YAML for the canvas (M6-04): the project's file when there is one (even an invalid one, to
   * fix), else the app's, rendered as a starting point.
   */
  "workflow.get": {
    params: WorkspaceRef.extend({ tier: z.enum(TIERS) }),
    result: z.object({ yaml: z.string(), source: z.enum(["app", "project"]), file: z.string() }),
  },
  /**
   * Generate with AI (UX-14): a model writes the tier's workflow from the person's description, starting from `current`
   * (the editor's text). It's checked like a hand-written one and retried once; nothing is saved.
   */
  "workflow.generate": {
    params: WorkspaceRef.extend({
      tier: z.enum(["S", "M", "L"]),
      description: z.string().min(1).max(4000),
      current: z.string().max(65_536),
      model: z.string().optional(),
    }),
    result: z.object({
      yaml: z.string().nullable(),
      summary: z.string(),
      error: z.string().optional(),
      costUsd: z.number(),
    }),
  },
  /** Checks a workflow's YAML the way a run would; null when it can be used. */
  "workflow.check": {
    params: WorkspaceRef.extend({ tier: z.enum(TIERS), yaml: z.string().max(65_536) }),
    result: z.object({ error: z.string().nullable() }),
  },
  /** Saves a valid workflow as the project's `.agentchainer/workflows/<tier>.yaml`; null removes it (the app's again). */
  "workflow.save": {
    params: WorkspaceRef.extend({ tier: z.enum(TIERS), yaml: z.string().max(65_536).nullable() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Import and Export: a workflow file at a path the person picked in the system's file dialog. */
  "workflow.import": {
    params: z.object({ path: z.string().min(1) }),
    result: z.object({ yaml: z.string() }),
  },
  "workflow.export": {
    params: z.object({ path: z.string().min(1), yaml: z.string().max(65_536) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** The workspace's task metrics (M7-01), from its own task records; `since` and `tier` narrow them. */
  "usage.report": { params: UsageParams, result: UsageReportSchema },
  /** Writes the report to a file the person chose: every session as CSV rows, or the whole report as JSON. */
  "usage.export": {
    params: UsageParams.extend({ path: z.string().min(1), format: z.enum(["csv", "json"]) }),
    result: z.object({ ok: z.literal(true), rows: z.number() }),
  },
  "metrics.summary": {
    params: WorkspaceRef.extend({ since: z.string().optional(), tier: z.enum(TIERS).optional() }),
    result: MetricsSummarySchema,
  },
  "task.overlaps": {
    params: TaskRef,
    result: z.object({
      overlaps: z.array(z.object({ taskId: z.string(), title: z.string(), files: z.array(z.string()) })),
    }),
  },
  /** Stops a draft, a triage or a run in progress. A stopped run leaves the working tree as it is. */
  "task.cancel": { params: TaskRef, result: z.object({ cancelled: z.boolean() }) },
  "task.list": { params: WorkspaceRef, result: z.object({ tasks: z.array(TaskSummarySchema) }) },
  "task.get": { params: TaskRef, result: TaskSchema },
  "task.delete": { params: TaskRef, result: Ok },
} as const;

export type MethodName = keyof typeof methodSchemas;
export type Methods = {
  [M in MethodName]: {
    params: z.input<(typeof methodSchemas)[M]["params"]>;
    result: z.output<(typeof methodSchemas)[M]["result"]>;
  };
};

/* ---------- Notifications: sidecar → UI ---------- */

/** Marks a session as a task's step, so the UI shows it on the task page and routes its approvals. */
export const TaskTagSchema = z.object({
  id: TaskIdSchema,
  cwd: z.string(),
  stepId: z.string(),
  label: z.string(),
  role: z.string().optional(),
  /** The task's short title, for lists across tasks such as the fleet view (M8-02). */
  title: z.string().optional(),
  /** A step of a run a schedule started (M8-05): nobody may be watching, so the UI notifies on its approvals. */
  scheduled: z.boolean().optional(),
});
export type TaskTag = z.infer<typeof TaskTagSchema>;

/**
 * One live session in the fleet view (M8-02, docs/design/workspaces-and-fleet.md §4): a chat, or a task step's session
 * (`task` set). The status is the sidecar's own, so the fleet and the sidebar agree.
 */
export const FleetItemSchema = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  status: z.enum(["working", "waiting", "idle", "ended"]),
  /** Approvals and questions waiting for the person. */
  waiting: z.number().int(),
  costUsd: z.number(),
  startedAt: z.string(),
  /** When the status last changed. */
  since: z.string(),
  task: TaskTagSchema.optional(),
  /** A Team chat's worker (M8-03): the supervisor's session id. */
  parentId: z.string().optional(),
  /** A task step on another agent (M9-07): which one, its model, and whether `costUsd` is an estimate. */
  agent: StepAgentSchema.optional(),
  model: z.string().optional(),
  costKind: CostKindSchema.optional(),
});
export type FleetItem = z.infer<typeof FleetItemSchema>;

/**
 * A session the sidecar opened on its own (M8-03): a Team chat's worker. Sent before the worker's first message, so
 * the UI has its tab before any of its events arrive.
 */
export const SessionOpenedSchema = z.object({
  sessionId: z.string(),
  /** The supervisor's session id. */
  parentId: z.string(),
  cwd: z.string(),
  /** The name the supervisor gave the worker. */
  name: z.string(),
  /** `read`: Read, Grep and Glob only. `write`: the supervisor's tools, under the usual approvals. */
  access: z.enum(["read", "write"]),
  /** The agent profile the worker runs as (M8-04). */
  profile: z.string().optional(),
});
export type SessionOpened = z.infer<typeof SessionOpenedSchema>;

export const PermissionRequestSchema = z.object({
  sessionId: z.string(),
  /** Set for a task step's session (M3-06), which has no tab of its own. */
  task: TaskTagSchema.optional(),
  requestId: z.string(),
  toolName: z.string(),
  toolUseId: z.string(),
  agentId: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  title: z.string().optional(),
  description: z.string().optional(),
  /** Why the CLI asks, e.g. a path outside the allowed folders. */
  decisionReason: z.string().optional(),
  blockedPath: z.string().optional(),
  /**
   * Rules "Always allow" would save to `.claude/settings.local.json`, e.g. `Bash(npm test:*)`. Empty when the CLI
   * offers none, or when such a rule would grant more than this request (`suppressAlwaysAllowRule`).
   */
  alwaysRules: z.array(z.string()),
  /** Open the prompt on Deny, with no one-key approve. */
  defaultToNo: z.boolean().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const AgentEventNotificationSchema = z.object({
  sessionId: z.string(),
  event: AgentEventSchema,
  task: TaskTagSchema.optional(),
});

export const notificationSchemas = {
  "agent.event": AgentEventNotificationSchema,
  "permission.request": PermissionRequestSchema,
  /** A task's run changed: a step started or ended, gates ran, or the run ended (M3-06). */
  "task.updated": z.object({ cwd: z.string(), task: TaskSchema }),
  /** A session's fleet status changed (M8-02): working, waiting for the person, idle or ended. */
  "fleet.changed": z.object({ item: FleetItemSchema }),
  /** A schedule was saved, ran or was skipped (M8-05). */
  "schedule.changed": z.object({ schedule: ScheduleSchema }),
  /** A schedule was deleted. */
  "schedule.deleted": z.object({ cwd: z.string(), id: z.string() }),
  /** The sidecar opened a session on its own: a Team chat's worker (M8-03). */
  "session.opened": SessionOpenedSchema,
} as const;

export type NotificationName = keyof typeof notificationSchemas;
export type Notifications = { [N in NotificationName]: z.infer<(typeof notificationSchemas)[N]> };

/** Params as handlers receive them (after validation and defaults) and results as they must return them. */
export type MethodParams<M extends MethodName> = z.output<(typeof methodSchemas)[M]["params"]>;
export type MethodResult<M extends MethodName> = Methods[M]["result"];

export const isMethodName = (name: string): name is MethodName => Object.hasOwn(methodSchemas, name);
export const isNotificationName = (name: string): name is NotificationName => Object.hasOwn(notificationSchemas, name);

/** Human-readable validation errors, so callers never need to import zod themselves. */
export function describeIssues(error: z.ZodError): string {
  return z.prettifyError(error);
}

/* ---------- Approval risk (UX-05), shared by the approval dialog and a task's evidence (M3-09) ---------- */

export {
  commandRisk,
  type Described,
  describeRequest,
  displayPath,
  insideWorkspace,
  type Risk,
  type RiskLevel,
} from "./approval.ts";
export { folderKey, folderProblems } from "./folders.ts";
export {
  asLanguage,
  catalog,
  currentLanguage,
  currentLocale,
  inEnglish,
  type KeyOf,
  LANGUAGES,
  type Language,
  type Params,
  type RichPart,
  setLanguage,
  setPseudo,
  translationProblems,
} from "./i18n.ts";
export { hasSecret, redactForLog, redactSecrets, redactValue } from "./redact.ts";
export {
  literalRef,
  RESULTS,
  RESULTS_INDONESIAN,
  type ResultKey,
  resultEnglish,
  resultRef,
  resultText,
} from "./results/index.ts";
