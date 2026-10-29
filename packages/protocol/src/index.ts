import { z } from "zod";

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

const WorkspaceRef = z.object({ cwd: z.string().min(1) });
/** A file inside the workspace; the sidecar rejects absolute paths and `..`. */
const WorkspacePath = WorkspaceRef.extend({ path: z.string().min(1) });

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
  }),
  z.object({
    type: z.literal("tool.completed"),
    toolUseId: z.string(),
    isError: z.boolean(),
    output: z.string(),
    parentToolUseId: z.string().nullable(),
  }),
  /** A subagent was spawned by the Agent tool call `toolUseId` (spike S4). */
  z.object({
    type: z.literal("agent.started"),
    toolUseId: z.string(),
    taskId: z.string(),
    description: z.string(),
    agentType: z.string().optional(),
    depth: z.number().optional(),
    background: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("agent.text"),
    parentToolUseId: z.string(),
    agentId: z.string().optional(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent.completed"),
    toolUseId: z.string(),
    taskId: z.string(),
    status: z.string(),
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
  /** Readiness of the user's machine (spike S5). Never includes account identity (email, org). */
  "env.check": { params: Empty, result: EnvCheckSchema },
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
    }),
    result: z.object({ sessionId: SessionIdSchema }),
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
    }),
    result: Ok,
  },
  /** Permission rules in the workspace's `.claude/settings.local.json` (M1-20). Other settings never leave the sidecar. */
  "permissions.list": {
    params: z.object({ cwd: z.string().min(1) }),
    result: z.object({ allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()) }),
  },
  "permissions.remove": {
    params: z.object({ cwd: z.string().min(1), behavior: z.enum(["allow", "ask", "deny"]), rule: z.string().min(1) }),
    result: Ok,
  },

  /* Stored sessions (SDK session APIs, ADR-0004). Includes sessions started in the terminal CLI (M1-22). */
  "session.list": {
    params: z.object({ cwd: z.string().min(1), limit: z.number().int().positive().max(500).optional() }),
    result: z.object({ sessions: z.array(SessionInfoSchema) }),
  },
  /** The main conversation of a stored session as events, to render before resuming it. */
  "session.history": {
    params: StoredSessionRef,
    result: z.object({ events: z.array(AgentEventSchema) }),
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

  /* Git panel (M1-30). Never force-pushes. */
  "git.branches": {
    params: WorkspaceRef,
    result: z.object({
      current: z.string().nullable(),
      branches: z.array(z.string()),
      upstream: z.string().nullable(),
      ahead: z.number().int(),
      behind: z.number().int(),
    }),
  },
  "git.switch": {
    params: WorkspaceRef.extend({ branch: z.string().min(1).max(250), create: z.boolean().optional() }),
    result: Ok,
  },
  "git.stage": { params: WorkspaceRef.extend({ paths: z.array(z.string().min(1)).min(1) }), result: Ok },
  "git.unstage": { params: WorkspaceRef.extend({ paths: z.array(z.string().min(1)).min(1) }), result: Ok },
  "git.commit": { params: WorkspaceRef.extend({ message: z.string().min(1) }), result: z.object({ sha: z.string() }) },
  "git.push": { params: WorkspaceRef, result: z.object({ output: z.string() }) },
  /** A commit message drafted by Claude (haiku, no tools) from the staged diff, for the user to edit. */
  "git.draftMessage": { params: WorkspaceRef, result: z.object({ message: z.string() }) },
} as const;

export type MethodName = keyof typeof methodSchemas;
export type Methods = {
  [M in MethodName]: {
    params: z.input<(typeof methodSchemas)[M]["params"]>;
    result: z.output<(typeof methodSchemas)[M]["result"]>;
  };
};

/* ---------- Notifications: sidecar → UI ---------- */

export const PermissionRequestSchema = z.object({
  sessionId: z.string(),
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

export const AgentEventNotificationSchema = z.object({ sessionId: z.string(), event: AgentEventSchema });

export const notificationSchemas = {
  "agent.event": AgentEventNotificationSchema,
  "permission.request": PermissionRequestSchema,
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
