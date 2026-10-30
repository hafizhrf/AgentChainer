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
/** The two rule files a workspace has; session rules aren't stored. */
export const RuleScopeSchema = z.enum(["workspace", "team"]);
export type RuleScope = z.infer<typeof RuleScopeSchema>;
const RulesSchema = z.object({ allow: z.array(z.string()), ask: z.array(z.string()), deny: z.array(z.string()) });

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
export type Tier = (typeof TIERS)[number];
export const TierSchema = z.enum(TIERS);

/** Gates the sidecar runs from the workspace profile's commands (M3-08). */
export const GATE_KINDS = ["format", "lint", "typecheck", "test", "build", "smoke"] as const;
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
    .object({ tier: TierSchema, rationale: z.string(), confidence: z.enum(["low", "medium", "high"]) })
    .nullable(),
  modelError: z.string().optional(),
  /** The higher of the model's tier and the floor: a risk keyword can't be talked down. */
  proposed: TierSchema,
  /** What the task runs at: the proposal, unless the user picked another tier with a reason. */
  chosen: TierSchema,
  override: z.object({ reason: z.string().min(1) }).optional(),
  /** The task's spend cap, defaulting by tier. */
  budgetUsd: z.number().positive(),
  at: z.string(),
});
export type Triage = z.infer<typeof TriageSchema>;

/** `<date>-<8 hex>`, e.g. 2026-10-30-1a2b3c4d. Checked before it becomes part of a path. */
export const TaskIdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);

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
export const StepRunSchema = z.object({
  /** Unique within the run, e.g. `implement`, `gates-2`, `fix-1`. */
  id: z.string(),
  /** The template step it belongs to. */
  step: z.string(),
  label: z.string(),
  kind: z.enum(["agent", "fix", "gates", "baseline"]),
  role: z.string().optional(),
  /** Steps that run at the same time (L's planners) share their parallel step's label. */
  group: z.string().optional(),
  status: z.enum(["running", "done", "failed", "cancelled"]),
  sessionId: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  costUsd: z.number(),
  /** What happened, in a sentence: the failing gates, the must-fix findings, an error. */
  note: z.string().optional(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

/** A gate the sidecar ran itself (M3-08): the real command, exit code and end of the log. */
export const GateRunSchema = z.object({
  kind: z.enum(GATE_KINDS),
  command: z.string(),
  /** The package it ran in; "." is the workspace root. */
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

export const TaskRunSchema = z.object({
  workflow: z.object({ id: z.string(), version: z.number().int() }),
  permissionMode: PermissionModeSchema,
  model: z.string().optional(),
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
  /** Why the run ended, in a sentence. */
  outcome: z.string().optional(),
});
export type TaskRun = z.infer<typeof TaskRunSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  /** What the user asked for, verbatim. */
  request: z.string(),
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
});
export type Task = z.infer<typeof TaskSchema>;

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
    result: z.object({ workspace: RulesSchema, team: RulesSchema }),
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
  "task.create": { params: WorkspaceRef.extend({ request: z.string().min(1).max(20_000) }), result: TaskSchema },
  /**
   * A read-only Claude session drafts the contract from the request and the repo, then triage runs on the draft
   * (signals and a haiku classification). Writes nothing but the task's own files. Costs model calls (`costUsd`).
   */
  "task.draft": { params: TaskRef.extend({ model: z.string().optional() }), result: TaskSchema },
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
      budgetUsd: z.number().positive().max(1000),
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
    params: TaskRef.extend({ permissionMode: PermissionModeSchema.exclude(["plan"]), model: z.string().optional() }),
    result: TaskSchema,
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
});
export type TaskTag = z.infer<typeof TaskTagSchema>;

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
