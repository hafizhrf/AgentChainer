import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceProfile } from "@agentchainer/protocol";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import type { Item } from "../catalog/schema.ts";
import { checkToolCall } from "../guard.ts";
import type { AgentSdkModule } from "../sdk-loader.ts";
import { repoOf } from "../workspace.ts";
import skills from "./skills.json" with { type: "json" };
import { ensureTool, findTool } from "./tools.ts";
import { guarded } from "./workspace-guard.ts";

/**
 * Agent-driven generators (M2-19…M2-26). A generator is a Claude session that can only read the workspace (Read,
 * Grep, Glob) and run the project's own test/lint/typecheck/build commands; it returns proposed files as structured
 * output and never writes anything (M2-20). Proposals are checked deterministically, retried with the failures as
 * feedback, and then reviewed as diffs in the bootstrap plan before anything is applied.
 */

export type Check = { name: string; status: "pass" | "fail" | "skipped"; detail: string };
export type ProposedFile = { path: string; before: string; after: string };
export type Proposal = {
  action: string;
  files: ProposedFile[];
  summary: string;
  checks: Check[];
  costUsd: number;
  attempts: number;
};

type Spec = {
  skill: string;
  task: string;
  /** Paths the generator may propose, relative and `/`-separated. */
  allow: RegExp[];
  /** The same, in words, for the prompt. */
  allowText: string;
  check: (root: string, files: ProposedFile[], profile: WorkspaceProfile, tools: CheckTools) => Check[];
};

/** Tools the checks may run: actionlint's path, or why there isn't one. */
export type CheckTools = { actionlint: { path: string | null; note?: string } };
const NO_TOOLS: CheckTools = { actionlint: { path: null, note: "actionlint isn't installed" } };

const CLAUDE_MD = /^(\.claude\/)?CLAUDE\.md$/;
const WORKFLOW = /^\.github\/workflows\/[\w.-]+\.ya?ml$/;

export const GENERATORS: Record<string, Spec> = {
  "generate-claude-md": {
    skill: "ac-write-claude-md",
    task: "Write a CLAUDE.md for this project.",
    allow: [CLAUDE_MD],
    allowText: "CLAUDE.md (or .claude/CLAUDE.md if that's where it lives)",
    check: checkClaudeMd,
  },
  "update-claude-md": {
    skill: "ac-write-claude-md",
    task: "Update the project's existing CLAUDE.md: keep what's still true, fix what's wrong, add what's missing.",
    allow: [CLAUDE_MD],
    allowText: "CLAUDE.md (or .claude/CLAUDE.md if that's where it lives)",
    check: checkClaudeMd,
  },
  "setup-hooks": {
    skill: "ac-setup-hooks",
    task: "Add format and lint hooks for the files Claude edits.",
    allow: [/^\.claude\/settings\.json$/, /^\.claude\/hooks\/[\w.-]+$/],
    allowText: ".claude/settings.json and scripts directly under .claude/hooks/",
    check: checkHooks,
  },
  "scaffold-tests": {
    skill: "ac-scaffold-tests",
    task: "Add a test setup: the stack's standard runner, one example test, and a test command.",
    allow: [
      /(^|\/)(test|tests|__tests__|spec)\/[\w./-]+$/,
      /(^|\/)[\w.-]+[._](test|spec)\.[cm]?[jt]sx?$/,
      /(^|\/)[\w-]+_test\.(go|py)$/,
      /(^|\/)test_[\w-]+\.py$/,
      /(^|\/)(package\.json|pyproject\.toml|pytest\.ini|conftest\.py|pubspec\.yaml)$/,
      /(^|\/)requirements[\w.-]*\.txt$/,
      /(^|\/)(vitest|jest)\.config\.[cm]?[jt]s$/,
    ],
    allowText:
      "test files (in test/, tests/, __tests__/ or named *.test.*, *_test.go, test_*.py), test runner configs, and the manifests package.json, pyproject.toml, pubspec.yaml or requirements*.txt",
    check: checkTests,
  },
  "generate-ci": {
    skill: "ac-generate-ci",
    task: "Generate a GitHub Actions CI workflow for this project.",
    allow: [WORKFLOW],
    allowText: "workflow files in .github/workflows/",
    check: (_root, files, _profile, tools) => checkWorkflows(files, tools.actionlint),
  },
  "smoke-test": {
    skill: "ac-smoke-test",
    task: "Add a smoke test script (and optionally a CI job) that proves the app still starts.",
    allow: [/^scripts\/smoke\.(sh|ps1|mjs|py)$/, /^\.github\/workflows\/smoke\.ya?ml$/],
    allowText: "scripts/smoke.sh (or .mjs, .py, .ps1) and .github/workflows/smoke.yml",
    check: (_root, files, _profile, tools) => [
      check(
        "smoke script",
        files.some((f) => f.path.startsWith("scripts/smoke.")),
        "proposes scripts/smoke.*",
      ),
      ...checkWorkflows(files, tools.actionlint),
    ],
  },
};

const check = (name: string, ok: boolean, detail: string): Check => ({ name, status: ok ? "pass" : "fail", detail });

/** Commands a generator session may run: the project's test, lint, typecheck and build commands, nothing else. */
export function allowedCommands(profile: WorkspaceProfile): string[] {
  const out = new Set<string>();
  for (const p of profile.packages) {
    for (const kind of ["test", "lint", "typecheck", "build"] as const) {
      const run = p.commands[kind]?.run;
      if (!run) continue;
      out.add(p.path === "." ? run : `cd ${p.path} && ${run}`);
      if (p.path === ".") out.add(run);
    }
  }
  return [...out];
}

/** The PreToolUse hook of a generator session: it sees every tool call, including ones the mode pre-approves. */
export function generatorHook(root: string, allowed: string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });
    const args = (input.tool_input ?? {}) as Record<string, unknown>;
    // The SDK delivers structured output through this tool; it's the generator's only way to answer.
    if (input.tool_name === "StructuredOutput") return {};
    const guard = checkToolCall(input.tool_name, input.tool_input, input.cwd);
    if (guard) return deny(`Blocked by AgentChainer guard: ${guard}`);
    if (input.tool_name === "Bash") {
      const command = String(args.command ?? "").trim();
      if (allowed.includes(command)) return {};
      return deny(
        `Generators can only run the project's own commands: ${allowed.map((c) => `\`${c}\``).join(", ") || "(none detected)"}.`,
      );
    }
    if (["Read", "Grep", "Glob"].includes(input.tool_name)) {
      const target = args.file_path ?? args.path;
      if (typeof target === "string" && target) {
        const resolved = path.resolve(root, target);
        if (path.relative(root, resolved).startsWith(".."))
          return deny("Generators can only read inside the workspace.");
      }
      return {};
    }
    return deny(`Generators can only read files and run the project's commands, not ${input.tool_name}.`);
  };
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    summary: { type: "string", description: "What you propose and why, and which commands you ran (with exit codes)." },
  },
  required: ["files", "summary"],
  additionalProperties: false,
};

const MAX_FILES = 10;
const MAX_FILE_BYTES = 200_000;

/** Validates the structured output: shape, sizes, and that every path is one this generator may write. */
export function toProposedFiles(root: string, spec: Spec, output: unknown): ProposedFile[] {
  const files = (output as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error("The generator proposed no files.");
  if (files.length > MAX_FILES) throw new Error(`The generator proposed ${files.length} files; at most ${MAX_FILES}.`);
  return files.map((f: { path?: unknown; content?: unknown }) => {
    // Models sometimes answer with absolute paths; inside the workspace those are fine as relative ones.
    const raw = String(f.path ?? "");
    const rel = (path.isAbsolute(raw) ? path.relative(root, raw) : raw).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!rel || rel.split("/").includes("..") || path.isAbsolute(rel) || !spec.allow.some((re) => re.test(rel))) {
      throw new Error(`The generator proposed a path it may not write: ${rel || "(empty)"}`);
    }
    const after = String(f.content ?? "");
    if (Buffer.byteLength(after) > MAX_FILE_BYTES) throw new Error(`${rel} is larger than ${MAX_FILE_BYTES} bytes.`);
    const file = path.join(root, ...rel.split("/"));
    return { path: rel, before: existsSync(file) ? readFileSync(file, "utf8") : "", after };
  });
}

export type GenerateOptions = {
  model?: string;
  maxBudgetUsd?: number;
  /** Total attempts, the first included: failed checks go back to Claude as feedback. */
  maxAttempts?: number;
  /** Tools for the deterministic checks; without them, checks that need one are skipped. */
  tools?: CheckTools;
};

export async function generate(
  sdk: AgentSdkModule,
  claudePath: string,
  root: string,
  action: string,
  profile: WorkspaceProfile,
  opts: GenerateOptions = {},
): Promise<Proposal> {
  const spec = GENERATORS[action];
  if (!spec) throw new Error(`No generator for ${action}.`);
  const skill = (skills as Record<string, string>)[spec.skill];
  if (!skill) throw new Error(`Skill ${spec.skill} is missing from this build.`);
  // Commands can have side effects; outside git the guard can't undo them, so no commands there.
  const allowed = repoOf(root) ? allowedCommands(profile) : [];
  const { result, reverted } = await guarded(root, () =>
    attempts(sdk, claudePath, root, action, spec, skill, profile, allowed, opts),
  );
  return {
    ...result,
    checks: [
      ...result.checks,
      {
        name: "workspace untouched",
        status: "pass",
        detail: reverted.length
          ? `commands changed ${reverted.join(", ")}; reverted`
          : "the session's commands changed no files",
      },
    ],
  };
}

async function attempts(
  sdk: AgentSdkModule,
  claudePath: string,
  root: string,
  action: string,
  spec: Spec,
  skill: string,
  profile: WorkspaceProfile,
  allowed: string[],
  opts: GenerateOptions,
): Promise<Proposal> {
  const maxAttempts = opts.maxAttempts ?? 2;
  let feedback = "";
  let costUsd = 0;
  for (let attempt = 1; ; attempt++) {
    const prompt = [
      spec.task,
      "",
      "Workspace profile (detected by AgentChainer):",
      JSON.stringify(profile, null, 2),
      "",
      `You may run only these commands: ${allowed.join(" | ") || "none"}.`,
      `You may propose only these paths: ${spec.allowText}.`,
      "Return every file you propose with its complete content. Don't write files yourself; you can't.",
      feedback ? `\nYour previous proposal failed these checks. Fix them:\n${feedback}` : "",
    ].join("\n");
    const q = sdk.query({
      prompt,
      options: {
        cwd: root,
        pathToClaudeCodeExecutable: claudePath,
        ...(opts.model ? { model: opts.model } : {}),
        tools: ["Read", "Grep", "Glob", "Bash"],
        // Isolated from the user's and the project's settings: no hooks, plugins or MCP servers run in a generator.
        settingSources: [],
        persistSession: false,
        maxTurns: 40,
        maxBudgetUsd: opts.maxBudgetUsd ?? 1,
        systemPrompt: { type: "preset", preset: "claude_code", append: skill },
        outputFormat: { type: "json_schema", schema: OUTPUT_SCHEMA },
        hooks: { PreToolUse: [{ hooks: [generatorHook(root, allowed)] }] },
        // The hook above already decided; anything that reaches here is allowed.
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
      },
    });
    let output: unknown = null;
    let summary = "";
    for await (const m of q) {
      if (m.type !== "result") continue;
      costUsd += m.total_cost_usd;
      if (m.subtype !== "success") throw new Error(`The generator stopped: ${m.subtype}.`);
      output = m.structured_output;
      summary = String((output as { summary?: unknown })?.summary ?? m.result ?? "");
    }
    let files: ProposedFile[];
    try {
      files = toProposedFiles(root, spec, output);
    } catch (err) {
      // A proposal outside the generator's paths is a fixable mistake: say so and try again.
      if (attempt >= maxAttempts) throw err;
      feedback = `- ${err instanceof Error ? err.message : String(err)}. You may propose only: ${spec.allowText}.`;
      continue;
    }
    const checks = spec.check(root, files, profile, opts.tools ?? NO_TOOLS);
    const failed = checks.filter((c) => c.status === "fail");
    if (failed.length === 0 || attempt >= maxAttempts) {
      return { action, files, summary, checks, costUsd, attempts: attempt };
    }
    feedback = failed.map((c) => `- ${c.name}: ${c.detail}`).join("\n");
  }
}

/* ---------- Deterministic checks ---------- */

function firstCommand(profile: WorkspaceProfile, kind: "test" | "lint"): string | undefined {
  return profile.packages.map((p) => p.commands[kind]?.run).find(Boolean);
}

function checkClaudeMd(root: string, files: ProposedFile[], profile: WorkspaceProfile): Check[] {
  const md = files.find((f) => CLAUDE_MD.test(f.path))?.after ?? "";
  const lines = md.split("\n").length;
  const test = firstCommand(profile, "test");
  const agents = existsSync(path.join(root, "AGENTS.md"));
  return [
    check("length", lines <= 300 && md.trim().length > 0, `${lines} lines (at most 300)`),
    ...(test ? [check("test command", md.includes(test), `mentions \`${test}\``)] : []),
    ...(agents ? [check("AGENTS.md import", /^@AGENTS\.md\s*$/m.test(md), "imports AGENTS.md with @AGENTS.md")] : []),
    check("no personal paths", !/(\/Users\/|\/home\/|[A-Z]:\\Users\\)\w/.test(md), "no home-folder paths"),
  ];
}

function checkHooks(root: string, files: ProposedFile[]): Check[] {
  const settingsFile = files.find((f) => f.path === ".claude/settings.json");
  if (!settingsFile) return [check("settings.json", false, "proposes .claude/settings.json")];
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(settingsFile.after) as Record<string, unknown>;
  } catch (err) {
    return [check("valid JSON", false, String(err))];
  }
  let before: Record<string, unknown> = {};
  try {
    before = settingsFile.before ? (JSON.parse(settingsFile.before) as Record<string, unknown>) : {};
  } catch {
    // an unreadable file can't lose keys
  }
  const lost = Object.keys(before).filter((k) => !(k in settings));
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const scripts = [...settingsFile.after.matchAll(/\.claude\/hooks\/([\w.-]+)/g)].map((m) => `.claude/hooks/${m[1]}`);
  const missing = scripts.filter(
    (s) => !files.some((f) => f.path === s) && !existsSync(path.join(root, ...s.split("/"))),
  );
  return [
    check("valid JSON", true, ".claude/settings.json parses"),
    check(
      "keeps existing settings",
      lost.length === 0,
      lost.length ? `drops ${lost.join(", ")}` : "every existing key kept",
    ),
    check(
      "PostToolUse hook",
      Array.isArray(hooks.PostToolUse) && hooks.PostToolUse.length > 0,
      "adds a PostToolUse hook",
    ),
    check(
      "hook scripts exist",
      missing.length === 0,
      missing.length ? `missing ${missing.join(", ")}` : "every referenced script is there",
    ),
  ];
}

function checkTests(_root: string, files: ProposedFile[]): Check[] {
  const manifests = files.filter((f) => f.path.endsWith("package.json"));
  const badJson = manifests.filter((f) => {
    try {
      JSON.parse(f.after);
      return false;
    } catch {
      return true;
    }
  });
  const lostKeys = manifests.flatMap((f) => {
    try {
      const before = f.before ? (JSON.parse(f.before) as object) : {};
      const after = JSON.parse(f.after) as object;
      return Object.keys(before)
        .filter((k) => !(k in after))
        .map((k) => `${f.path}#${k}`);
    } catch {
      return [];
    }
  });
  const tests = files.filter(
    (f) => /(test|spec)/i.test(path.basename(f.path)) || /(^|\/)(test|tests|__tests__)\//.test(f.path),
  );
  return [
    check(
      "example test",
      tests.length > 0,
      tests.length ? tests.map((t) => t.path).join(", ") : "proposes at least one test file",
    ),
    check(
      "manifests valid",
      badJson.length === 0,
      badJson.length ? `invalid JSON: ${badJson.map((f) => f.path).join(", ")}` : "manifests parse",
    ),
    check(
      "manifests keep fields",
      lostKeys.length === 0,
      lostKeys.length ? `drops ${lostKeys.join(", ")}` : "no field dropped",
    ),
  ];
}

/** YAML parses, least-privilege permissions, every action pinned to a SHA, and actionlint when it's available. */
export function checkWorkflows(
  files: ProposedFile[],
  actionlint: CheckTools["actionlint"] = NO_TOOLS.actionlint,
): Check[] {
  const checks: Check[] = [];
  for (const f of files.filter((x) => WORKFLOW.test(x.path))) {
    let doc: Record<string, unknown> | null = null;
    try {
      doc = parseYaml(f.after) as Record<string, unknown>;
    } catch (err) {
      checks.push(check(`${f.path}: YAML`, false, String(err).split("\n")[0] ?? ""));
      continue;
    }
    checks.push(
      check(`${f.path}: permissions`, Boolean(doc && "permissions" in doc), "declares top-level `permissions:`"),
    );
    const unpinned = [...f.after.matchAll(/uses:\s*([^\s#]+)/g)]
      .map((m) => m[1] ?? "")
      .filter((u) => !u.startsWith("./") && !/@[0-9a-f]{40}$/.test(u));
    checks.push(
      check(
        `${f.path}: pinned actions`,
        unpinned.length === 0,
        unpinned.length ? `not pinned to a SHA: ${unpinned.join(", ")}` : "every action pinned to a commit SHA",
      ),
    );
    checks.push(runActionlint(f, actionlint));
  }
  return checks;
}

function runActionlint(f: ProposedFile, tool: CheckTools["actionlint"]): Check {
  if (!tool.path)
    return { name: `${f.path}: actionlint`, status: "skipped", detail: tool.note ?? "actionlint isn't installed" };
  const dir = mkdtempSync(path.join(tmpdir(), "ac-actionlint-"));
  try {
    const file = path.join(dir, path.basename(f.path));
    writeFileSync(file, f.after);
    // Run from the temp folder, so findings name the file (ci.yml:8:23), not the temp path.
    const r = spawnSync(tool.path, ["-no-color", path.basename(file)], { cwd: dir, encoding: "utf8" });
    return check(
      `${f.path}: actionlint`,
      r.status === 0,
      r.status === 0 ? "clean" : (r.stdout || r.stderr).trim().slice(0, 500),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * actionlint for the workflow checks (M2-24): a copy that's already there, else the catalog's pinned release,
 * downloaded and hash-checked on demand like the Agent SDK. It's AgentChainer's own checking tool, not something
 * installed into the project.
 */
export async function resolveActionlint(
  item: Item | undefined,
  dir: string | null,
  fetchImpl?: typeof fetch,
): Promise<CheckTools["actionlint"]> {
  const found = findTool("actionlint", dir);
  if (found) return { path: found };
  if (!item || !dir) return { path: null, note: "actionlint isn't installed" };
  try {
    return { path: (await ensureTool(item, { dir, ...(fetchImpl ? { fetchImpl } : {}) })).path };
  } catch (err) {
    return { path: null, note: `couldn't get actionlint: ${err instanceof Error ? err.message : String(err)}` };
  }
}
